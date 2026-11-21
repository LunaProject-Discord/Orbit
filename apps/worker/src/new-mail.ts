import {
  CHANNEL_NEW_MAIL,
  type NewMailCandidate,
  type NewMailNotification,
  toNewMailNotification,
  toPushMessages,
  type WebPushConfig,
} from "@mail/core";
import { type Database, pushSubscriptions } from "@mail/db";
import { eq, sql } from "drizzle-orm";
import { sendNotification, WebPushError } from "web-push";
import type { Tx } from "./changes.js";
import type { SyncAccount } from "./mailbox-store.js";

/**
 * 受信トレイに届いた新しいメールを知らせる。取り込みと同じトランザクションで呼ぶ
 * (NOTIFY はコミット時に届くので、通知を受けた側からメールが必ず見える)。
 * API サーバーが SSE で開いている画面へ、PushSender が Web Push で端末へ伝える。
 */
export async function announceNewMail(
  tx: Tx,
  account: SyncAccount,
  candidates: NewMailCandidate[],
) {
  const notification = toNewMailNotification(account, candidates);
  if (!notification) return;
  await tx.execute(
    sql`select pg_notify(${CHANNEL_NEW_MAIL}, ${JSON.stringify(notification)})`,
  );
}

export function parseNewMailNotification(
  payload: string | undefined,
): NewMailNotification | null {
  try {
    const value = JSON.parse(payload ?? "") as NewMailNotification;
    return typeof value?.userId === "string" &&
      typeof value.accountId === "string" &&
      Array.isArray(value.messages) &&
      typeof value.count === "number"
      ? value
      : null;
  } catch {
    return null;
  }
}

type Subscription = { endpoint: string; p256dh: string; auth: string };

/** 通知 1 件を送る。送り先が無効になっていたら statusCode 付きの例外を投げる。 */
export type PushTransport = (
  subscription: Subscription,
  body: string,
) => Promise<void>;

/** 届けられなかった通知をプッシュサービスが預かる時間 (端末がオフラインのとき)。 */
const TTL_SECONDS = 24 * 60 * 60;

export function webPushTransport(config: WebPushConfig): PushTransport {
  return async (subscription, body) => {
    await sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      body,
      {
        TTL: TTL_SECONDS,
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
      },
    );
  };
}

function statusOf(error: unknown): number | null {
  if (error instanceof WebPushError) return error.statusCode;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : null;
}

/** 新着メールを、利用者が通知を有効にした端末へ Web Push で送る。 */
export class PushSender {
  constructor(
    private readonly db: Database,
    private readonly transport: PushTransport,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  async deliver(notification: NewMailNotification): Promise<void> {
    const subscriptions = await this.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, notification.userId));
    if (subscriptions.length === 0) return;
    const bodies = toPushMessages(notification).map((message) =>
      JSON.stringify(message),
    );
    await Promise.all(
      subscriptions.map(async (subscription) => {
        for (const body of bodies) {
          try {
            await this.transport(subscription, body);
          } catch (error) {
            const status = statusOf(error);
            if (status === 404 || status === 410) {
              // 端末側で通知が無効にされた、または期限が切れた。送り先を消す。
              await this.db
                .delete(pushSubscriptions)
                .where(eq(pushSubscriptions.id, subscription.id));
            } else {
              this.log(
                `新着メールの通知を送れませんでした (${status ?? "接続エラー"}): ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            // 同じ送り先への残りは送らない。
            return;
          }
        }
      }),
    );
  }
}
