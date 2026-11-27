import {
  type CalendarPushMessage,
  calendarPushTtlSeconds,
  type FcmConfig,
  FcmError,
  type ReminderCover,
  signServiceAccountJwt,
  toCalendarFcmData,
  type WebPushConfig,
} from "@orbit/core";
import { type Database, devices, pushSubscriptions } from "@orbit/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { sendNotification, WebPushError } from "web-push";

/**
 * 予定の通知 (段取り 9) を端末へ送る。Web Push は notifyCalendar の購読、FCM は notifyCalendar の
 * Android の端末だけに送る (古いサービスワーカー・アプリは予定の通知を正しく出せないため)。
 * 預かり時間 (TTL) は通知ごとに変える (リマインダーは予定の終了まで)。メールの送信
 * (new-mail.ts の PushSender / DevicePushSender) は 24 時間固定なので、送り方を別に持つ。
 * 送信には 15 秒の上限を付け、一時的な失敗 (429、5xx、接続の失敗・時間切れ) は数秒あけて
 * RETRY_DELAYS_MS の回数だけ送り直す (レビュー M5、M6)。
 */

/** 1 件の送信の上限。 */
export const CALENDAR_PUSH_TIMEOUT_MS = 15_000;
/** 一時的な失敗のあとに送り直すまでの間 (この数だけ送り直す)。 */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

type Subscription = { endpoint: string; p256dh: string; auth: string };

/** Web Push で 1 件送る。送り先が無効なら statusCode 付きの例外を投げる。 */
export type CalendarWebPushTransport = (
  subscription: Subscription,
  body: string,
  ttlSeconds: number,
) => Promise<void>;

/** FCM で 1 件送る (data だけ)。断られたら FcmError を投げる。 */
export type CalendarFcmTransport = (
  token: string,
  data: Record<string, string>,
  ttlSeconds: number,
) => Promise<void>;

export function calendarWebPushTransport(
  config: WebPushConfig,
): CalendarWebPushTransport {
  return async (subscription, body, ttlSeconds) => {
    await sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      body,
      {
        TTL: ttlSeconds,
        // web-push は timeout が無いとソケットに上限を付けない (応答しない送り先で止まる)。
        timeout: CALENDAR_PUSH_TIMEOUT_MS,
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
      },
    );
  };
}

function fcmErrorCode(body: unknown): string | null {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return null;
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    const code = (detail as { errorCode?: unknown } | null)?.errorCode;
    if (typeof code === "string") return code;
  }
  return typeof error.status === "string" ? error.status : null;
}

/**
 * FCM の HTTP v1 で data だけを送る。@orbit/core の FcmClient.send はメールの PushMessage の形
 * (toFcmMessage) に固定で TTL も 24 時間なので、アクセストークンの扱いだけ同じにして別に持つ。
 */
export function calendarFcmTransport(
  config: FcmConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): CalendarFcmTransport {
  let token: { value: string; expiresAt: number } | null = null;
  const accessToken = async () => {
    const at = now();
    if (token && token.expiresAt - 60_000 > at) return token.value;
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(config, at),
      }),
      signal: AbortSignal.timeout(CALENDAR_PUSH_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!response.ok || typeof body?.access_token !== "string") {
      throw new FcmError(
        response.status,
        null,
        `FCM のアクセストークンを取得できませんでした: HTTP ${response.status}`,
      );
    }
    const lifetime =
      typeof body.expires_in === "number" ? body.expires_in : 3600;
    token = { value: body.access_token, expiresAt: at + lifetime * 1000 };
    return token.value;
  };
  return async (deviceToken, data, ttlSeconds) => {
    const bearer = await accessToken();
    const response = await fetcher(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            data,
            android: { ttl: `${ttlSeconds}s`, priority: "HIGH" },
          },
        }),
        signal: AbortSignal.timeout(CALENDAR_PUSH_TIMEOUT_MS),
      },
    );
    if (response.ok) return;
    if (response.status === 401) token = null;
    const body: unknown = await response.json().catch(() => null);
    const detail = (body as { error?: { message?: unknown } } | null)?.error
      ?.message;
    throw new FcmError(
      response.status,
      fcmErrorCode(body),
      typeof detail === "string" ? detail : `HTTP ${response.status}`,
    );
  };
}

function statusOf(error: unknown): number | null {
  if (error instanceof WebPushError) return error.statusCode;
  if (error instanceof FcmError) return error.status;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : null;
}

/** 送り直してよい失敗か (429、5xx、HTTP の応答の無い失敗 = 接続の失敗・時間切れ)。 */
function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  return status === null || status === 429 || status >= 500;
}

