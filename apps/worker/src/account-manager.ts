import { CHANNEL_ACCOUNTS, type MicrosoftOAuthConfig } from "@mail/core";
import { type Database, mailAccounts } from "@mail/db";
import { inArray } from "drizzle-orm";
import pg from "pg";
import { AccountSync } from "./account-sync.js";
import { GraphAccountSync } from "./graph-account-sync.js";

const RECONCILE_MS = 60_000;

/** 接続に関わる設定をまとめた値。これが変わったら接続し直す。 */
function connectionKey(row: typeof mailAccounts.$inferSelect) {
  return [
    row.protocol,
    row.imapHost,
    row.imapPort,
    row.imapSecure,
    row.username,
    row.credentialsEncrypted,
  ].join("\n");
}

/**
 * 同期対象のアカウントごとに AccountSync を起動・停止する。
 * API サーバーからの NOTIFY (アカウントの追加・削除) ですぐに反映し、
 * 取りこぼしに備えて定期的にも DB と突き合わせる。
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
    client.on("notification", () => this.reconcile());
    client.on("error", retry);
    client.on("end", retry);
    client
      .connect()
      .then(() => client.query(`LISTEN ${CHANNEL_ACCOUNTS}`))
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
            )
          : new AccountSync(this.db, this.encryptionKey, row);
      const entry = { sync };
      this.running.set(row.id, entry);
      sync.run().finally(() => {
        if (this.running.get(row.id) === entry) this.running.delete(row.id);
      });
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
