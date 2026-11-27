import {
  type CalendarSyncReason,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleOAuthConfig,
  MICROSOFT_CALENDAR_SCOPES,
  type MicrosoftOAuthConfig,
} from "@orbit/core";
import {
  accounts,
  calendars,
  type Database,
  listEventEtags,
  listEventKeys,
  upsertAccountCalendars,
} from "@orbit/db";
import { and, eq } from "drizzle-orm";
import { recordChanges } from "../changes.js";
import { ingestEventDelta, lockCalendarAccount } from "./ingest.js";
import { processEventOutbox } from "./outbox.js";
import {
  type AccountRow,
  type CalendarAuth,
  CalendarAuthError,
  CalendarNotImplementedError,
  type CalendarProvider,
  type CalendarRow,
  type ProviderContext,
  type RemoteEvent,
  toAccountCalendarInput,
} from "./provider.js";
import { createCalendarAuth } from "./tokens.js";

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** カレンダーの一覧を取り直す間隔。 */
const LIST_INTERVAL_MS = 10 * 60_000;
/** 利用者がカレンダーの画面を開いているとみなす時間 (端末は 30 秒ごとに知らせる想定)。 */
const PRESENCE_TTL_MS = 75_000;
/** 画面を開いている間の確認間隔の上限。 */
const PRESENT_POLL_MS = 60_000;
/** 1 回の待ちの上限 (時計のずれや取りこぼしに備える)。 */
const MAX_SLEEP_MS = 10 * 60_000;
/** 1 回の同期で読むページ数の上限 (プロバイダの不具合で終わらないときの保険)。 */
const MAX_PAGES = 1_000;
/** 同期を止めるときの、変更通知の停止 (stopPush) 1 回分の時間の上限。 */
const STOP_PUSH_TIMEOUT_MS = 10_000;

export type AccountCalendarSyncOptions = {
  encryptionKey: Buffer;
  google: GoogleOAuthConfig | null;
  microsoft: MicrosoftOAuthConfig | null;
  webhookBaseUrl: string | null;
  allowPrivateHosts: boolean;
  fetchFn?: typeof fetch;
  /** 認証の作り方を差し替える (テスト用)。 */
  createAuth?: (account: AccountRow) => CalendarAuth;
  log?: (message: string) => void;
};

/**
 * アカウント 1 件分のカレンダーの同期 (プロバイダに依らない周回)。
 * 1. 予定の書き戻し (outbox) を先に反映する。
 * 2. カレンダーの一覧を、10 分ごとか求められたときに取り直す。
 * 3. 時期の来たカレンダーごとに差分を取り込む (通知が届いた、未同期、確認間隔が過ぎた)。
 * 4. 変更通知 (watch / subscription) を作り、延ばす。
 * 5. 次の時期か起こされるまで待つ。失敗したら指数バックオフでやり直す。
 * 認証の失敗 (CalendarAuthError) と未実装 (CalendarNotImplementedError) では止まり、
 * parked を true にする (manager は認証情報などが変わるまで起動し直さない)。
 */
export class AccountCalendarSync {
  /** 接続設定の比較に使う、現在の行。リフレッシュトークンを保存すると差し替わる。 */
  account: AccountRow;
  /** 認証の失敗などで止まった。 */
  parked = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private wake: (() => void) | null = null;
  private wakeRequested = false;
  private backoff = MIN_BACKOFF_MS;
  private auth: CalendarAuth | null = null;
  private listedAt = 0;
  private listRequested = true;
  /** 同期を求められたカレンダー。all は全部。 */
  private requested = new Set<string>();
  private requestedAll = false;
  private presentUntil = 0;
  /** 最後に読んだカレンダーの行 (アカウントが消えた後に変更通知を止めるため)。 */
  private knownCalendars: CalendarRow[] = [];

  constructor(
    private readonly db: Database,
    account: AccountRow,
    private readonly provider: CalendarProvider,
    private readonly options: AccountCalendarSyncOptions,
  ) {
    this.account = account;
  }

  private log(message: string) {
    (this.options.log ?? console.log)(
      `[${this.account.email}] カレンダー: ${message}`,
    );
  }

  /** 停止されるか、認証の失敗などで止まるまで動き続ける。 */
  async run() {
    while (!this.stopped) {
      let nextAt: number;
      try {
        nextAt = await this.cycle();
        this.backoff = MIN_BACKOFF_MS;
      } catch (error) {
        if (this.stopped) break;
        if (
          error instanceof CalendarAuthError ||
          error instanceof CalendarNotImplementedError
        ) {
          await this.park(error);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        // 一時的な失敗は calendarError に書かない (calendarError は同期が止まった状態だけを表し、
        // API はそれを見て書き込みを断る)。
        this.log(`同期中にエラーが発生しました: ${message}`);
        nextAt = Date.now() + this.backoff * (0.75 + Math.random() * 0.5);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      }
      if (this.stopped) break;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        continue;
      }
      await this.sleep(
        Math.min(Math.max(nextAt - Date.now(), 0), MAX_SLEEP_MS),
      );
      this.wakeRequested = false;
    }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    this.wake?.();
  }