/** 送る 1 件と、その通知を省いてよい端末の判定 (リマインダーの端末予約。設計 3.3)。 */
export type CalendarDelivery = {
  message: CalendarPushMessage;
  /** true を返した Android の端末には送らない。 */
  skipDevice?: (cover: ReminderCover) => boolean;
};

export type CalendarPushResult = { webPush: number; fcm: number };

/** 予定の通知を、利用者の notifyCalendar の送り先へ送る。 */
export class CalendarPushSender {
  constructor(
    private readonly db: Database,
    private readonly transports: {
      webPush?: CalendarWebPushTransport | null;
      fcm?: CalendarFcmTransport | null;
    },
    private readonly log: (message: string) => void = console.warn,
    private readonly now: () => number = Date.now,
    private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {}

  /**
   * 1 件を送る。一時的な失敗は retryDelaysMs の回数だけ送り直す。送れたら "sent"、
   * 送り先が無効なら "gone"、それ以外の失敗は "failed" (ログに出す)。
   */
  private async attempt(
    send: () => Promise<void>,
    gone: (error: unknown) => boolean,
    label: string,
  ): Promise<"sent" | "gone" | "failed"> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await send();
        return "sent";
      } catch (error) {
        if (gone(error)) return "gone";
        const delay = this.retryDelaysMs[attempt];
        if (isTransient(error) && delay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        this.log(
          `${label} (${statusOf(error) ?? "接続エラー"}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return "failed";
      }
    }
  }

  get enabled(): boolean {
    return !!(this.transports.webPush || this.transports.fcm);
  }

  async deliver(
    userId: string,
    deliveries: readonly CalendarDelivery[],
    now: number = this.now(),
  ): Promise<CalendarPushResult> {
    const result: CalendarPushResult = { webPush: 0, fcm: 0 };
    if (deliveries.length === 0) return result;
    const tasks: Promise<void>[] = [];
    const web = this.transports.webPush;
    if (web) {
      const subscriptions = await this.db
        .select({
          id: pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
        })
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, userId),
            eq(pushSubscriptions.notifyCalendar, true),
          ),
        );
      const gone: string[] = [];
      for (const subscription of subscriptions) {
        tasks.push(
          (async () => {
            for (const { message } of deliveries) {
              const outcome = await this.attempt(
                () =>
                  web(
                    subscription,
                    JSON.stringify(message),
                    calendarPushTtlSeconds(message, now),
                  ),
                (error) => {
                  const status = statusOf(error);
                  return status === 404 || status === 410;
                },
                "予定の通知を送れませんでした",
              );
              if (outcome === "sent") result.webPush += 1;
              if (outcome === "gone") {
                gone.push(subscription.id);
                return;
              }
              // 失敗しても、この送り先への残りの通知は送る。
            }
          })(),
        );
      }
      await Promise.all(tasks.splice(0));
      if (gone.length > 0) {
        await this.db
          .delete(pushSubscriptions)
          .where(inArray(pushSubscriptions.id, gone));
      }
    }
    const fcm = this.transports.fcm;
    if (fcm) {
      const targets = await this.db
        .select({
          id: devices.id,
          pushToken: devices.pushToken,
          coverUntil: devices.reminderCoverUntil,
          coverSeq: devices.reminderCoverSeq,
          exact: devices.exactAlarms,
        })
        .from(devices)
        .where(
          and(
            eq(devices.userId, userId),
            eq(devices.platform, "android"),
            eq(devices.notifyCalendar, true),
            isNotNull(devices.pushToken),
          ),
        );
      const gone: string[] = [];
      for (const target of targets) {
        const token = target.pushToken;
        if (!token) continue;
        const cover: ReminderCover = {
          coverUntil: target.coverUntil,
          coverSeq: target.coverSeq,
          exact: target.exact,
        };
        tasks.push(
          (async () => {
            for (const { message, skipDevice } of deliveries) {
              if (skipDevice?.(cover)) continue;
              const outcome = await this.attempt(
                () =>
                  fcm(
                    token,
                    toCalendarFcmData(message),
                    calendarPushTtlSeconds(message, now),
                  ),
                (error) => error instanceof FcmError && error.tokenGone,
                "予定の通知をスマホアプリへ送れませんでした",
              );
              if (outcome === "sent") result.fcm += 1;
              if (outcome === "gone") {
                gone.push(target.id);
                return;
              }
            }
          })(),
        );
      }
      await Promise.all(tasks.splice(0));
      if (gone.length > 0) {
        await this.db.delete(devices).where(inArray(devices.id, gone));
      }
    }
    return result;
  }
}
