import {
  CHANNEL_ACCOUNTS,
  CHANNEL_FOCUS,
  CHANNEL_GRAPH_PUSH,
  CHANNEL_NEW_MAIL,
  CHANNEL_OUTBOX,
  type FocusNotification,
  type GraphPushNotification,
  type MicrosoftOAuthConfig,
} from "@mail/core";
import { type Database, mailAccounts } from "@mail/db";
import { inArray } from "drizzle-orm";
import pg from "pg";
import { AccountSync } from "./account-sync.js";
import { GraphAccountSync } from "./graph-account-sync.js";
import { type PushSender, parseNewMailNotification } from "./new-mail.js";
import { accountsWithPendingOutbox } from "./outbox.js";

const RECONCILE_MS = 60_000;

function parsePayload<T extends { accountId: string }>(
  payload: string | undefined,
): T | null {
  try {
    const value = JSON.parse(payload ?? "") as T;
    return typeof value?.accountId === "string" ? value : null;
  } catch {
    return null;
  }
}

/** 接続に関わる設定をまとめた値。これが変わったら接続し直す。 */
function connectionKey(row: typeof mailAccounts.$inferSelect) {
  return [
    row.protocol,
    row.imapHost,
    row.imapPort,
    row.imapSecure,
    row.smtpHost,
    row.smtpPort,
    row.smtpSecure,
    row.username,
    row.credentialsEncrypted,
  ].join("\n");
}

/**
 * 同期対象のアカウントごとに AccountSync を起動・停止する。
 * API サーバーからの NOTIFY (アカウントの追加・削除) ですぐに反映し、
 * 取りこぼしに備えて定期的にも DB と突き合わせる。
 * 送信待ちキューに操作が積まれた通知、利用者が開いているフォルダの通知、
 * Microsoft Graph の変更通知も受け取り、該当のアカウントへ伝える。
 * 新着メールの知らせは、Web Push で端末へ送る。
 */
export class AccountManager {
  private running = new Map<string, { sync: AccountSync | GraphAccountSync }>();
  private listener: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reconciling: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly connectionString: string,
    private readonly encryptionKey: Buffer,
    /** Microsoft Graph のアカウント用。未設定ならそれらのアカウントはエラーになる。 */
    private readonly microsoft: MicrosoftOAuthConfig | null,
    /** Microsoft Graph の変更通知 (Webhook) の受け口。公開された HTTPS の URL が無ければ null。 */
    private readonly graphWebhookBaseUrl: string | null = null,
    /** 暗号化されていない SMTP 接続を許す (開発用のローカルサーバー向け)。 */
    private readonly allowInsecureSmtp = false,
    /** 新着メールを Web Push で端末へ送る。Web Push を設定していなければ null。 */
    private readonly pushSender: PushSender | null = null,
  ) {}

  async start() {
    await this.reconcile();
    this.timer = setInterval(() => this.reconcile(), RECONCILE_MS);
    this.listen();
  }

  get count() {
    return this.running.size;
  }

  private listen() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    const retry = () => {
      if (this.listener !== client) return;
      this.listener = null;
      client.end().catch(() => {});
      setTimeout(() => this.listen(), 3_000);
    };
    this.listener = client;
    client.on("notification", (message) => {
      if (message.channel === CHANNEL_OUTBOX) {
        // payload はアカウントの ID。同期中でなければ、再開したときに反映される。
        if (message.payload) {
          this.running.get(message.payload)?.sync.notifyOutbox();
        }
        return;
      }
      if (message.channel === CHANNEL_FOCUS) {
        const payload = parsePayload<FocusNotification>(message.payload);
        if (payload) {
          this.running
            .get(payload.accountId)
            ?.sync.notifyFocus(payload.mailboxId ?? null);
        }
        return;
      }
      if (message.channel === CHANNEL_NEW_MAIL) {
        const payload = parseNewMailNotification(message.payload);
        if (payload) {
          this.pushSender?.deliver(payload).catch((error) => {
            console.error("新着メールの通知を送れませんでした。", error);
          });
        }
        return;
      }
      if (message.channel === CHANNEL_GRAPH_PUSH) {
        const payload = parsePayload<GraphPushNotification>(message.payload);
        const sync = payload && this.running.get(payload.accountId)?.sync;
        if (sync instanceof GraphAccountSync) {
          sync.notifyPush(payload?.lifecycle ?? null);
        }
        return;
      }
      this.reconcile();
    });
    client.on("error", retry);
    client.on("end", retry);
    client
      .connect()
      .then(() => client.query(`LISTEN ${CHANNEL_ACCOUNTS}`))
      .then(() => client.query(`LISTEN ${CHANNEL_OUTBOX}`))
      .then(() => client.query(`LISTEN ${CHANNEL_FOCUS}`))
      .then(() => client.query(`LISTEN ${CHANNEL_GRAPH_PUSH}`))
      .then(() =>
        this.pushSender ? client.query(`LISTEN ${CHANNEL_NEW_MAIL}`) : null,
      )
      // 待ち受けを始めるまでの間に届いた通知は失われるので、ここで追いつく。
      .then(() => this.reconcile())
      .catch(retry);
  }

  /** DB の状態に合わせて起動・停止する。同時には 1 回だけ走らせる。 */
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling
      .then(() => this.reconcileOnce())
      .catch((error) => {
        console.error("アカウント一覧の確認に失敗しました。", error);
      });
    return this.reconciling;
  }

  private async reconcileOnce() {
    if (this.stopped) return;
    // auth_required は認証情報が更新されるまで再接続しない。
    const rows = await this.db
      .select()
      .from(mailAccounts)
      .where(inArray(mailAccounts.status, ["active", "error"]));
    const wanted = new Map(rows.map((row) => [row.id, row]));

    for (const [id, entry] of this.running) {
      const row = wanted.get(id);
      // 削除されたものと、接続設定が変わったものは止める (後者は下で起動し直す)。
      // 比較相手は同期側が持つ行。リフレッシュトークンの更新で認証情報が変わっても、
      // 同期側が自分の行を差し替えているので、接続し直しにはならない。
      if (!row || connectionKey(row) !== connectionKey(entry.sync.account)) {
        entry.sync.stop();
        this.running.delete(id);
      }
    }
    for (const row of rows) {
      if (this.running.has(row.id)) continue;
      const sync =
        row.protocol === "graph"
          ? new GraphAccountSync(
              this.db,
              this.encryptionKey,
              row,
              this.microsoft,
              this.graphWebhookBaseUrl,
            )
          : new AccountSync(
              this.db,
              this.encryptionKey,
              row,
              this.allowInsecureSmtp,
            );
      const entry = { sync };
      this.running.set(row.id, entry);
      sync.run().finally(() => {
        if (this.running.get(row.id) === entry) this.running.delete(row.id);
      });
    }
    // 通知を取りこぼしていても、反映待ちの操作が残っていれば処理させる。
    for (const accountId of await accountsWithPendingOutbox(this.db)) {
      this.running.get(accountId)?.sync.notifyOutbox();
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => {});
    for (const { sync } of this.running.values()) sync.stop();
    this.running.clear();
  }
}