  /**
   * 同期をやめる (calendarEnabled を切った、アカウントが対象から外れた)。変更通知を止めてから
   * 停止する。失敗しても停止はする。アカウントやカレンダーの行が消えていれば、最後に読んだ行を使う。
   */
  async shutdown() {
    this.stopped = true;
    this.wake?.();
    try {
      if (this.provider.stopPush) {
        const rows = await this.db
          .select()
          .from(calendars)
          .where(
            and(
              eq(calendars.accountId, this.account.id),
              eq(calendars.source, this.provider.source),
            ),
          );
        const targets = rows.length > 0 ? rows : this.knownCalendars;
        await this.stopPushFor(
          {
            ...this.context(),
            signal: AbortSignal.timeout(STOP_PUSH_TIMEOUT_MS),
          },
          targets,
          false,
        );
      }
    } catch (error) {
      this.log(
        `変更通知を止められませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.stop();
    }
  }

  /**
   * pushChannelId のあるカレンダーの変更通知を止める。失敗はログに残して続ける。
   * rethrow が true なら、認証の失敗と停止は投げ直す。
   */
  private async stopPushFor(
    ctx: ProviderContext,
    rows: readonly CalendarRow[],
    rethrow: boolean,
  ) {
    if (!this.provider.stopPush) return;
    for (const row of rows) {
      if (row.pushChannelId === null) continue;
      try {
        await this.provider.stopPush(ctx, row);
      } catch (error) {
        if (
          rethrow &&
          (error instanceof CalendarAuthError || this.abort.signal.aborted)
        ) {
          throw error;
        }
        this.log(
          `「${row.name}」の変更通知を止められませんでした: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 同期を求める。outbox は書き戻しを、push と refresh は calendarId のカレンダー
   * (省けば全部) の差分を、すぐに確かめる。refresh は一覧も取り直す。
   * focus は画面を開いている間、確認間隔を短くする。
   */
  notify(reason: CalendarSyncReason, calendarId?: string) {
    if (this.stopped) return;
    if (reason === "focus") {
      const wasPresent = Date.now() < this.presentUntil;
      this.presentUntil = Date.now() + PRESENCE_TTL_MS;
      if (wasPresent) return;
    } else if (reason === "push" || reason === "refresh") {
      if (calendarId) this.requested.add(calendarId);
      else this.requestedAll = true;
      if (reason === "refresh") this.listRequested = true;
    }
    this.wakeRequested = true;
    this.wake?.();
  }

  private context(): ProviderContext {
    this.auth ??= (
      this.options.createAuth ??
      ((account) =>
        createCalendarAuth(this.db, this.options.encryptionKey, account, {
          google: this.options.google,
          microsoft: this.options.microsoft,
          ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
          onCredentialsSaved: (credentialsEncrypted) => {
            this.account = { ...this.account, credentialsEncrypted };
          },
        }))
    )(this.account);
    return {
      account: this.account,
      auth: this.auth,
      fetchFn: this.options.fetchFn ?? fetch,
      signal: this.abort.signal,
      webhookBaseUrl: this.options.webhookBaseUrl,
      encryptionKey: this.options.encryptionKey,
      allowPrivateHosts: this.options.allowPrivateHosts,
      log: (message) => this.log(message),
      saveCalendarState: async (calendarId, state) => {
        const [row] = await this.db
          .select({ providerState: calendars.providerState })
          .from(calendars)
          .where(
            and(
              eq(calendars.id, calendarId),
              eq(calendars.accountId, this.account.id),
            ),
          );
        if (!row) return;
        await this.db
          .update(calendars)
          .set({
            ...(state.pushChannelId === undefined
              ? {}
              : { pushChannelId: state.pushChannelId }),
            ...(state.pushExpiresAt === undefined
              ? {}
              : { pushExpiresAt: state.pushExpiresAt }),
            ...(state.providerState === undefined
              ? {}
              : {
                  providerState:
                    state.providerState === null
                      ? null
                      : {
                          ...(row.providerState ?? {}),
                          ...state.providerState,
                        },
                }),
          })
          .where(eq(calendars.id, calendarId));
      },
    };
  }

  /** 同期 1 回分。次に同期する時刻を返す。失敗すると投げる。 */
  private async cycle(): Promise<number> {
    const ctx = this.context();
    const log = (message: string) => this.log(message);

    // 1. 書き戻しを先に反映する (取り込みで古い状態に戻さないため)。
    const outboxResult = await processEventOutbox({
      db: this.db,
      account: this.account,
      provider: this.provider,
      ctx,
      log,
    });
    if (outboxResult.done > 0) {
      this.log(`予定の変更を ${outboxResult.done} 件書き戻しました`);
    }
    // 一時的な失敗で待っている書き戻しがあれば、その時刻に起きる。
    const outboxRetryAt = outboxResult.retryAt?.getTime() ?? null;

    // 2. カレンダーの一覧。
    const now = Date.now();
    if (this.listRequested || now - this.listedAt >= LIST_INTERVAL_MS) {
      await this.syncCalendarList(ctx);
      this.listedAt = Date.now();
      this.listRequested = false;
    }

    // 3. 時期の来たカレンダーの差分。
    const rows = await this.db
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.accountId, this.account.id),
          eq(calendars.source, this.provider.source),
        ),
      );
    this.knownCalendars = rows;
    const requestedAll = this.requestedAll;
    const requested = new Set(this.requested);
    this.requestedAll = false;
    this.requested.clear();
    for (const calendar of rows) {
      if (this.stopped) break;
      const forced = requestedAll || requested.has(calendar.id);
      if (!forced && this.dueAt(calendar) > Date.now()) continue;
      await this.syncCalendar(ctx, calendar);
    }

    // 4. 変更通知。失敗しても同期は止めない (認証の失敗は除く)。
    if (this.provider.maintainPush && !this.stopped) {
      const fresh = await this.db
        .select()
        .from(calendars)
        .where(
          and(
            eq(calendars.accountId, this.account.id),
            eq(calendars.source, this.provider.source),
          ),
        );
      try {
        await this.provider.maintainPush(ctx, fresh);
      } catch (error) {
        if (error instanceof CalendarAuthError) throw error;
        if (this.abort.signal.aborted) throw error;
        this.log(
          `変更通知を設定できませんでした。定期的な確認で同期を続けます: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (this.account.calendarError !== null) await this.setCalendarError(null);

    // 5. 次の時期。
    const after = await this.db
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.accountId, this.account.id),
          eq(calendars.source, this.provider.source),
        ),
      );
    let nextAt = this.listedAt + LIST_INTERVAL_MS;
    for (const calendar of after) {
      nextAt = Math.min(nextAt, this.dueAt(calendar));
    }
    if (outboxRetryAt !== null) nextAt = Math.min(nextAt, outboxRetryAt);
    return nextAt;
  }

  /** カレンダーの次の確認の時刻。一度も試していなければいま。 */
  private dueAt(calendar: CalendarRow): number {
    // 失敗しているカレンダーも、最後に試した時刻から間隔をあけてやり直す。
    const base = Math.max(
      calendar.lastSyncedAt?.getTime() ?? 0,
      calendar.syncAttemptedAt?.getTime() ?? 0,
    );
    if (base === 0) return 0;
    let interval =
      (calendar.pollIntervalSeconds ?? this.provider.defaultPollSeconds) * 1000;
    if (Date.now() < this.presentUntil) {
      interval = Math.min(interval, PRESENT_POLL_MS);
    }
    return base + interval;
  }

  private async syncCalendarList(ctx: ProviderContext) {
    const remote = await this.provider.listCalendars(ctx);
    // 一覧から消えるカレンダーの変更通知を、行を消す前に止める (ロックを持ったまま呼ばない)。
    const wanted = new Set(remote.map((calendar) => calendar.remoteId));
    const existing = await this.db
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.accountId, this.account.id),
          eq(calendars.source, this.provider.source),
        ),
      );
    await this.stopPushFor(
      ctx,
      existing.filter(
        (row) => row.remoteId === null || !wanted.has(row.remoteId),
      ),
      true,
    );
    await this.db.transaction(async (tx) => {
      await lockCalendarAccount(tx, this.account.id);
      const { upserted, deleted } = await upsertAccountCalendars(
        tx,
        {
          userId: this.account.userId,
          accountId: this.account.id,
          source: this.provider.source,
        },
        remote.map(toAccountCalendarInput),
      );
      await recordChanges(
        tx,
        this.account.userId,
        "calendar",
        "upsert",
        upserted,
      );
      await recordChanges(
        tx,
        this.account.userId,
        "calendar",
        "delete",
        deleted,
      );
    });
  }

  /**
   * カレンダー 1 つの差分を、最後のページまで取り込む。失敗したら calendars.lastError に書き、
   * ほかのカレンダーは続ける (認証の失敗と停止は投げる)。
   */
  private async syncCalendar(ctx: ProviderContext, calendar: CalendarRow) {
    const seen = new Set<string>();
    const carry: RemoteEvent[] = [];
    let pageCursor: string | null = null;
    try {
      // 途中のページでは同期の位置 (syncToken) を変えない。最後のページで保存する。
      for (let page = 0; page < MAX_PAGES; page++) {
        const delta = await this.provider.syncEvents(ctx, calendar, {
          syncToken: calendar.syncToken,
          pageCursor,
          knownEtags: () => listEventEtags(this.db, calendar.id),
          knownEvents: () => listEventKeys(this.db, calendar.id),
        });
        await ingestEventDelta(this.db, {
          account: this.account,
          calendar,
          provider: this.provider,
          delta,
          seen,
          carry,
          log: (message) => this.log(message),
        });
        pageCursor = delta.nextPageCursor;
        if (pageCursor === null) return;
      }
      throw new Error("予定のページが終わりませんでした。");
    } catch (error) {
      if (
        error instanceof CalendarAuthError ||
        error instanceof CalendarNotImplementedError ||
        this.abort.signal.aborted
      ) {
        throw error;
      }
      const message = describeError(error);
      this.log(`「${calendar.name}」を同期できませんでした: ${message}`);
      await this.db.transaction(async (tx) => {
        await tx
          .update(calendars)
          // 試した時刻は進め、確認間隔をあけてからやり直す。lastSyncedAt (最後に成功した時刻) は
          // 書き戻しの gone の決まりの基準なので、失敗では進めない。
          .set({ lastError: message, syncAttemptedAt: new Date() })
          .where(eq(calendars.id, calendar.id));
        if (calendar.lastError !== message) {
          await recordChanges(tx, this.account.userId, "calendar", "upsert", [
            calendar.id,
          ]);
        }
      });
    }
  }

  /**
   * 認証の失敗などで止まる。calendarError を書き、スコープ不足なら oauthScopes から
   * カレンダーの権限を外す (API が再同意を求められるように)。メール無しのアカウントで
   * 再ログインが必要なら、accounts.status も auth_required にする (メールありなら、
   * メールの同期が自分で検知する)。
   */
  private async park(error: CalendarAuthError | CalendarNotImplementedError) {
    this.parked = true;
    this.log(`同期を止めます: ${error.message}`);
    const needsReauth = error instanceof CalendarAuthError && error.needsReauth;
    const consentRequired =
      error instanceof CalendarAuthError && error.consentRequired;
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, this.account.id));
        if (!row) return;
        const set: Partial<typeof accounts.$inferInsert> = {
          calendarError: error.message,
        };
        if (consentRequired && row.oauthScopes) {
          set.oauthScopes = withoutCalendarScopes(row.oauthScopes);
        }
        if (needsReauth && !consentRequired && !row.mailEnabled) {
          set.status = "auth_required";
          set.lastError = error.message;
        }
        await tx.update(accounts).set(set).where(eq(accounts.id, row.id));
        await recordChanges(tx, row.userId, "account", "upsert", [row.id]);
        // 比較に使う行も合わせる (manager は止めた時点の行の値で、変わるのを待つ)。
        this.account = { ...this.account, ...set };
      });
    } catch (saveError) {
      this.log(
        `状態を保存できませんでした: ${saveError instanceof Error ? saveError.message : ""}`,
      );
    }
  }

  private async setCalendarError(message: string | null) {
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(accounts)
          .set({ calendarError: message })
          .where(eq(accounts.id, this.account.id))
          .returning({ id: accounts.id, userId: accounts.userId });
        if (row) {
          await recordChanges(tx, row.userId, "account", "upsert", [row.id]);
        }
      });
      this.account = { ...this.account, calendarError: message };
    } catch (error) {
      this.log(
        `状態を保存できませんでした: ${error instanceof Error ? error.message : ""}`,
      );
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

/** oauthScopes から、カレンダーの権限 (Google と Microsoft) を外す。 */
export function withoutCalendarScopes(scopes: string): string {
  const calendarScopes = new Set(
    [
      ...GOOGLE_CALENDAR_SCOPES,
      "https://www.googleapis.com/auth/calendar",
      ...MICROSOFT_CALENDAR_SCOPES,
    ].map((scope) => scope.toLowerCase()),
  );
  const names = new Set(
    MICROSOFT_CALENDAR_SCOPES.map((scope) =>
      scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase(),
    ),
  );
  return scopes
    .split(/\s+/)
    .filter((scope) => {
      const lower = scope.toLowerCase();
      return scope !== "" && !calendarScopes.has(lower) && !names.has(lower);
    })
    .join(" ");
}

/** 画面に出すエラーの説明。DB のエラーは SQL や値を含むので、利用者には見せない。 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const withQuery = error as Error & { query?: unknown };
  if (
    withQuery.query !== undefined ||
    error.message.startsWith("Failed query")
  ) {
    return "サーバー内部でエラーが発生しました。";
  }
  return error.message;
}
