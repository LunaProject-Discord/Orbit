import {
  type CalendarSyncNotification,
  type CalendarSyncReason,
  CHANNEL_ACCOUNTS,
  CHANNEL_CALENDAR_SYNC,
  type GoogleOAuthConfig,
  type MicrosoftOAuthConfig,
} from "@orbit/core";
import { accounts, type Database } from "@orbit/db";
import { and, eq, inArray } from "drizzle-orm";
import pg from "pg";
import { recordChanges } from "../changes.js";
import { accountsWithPendingOutbox } from "../outbox.js";
import {
  AccountCalendarSync,
  type AccountCalendarSyncOptions,
} from "./account-calendar-sync.js";
import type {
  AccountRow,
  CalendarProvider,
  CalendarProviderDeps,
} from "./provider.js";
import { calendarProviderFor } from "./registry.js";

const RECONCILE_MS = 60_000;

/** CHANNEL_CALENDAR_SYNC で受け付ける理由。 */
const SYNC_REASONS: readonly CalendarSyncReason[] = [
  "outbox",
  "push",
  "refresh",
  "focus",
];

/** プロバイダが無いアカウントに書く calendarError。 */
export const UNSUPPORTED_CALENDAR_ERROR =
  "このアカウントのカレンダーの同期には対応していません。";

/**
 * カレンダーの接続に関わる設定をまとめた値。これが変わったら同期を作り直す。
 * Microsoft (Graph) は credentialsEncrypted を含めない。メールの同期がリフレッシュトークンを
 * 入れ替えるたびに変わるが、カレンダーのトークン (MicrosoftCalendarTokens) は毎回 DB の
 * 最新を読むので、作り直す必要が無い (作り直すと、実行中の書き戻しを中断してしまう)。
 */
export function calendarConnectionKey(row: AccountRow) {
  return [
    row.provider,
    row.authType,
    row.protocol,
    row.username,
    row.caldavUrl,
    row.protocol === "graph" ? "" : row.credentialsEncrypted,
    row.oauthScopes,
  ].join("\n");
}

/**
 * 認証の失敗などで止めた同期を、起動し直してよいかを決める値。ログインし直しで
 * 認証情報が変われば起動し直すため、Microsoft でも credentialsEncrypted を含める。
 */
export function calendarParkKey(row: AccountRow) {
  return `${calendarConnectionKey(row)}\n${row.credentialsEncrypted}`;
}

export type CalendarSyncManagerOptions = {
  encryptionKey: Buffer;
  google: GoogleOAuthConfig | null;
  microsoft: MicrosoftOAuthConfig | null;
  /** Webhook の受け口の土台の URL。公開された HTTPS が無ければ null。 */
  webhookBaseUrl: string | null;
  allowPrivateHosts: boolean;
  fetchFn?: typeof fetch;
  /** プロバイダの選び方を差し替える (テスト用)。既定は calendarProviderFor。 */
  providerFor?: (
    account: AccountRow,
    deps: CalendarProviderDeps,
  ) => CalendarProvider | null;
  /** 認証の作り方を差し替える (テスト用)。 */
  createAuth?: AccountCalendarSyncOptions["createAuth"];
  log?: (message: string) => void;
};

