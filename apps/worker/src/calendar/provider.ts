import type { EventFieldName } from "@orbit/core";
import type {
  AccountCalendarInput,
  accounts,
  CalendarReminder,
  calendars,
  EventWithExtras,
  RemoteEventInput,
} from "@orbit/db";

/**
 * カレンダーのプロバイダ (Google、Microsoft、CalDAV) の interface。型だけを置く。
 * 各担当は calendar/<プロバイダ>/ の中で CalendarProvider を実装し、ここは変えない
 * (変えたいときは土台の担当に頼む)。
 */

export type AccountRow = typeof accounts.$inferSelect;
export type CalendarRow = typeof calendars.$inferSelect;
export type ProviderSource = "google" | "microsoft" | "caldav";

/**
 * プロバイダへの認証。OAuth2 はアクセストークンを都度もらう
 * (force は、サーバーに拒否されたので取り直したいとき)。
 * CalDAV などのパスワードは、そのまま Basic 認証などに使う。
 */
export type CalendarAuth =
  | { type: "oauth2"; getAccessToken(force?: boolean): Promise<string> }
  | { type: "password"; username: string; password: string };

/** プロバイダが変更通知の状態を保存するときに書ける列。 */
export type CalendarPushState = {
  pushChannelId?: string | null;
  pushExpiresAt?: Date | null;
  /** いまの providerState に浅く重ねる (指定しない鍵は残す)。null なら消す。 */
  providerState?: Record<string, unknown> | null;
};

export type ProviderContext = {
  account: AccountRow;
  auth: CalendarAuth;
  fetchFn: typeof fetch;
  /** 同期を止めるときに中断される。fetch にそのまま渡す。 */
  signal: AbortSignal;
  /** Webhook の受け口の土台の URL。公開された HTTPS が無ければ null。 */
  webhookBaseUrl: string | null;
  encryptionKey: Buffer;
  /** 開発用に、プライベートな IP の接続先を許す (CalDAV の host-check 用)。 */
  allowPrivateHosts: boolean;
  log(message: string): void;
  /**
   * カレンダーの変更通知の状態 (pushChannelId、pushExpiresAt、providerState) を保存する。
   * maintainPush / stopPush の中で使う。DB を直接触らずに済むよう、土台が用意する。
   */
  saveCalendarState(
    calendarId: string,
    state: CalendarPushState,
  ): Promise<void>;
};

/** プロバイダのカレンダー 1 つ分。 */
export type RemoteCalendar = {
  remoteId: string;
  name: string;
  description: string | null;
  /** "#rrggbb"。 */
  color: string | null;
  timeZone: string | null;
  readOnly: boolean;
  /** CalDAV のコレクションの URL。ほかは null。 */
  url: string | null;
  defaultReminders: CalendarReminder[] | null;
  /** birthdays は、読み取り専用のカレンダーとして保存し、providerState.kind に残す。 */
  kind: "normal" | "birthdays";
  /** 指定すれば providerState に浅く重ねて保存する (同期の位置などには使わない)。 */
  providerState?: Record<string, unknown> | null;
};

/**
 * 予定 1 行分。CalDAV は 1 リソースに原本と例外が入るので、同じ remoteId と etag の行が複数になる。
 * - uid は原本と例外で同じ値にする。
 * - recurrenceId は normalizeRecurrenceId の書き方 (時刻付きは UTC の ISO 8601、終日は YYYY-MM-DD)。
 * - 取り消された回は status: "cancelled" の例外として返してよい (原本の exdates に入れてもよい)。
 * - raw は、相手側の内容をそのまま (または parseRaw で戻せる形で) 入れる。3 者比較の基準になる。
 */
export type RemoteEvent = Omit<
  RemoteEventInput,
  "fieldUpdatedAt" | "parentRemoteId"
> & {
  /** 例外のとき、原本の remoteId (Google の recurringEventId、Graph の seriesMasterId)。CalDAV は自分と同じ値。 */
  parentRemoteId: string | null;
};

export type EventDelta = {
  events: RemoteEvent[];
  /** 相手側で消えた予定の remoteId。 */
  deletedRemoteIds: string[];
  /** まだ続きがある。次の呼び出しに cursor.pageCursor として渡す (保存しない)。 */
  nextPageCursor: string | null;
  /** 最後のページでだけ返す。calendars.syncToken に保存する。 */
  nextSyncToken: string | null;
  /** 最後のページでだけ返す。指定すれば calendars.etag に保存する (CalDAV の getctag など)。 */
  nextEtag?: string | null;
  /**
   * 全件を返した (同期の位置が無い、または無効だった)。すべてのページで同じ値にする。
   * 最後のページのあと、どのページにも出てこなかった remoteId の予定を土台が消す。
   */
  full: boolean;
};

/** 相手側の予定を指すもの。書き込み、削除、取り直しに使う。 */
export type RemoteEventRef = {
  remoteId: string;
  /** If-Match に使う。null なら無条件で書く。 */
  etag: string | null;
  uid: string;
  recurrenceId: string | null;
  parentRemoteId: string | null;
};

/** 書き込む内容の 1 行分。DB のいまの状態を土台が読んで渡す。 */
export type EventSnapshot = EventWithExtras;

