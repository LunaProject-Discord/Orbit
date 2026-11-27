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
 * - uid は原本と例外で同じ値にする。例外 (recurrenceId と parentRemoteId がある行) は uid を
 *   省いて (undefined か null) よい。そのときは土台が、同じ応答の中の原本、または DB の原本
 *   (parentRemoteId の行)、または同じ remoteId の既存の行から補う。補えなかった例外は、
 *   全件・差分の最後のページまで待ってから捨てる (ログに残す)。原本と繰り返さない予定は必ず入れる。
 * - 1 つの remoteId の行 (CalDAV の原本と例外) は、必ず同じページにまとめて返す。土台は、
 *   届いた remoteId の既存の行のうち、今回届かなかった (uid, recurrenceId) の行を
 *   「リソースから消えた」として消す (書き戻し待ちの行は残す)。
 * - recurrenceId は normalizeRecurrenceId の書き方 (時刻付きは UTC の ISO 8601、終日は YYYY-MM-DD)。
 * - 取り消された回は status: "cancelled" の例外として返してよい (原本の exdates に入れてもよい)。
 * - raw は、相手側の内容をそのまま (または parseRaw で戻せる形で) 入れる。3 者比較の基準になる。
 */
export type RemoteEvent = Omit<
  RemoteEventInput,
  "fieldUpdatedAt" | "parentRemoteId" | "uid"
> & {
  /** 例外のとき、原本の remoteId (Google の recurringEventId、Graph の seriesMasterId)。CalDAV は自分と同じ値。 */
  parentRemoteId: string | null;
  /** iCalendar の UID。例外では省いてよい (上の説明を参照)。 */
  uid?: string | null;
};

/** syncEvents の cursor.knownEvents が返す、DB にある予定 1 つ分。 */
export type KnownRemoteEvent = {
  /** 原本 (CalDAV では同じリソースの原本) の uid。 */
  uid: string;
  etag: string | null;
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
  /**
   * 412 など。相手が先に変わっていた。取り直しとマージは土台が行う。
   * createEvent で「決まった ID の予定が既にある」(Google の 409 duplicate、CalDAV の
   * If-None-Match: * の 412) を返すときは、remoteId にその予定の remoteId を入れる。
   * 土台が getEvent で取り直し、ok として扱う (できれば createEvent の中で取り直して ok を返す)。
   */
  | { status: "conflict"; remoteId?: string }
  /** 相手側に無い (404 / 410)。 */
  | { status: "gone" }
  /** やり直しても通らない (400、403 の権限不足以外など)。 */
  | { status: "rejected"; reason: string };
// 一時的な失敗 (回線、429、5xx) は例外を投げる。待つ時間が分かるとき (Retry-After など) は
// CalendarTransientError を投げる。認証の失敗は CalendarAuthError を投げる。
// 書き戻しは、最初の一時的な失敗から 6 時間たつまでやり直す (回数では打ち切らない)。

export interface CalendarProvider {
  readonly source: ProviderSource;
  /** 変更通知が無いときの確認間隔の既定 (秒)。google / microsoft は 900 など、caldav は 300。 */
  readonly defaultPollSeconds: number;
  listCalendars(ctx: ProviderContext): Promise<RemoteCalendar[]>;
  /**
   * 予定の差分を 1 ページ返す。syncToken が null、または無効だったら全件 (full: true) を返す。
   * 無効の検知はプロバイダの中で行う。knownEtags は DB にある remoteId → etag
   * (CalDAV で、変わったリソースだけを取るのに使う)。knownEvents は remoteId → { uid, etag }
   * (Google / Graph で、例外の原本の uid を引くのに使える。例外の uid は省いてもよい)。
   * どちらも呼ぶたびに DB を読むので、1 ページに 1 回までにする。
   */
  syncEvents(
    ctx: ProviderContext,
    calendar: CalendarRow,
    cursor: {
      syncToken: string | null;
      pageCursor: string | null;
      knownEtags(): Promise<Map<string, string | null>>;
      knownEvents(): Promise<Map<string, KnownRemoteEvent>>;
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
  /**
   * 予定を作る。create は events.id (write.event.id) から決まる ID で冪等に行う。既にあれば
   * 相手側の姿を ok で返す (作ったあと結果を保存する前に止まると、土台は同じ予定でもう一度呼ぶため)。
   * - Google: events.insert の id に events.id から作った値 (base32hex) を入れる。
   * - Graph: transactionId に events.id を入れる。
   * - CalDAV: href と UID を events.id から決める。PUT に If-None-Match: * を付ける。
   * 既にあることを ok にできないときは { status: "conflict", remoteId } を返す
   * (土台が getEvent で取り直して ok にする)。
   * 相手側が UID を付け替えてよい (ok の events の uid を新しい値にする。土台が行の uid を直す)。
   */
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
  /**
   * 変更通知を止める。土台は、pushChannelId が null でないカレンダーについて、
   * 同期を止めるとき (calendarEnabled を切った、アカウントが対象から外れた) と、
   * カレンダーが一覧から消えて行を消す前に呼ぶ。失敗しても土台は先へ進む (ログに残す)。
   * アカウントが消えた後など、認証できないこともある。
   */
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

/**
 * 一時的な失敗 (429、503、回線) で、待つ時間が分かるときに投げる。土台は書き戻しの回数に数えず、
 * retryAfterMs (省けば 30 秒) たつまで、そのアカウントの書き戻しを待たせる (順番は保つ)。
 * 待つ時間が分からなければ、ふつうの Error を投げてよい (周回のバックオフでやり直す)。
 * どちらも、最初の失敗から 6 時間たつと確定した失敗になる。
 */
export class CalendarTransientError extends Error {
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    options: { retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CalendarTransientError";
    this.retryAfterMs =
      typeof options.retryAfterMs === "number" &&
      Number.isFinite(options.retryAfterMs) &&
      options.retryAfterMs >= 0
        ? options.retryAfterMs
        : null;
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