function parseNotification(
  payload: string | undefined,
): CalendarSyncNotification | null {
  try {
    const value = JSON.parse(payload ?? "") as CalendarSyncNotification;
    if (typeof value?.accountId !== "string") return null;
    if (!SYNC_REASONS.includes(value.reason)) return null;
    if (value.calendarId !== undefined && typeof value.calendarId !== "string")
      return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * カレンダーを使うアカウント (calendarEnabled=true、status が active か error) ごとに
 * AccountCalendarSync を起動・停止する。メールの同期 (AccountManager) とは別に動き、
 * メールを使わないアカウントも扱う。
 * API サーバーからの NOTIFY (アカウントの変更、カレンダーの同期の依頼) ですぐに反映し、
 * 取りこぼしに備えて定期的にも DB と突き合わせる。
 */
export class CalendarSyncManager {
  private running = new Map<string, { sync: AccountCalendarSync }>();
  /** 認証の失敗などで止めたアカウントと、止めた時点の接続の設定。変わるまで起動しない。 */
  private parked = new Map<string, string>();
  private listener: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reconciling: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly connectionString: string,
    private readonly options: CalendarSyncManagerOptions,
  ) {}

  async start() {
    await this.reconcile();
    this.timer = setInterval(() => this.reconcile(), RECONCILE_MS);
    this.listen();
  }

  get count() {
    return this.running.size;
  }

  /** そのアカウントの同期が動いているか (テスト用)。 */
  isRunning(accountId: string) {
    return this.running.has(accountId);
  }

  /** そのアカウントの同期 (テスト用)。 */
  syncFor(accountId: string): AccountCalendarSync | undefined {
    return this.running.get(accountId)?.sync;
  }

  /** 通知を受けたのと同じように、アカウントの同期を起こす。 */
  notify(notification: CalendarSyncNotification) {
    this.running
      .get(notification.accountId)
      ?.sync.notify(notification.reason, notification.calendarId);
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
      if (message.channel === CHANNEL_CALENDAR_SYNC) {
        const payload = parseNotification(message.payload);
        if (payload) this.notify(payload);
        return;
      }
      this.reconcile();
    });
    client.on("error", retry);
    client.on("end", retry);
    client
      .connect()
      .then(() => client.query(`LISTEN ${CHANNEL_ACCOUNTS}`))
      .then(() => client.query(`LISTEN ${CHANNEL_CALENDAR_SYNC}`))
      // 待ち受けを始めるまでの間に届いた通知は失われるので、ここで追いつく。
      .then(() => this.reconcile())
      .catch(retry);
  }

  /** DB の状態に合わせて起動・停止する。同時には 1 回だけ走らせる。 */
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling
      .then(() => this.reconcileOnce())
      .catch((error) => {
        console.error(
          "カレンダーのアカウント一覧の確認に失敗しました。",
          error,
        );
      });
    return this.reconciling;
  }

  private async reconcileOnce() {
    if (this.stopped) return;
    const rows = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.calendarEnabled, true),
          inArray(accounts.status, ["active", "error"]),
        ),
      );
    const wanted = new Map(rows.map((row) => [row.id, row]));

    for (const [id, entry] of this.running) {
      const row = wanted.get(id);
      // 対象から外れたもの (calendarEnabled=false、削除など) は、変更通知を止めてから止める。
      // 接続設定が変わったものは作り直す (変更通知は新しい同期が作り直す)。
      // 比較相手は同期側が持つ行 (自分で保存したリフレッシュトークンでは作り直さない)。
      if (!row) {
        this.running.delete(id);
        await entry.sync.shutdown();
      } else if (
        calendarConnectionKey(row) !== calendarConnectionKey(entry.sync.account)
      ) {
        entry.sync.stop();
        this.running.delete(id);
      }
    }
    for (const [id, key] of this.parked) {
      const row = wanted.get(id);
      if (!row || calendarParkKey(row) !== key) this.parked.delete(id);
    }

    for (const row of rows) {
      if (this.running.has(row.id) || this.parked.has(row.id)) continue;
      const provider = (this.options.providerFor ?? calendarProviderFor)(
        row,
        {},
      );
      if (!provider) {
        await this.markUnsupported(row);
        this.parked.set(row.id, calendarParkKey(row));
        continue;
      }
      const sync = new AccountCalendarSync(this.db, row, provider, {
        encryptionKey: this.options.encryptionKey,
        google: this.options.google,
        microsoft: this.options.microsoft,
        webhookBaseUrl: this.options.webhookBaseUrl,
        allowPrivateHosts: this.options.allowPrivateHosts,
        ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
        ...(this.options.createAuth
          ? { createAuth: this.options.createAuth }
          : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
      });
      const entry = { sync };
      this.running.set(row.id, entry);
      sync.run().finally(() => {
        if (this.running.get(row.id) !== entry) return;
        this.running.delete(row.id);
        if (sync.parked && !this.stopped) {
          this.parked.set(row.id, calendarParkKey(sync.account));
        }
      });
    }

    // 通知を取りこぼしていても、反映待ちの書き戻しが残っていれば処理させる。
    for (const accountId of await accountsWithPendingOutbox(
      this.db,
      "calendar",
    )) {
      this.running.get(accountId)?.sync.notify("outbox");
    }
  }

  private async markUnsupported(row: AccountRow) {
    if (row.calendarError === UNSUPPORTED_CALENDAR_ERROR) return;
    await this.db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({ calendarError: UNSUPPORTED_CALENDAR_ERROR })
        .where(eq(accounts.id, row.id));
      await recordChanges(tx, row.userId, "account", "upsert", [row.id]);
    });
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