export type EventWrite = {
  event: EventSnapshot;
  /** event が例外のときの原本。 */
  master: EventSnapshot | null;
  /** event が原本のときの例外 (CalDAV は全部を 1 リソースに書く)。 */
  exceptions: EventSnapshot[];
  /** 変えた項目。create では全項目。 */
  fields: EventFieldName[];
  // 前回の相手側の内容は event.raw。知らない項目を消さないために使う。
};

export type WriteResult =
  /** 書いたあとの相手側の姿 (remoteId、etag、raw 入り)。原本なら例外も含めてよい。 */
  | { status: "ok"; events: RemoteEvent[] }
  /** 412 など。相手が先に変わっていた。取り直しとマージは土台が行う。 */
  | { status: "conflict" }
  /** 相手側に無い (404 / 410)。 */
  | { status: "gone" }
  /** やり直しても通らない (400、403 の権限不足以外など)。 */
  | { status: "rejected"; reason: string };
// 一時的な失敗 (回線、429、5xx) は例外を投げる。認証の失敗は CalendarAuthError を投げる。

export interface CalendarProvider {
  readonly source: ProviderSource;
  /** 変更通知が無いときの確認間隔の既定 (秒)。google / microsoft は 900 など、caldav は 300。 */
  readonly defaultPollSeconds: number;
  listCalendars(ctx: ProviderContext): Promise<RemoteCalendar[]>;
  /**
   * 予定の差分を 1 ページ返す。syncToken が null、または無効だったら全件 (full: true) を返す。
   * 無効の検知はプロバイダの中で行う。knownEtags は DB にある remoteId → etag
   * (CalDAV で、変わったリソースだけを取るのに使う)。
   */
  syncEvents(
    ctx: ProviderContext,
    calendar: CalendarRow,
    cursor: {
      syncToken: string | null;
      pageCursor: string | null;
      knownEtags(): Promise<Map<string, string | null>>;
    },
  ): Promise<EventDelta>;
  /** 1 件を取り直す。原本なら例外も含めて返す。無ければ null。 */
  getEvent(
    ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
  ): Promise<RemoteEvent[] | null>;
  /** raw を RemoteEvent に戻す (3 者比較の基準を作る)。 */
  parseRaw(raw: string, calendar: CalendarRow): RemoteEvent[];
  createEvent(
    ctx: ProviderContext,
    calendar: CalendarRow,
    write: EventWrite,
  ): Promise<WriteResult>;
  /**
   * 予定を書き換える。ref.etag があれば必ず If-Match として付ける。
   * write.event.remoteId が null で write.master があるときは、まだ相手側に無い回の例外を
   * 新しく作る書き込み (ref は原本を指し、ref.recurrenceId がその回、ref.etag は null)。
   */
  updateEvent(
    ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
    write: EventWrite,
  ): Promise<WriteResult>;
  deleteEvent(
    ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
  ): Promise<WriteResult>;
  respond(
    ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
    response: {
      status: "accepted" | "tentative" | "declined";
      comment: string | null;
    },
  ): Promise<WriteResult>;
  /** 変更通知の作成と更新。状態は ctx.saveCalendarState で保存する。 */
  maintainPush?(
    ctx: ProviderContext,
    calendarRows: CalendarRow[],
  ): Promise<void>;
  stopPush?(ctx: ProviderContext, calendar: CalendarRow): Promise<void>;
}

/** registry が各プロバイダを作るときに渡すもの。 */
export type CalendarProviderDeps = {
  /** 既定の確認間隔を変えたいとき (テストなど)。 */
  defaultPollSeconds?: number;
};

/**
 * アカウント単位の認証の失敗。土台はこれを受けて accounts.calendarError を書き、同期を止める
 * (認証情報が変わるまで再開しない)。
 * - needsReauth: リフレッシュトークンの失効、パスワードの誤りなど。ログインし直しが要る。
 * - consentRequired: スコープ不足 (403 insufficient scope など)。カレンダーの権限の同意が要る。
 */
export class CalendarAuthError extends Error {
  readonly needsReauth: boolean;
  readonly consentRequired: boolean;
  constructor(
    message: string,
    options: {
      needsReauth?: boolean;
      consentRequired?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CalendarAuthError";
    this.consentRequired = options.consentRequired === true;
    this.needsReauth = options.needsReauth === true || this.consentRequired;
  }
}

/** 雛形のプロバイダが投げる。土台はこれを受けて calendarError を書き、同期を止める。 */
export class CalendarNotImplementedError extends Error {
  constructor(message = "このカレンダーの同期はまだ実装されていません。") {
    super(message);
    this.name = "CalendarNotImplementedError";
  }
}

/** RemoteCalendar を DB に保存する形にする。 */
export function toAccountCalendarInput(
  remote: RemoteCalendar,
): AccountCalendarInput {
  const birthdays = remote.kind === "birthdays";
  const providerState = birthdays
    ? { ...(remote.providerState ?? {}), kind: "birthdays" }
    : remote.providerState;
  return {
    remoteId: remote.remoteId,
    name: remote.name,
    description: remote.description,
    color: remote.color,
    timeZone: remote.timeZone,
    readOnly: remote.readOnly || birthdays,
    url: remote.url,
    defaultReminders: remote.defaultReminders,
    ...(providerState === undefined ? {} : { providerState }),
  };
}
