import { readFile, stat } from "node:fs/promises";
import {
  attachmentPath,
  type InviteAction,
  type InviteActionState,
  type InviteApplyExpect,
  type InviteBlocked,
  type InviteConfirmReason,
  type InviteSenderAuth,
  inviteRole,
  isCurrentSenderCheck,
  type MessageInviteImipFields,
  normalizeRecurrenceId,
  type ParsedCalendar,
  type ParsedEvent,
  parseICalendar,
  RSVP_COMMENT_MAX,
} from "@orbit/core";
import {
  accounts,
  attachments,
  calendars,
  type Database,
  eventAttendees,
  events,
  messages,
} from "@orbit/db";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  type CalendarIdentity,
  calendarIdentities,
  ownAddresses,
} from "./calendar-identity.js";
import { recordChanges } from "./changes.js";
import { loadSchedulingInfo } from "./event-imip.js";
import {
  cancelPendingWrites,
  enqueueDelete,
  enqueueEventOperation,
  enqueueEventUpdate,
  eventCreateKey,
  excludeOccurrence,
  isProviderCalendar,
  lockCalendarAccount,
  lockEventForWrite,
  providerWriteBlocked,
} from "./event-outbox.js";
import {
  type EventAttendeeInput,
  type EventFieldsInput,
  eventFieldColumns,
  insertEvent,
  replaceEventExtras,
} from "./event-rows.js";
import type { EventsHub } from "./events-hub.js";
import {
  ensureReceivedAttachment,
  statusOfFetchError,
} from "./received-attachments.js";

/**
 * メールの招待 (iMIP) の取り込み・更新・取り消し・REPLY の反映 (imip-design 7・8 章)。
 * GET /v1/messages/:id/invite の action と、POST /v1/messages/:id/invite/apply が使う。
 *
 * 書き込みは利用者の操作 (apply) でだけ行い、サーバーが添付をもう一度読んで決める
 * (端末が送った内容は信用しない)。COUNTER / REFRESH などの METHOD、代理 (SENT-BY) は扱わない。
 * 予定の行は event-rows.ts、書き戻しは event-outbox.ts の、calendars.ts と同じ処理で書く。
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;
type CalendarRow = typeof calendars.$inferSelect;
type EventRow = typeof events.$inferSelect;
type AttendeeRow = typeof eventAttendees.$inferSelect;

/** これより大きい招待は読まない (9 章)。 */
export const MAX_INVITE_BYTES = 1024 * 1024;

/**
 * これより行の多い招待は読まない。ふつうの招待は数百行 (参加者が多くても数千行) なので余裕を見た値。
 * 1 MB に収まる悪意のある入力 (閉じない BEGIN、同じ UID の予定を並べる など) で API を止めないため。
 */
export const MAX_INVITE_LINES = 10_000;

/**
 * SEQUENCE の上限。これを超える招待は扱わない (invite: null)。ふつうの予定は数十まで。
 * 大きな値の偽の更新で、以後の本物の更新を「古い」にさせないため (レビュー 8b 指摘 4)。
 */
export const MAX_INVITE_SEQUENCE = 1_000_000;

/** 更新で SEQUENCE がこれより大きく飛ぶときは、確認を挟む (指摘 4)。 */
const SEQUENCE_JUMP = 1000;

/**
 * 招待の値の上限 (calendars.ts の作成・変更と同じ基準。指摘 5)。文字は切り詰め、
 * UID・参加者の数・繰り返しが上限を超える招待は扱わない。
 */
const LIMITS = {
  uid: 255,
  summary: 1000,
  location: 2000,
  description: 100_000,
  name: 300,
  attendees: 500,
  rrule: 1000,
  rdates: 1000,
  exdates: 5000,
  recurrenceId: 40,
  conferenceUrl: 2000,
};

/**
 * REPLY の DTSTAMP が、いまよりこれ以上先なら断る (8.2 の 8)。メールを受け取った時刻より
 * 先の DTSTAMP は受け取った時刻に丸める (指摘 10: 未来の DTSTAMP で本物の返事を止めない)。
 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const lower = (value: string) => value.trim().toLowerCase();

/** 招待のメール (利用者の ID で探した行の、使う列だけ)。 */
export type InviteMessage = {
  id: string;
  accountId: string;
  fromAddress: string | null;
  senderCheck: (typeof messages.$inferSelect)["senderCheck"];
  sentAt: Date | null;
  receivedAt: Date;
};

/** 読み取った招待。entries は先頭の UID の VEVENT (原本と例外)。primary は原本、無ければ最初。 */
export type LoadedInvite = {
  message: InviteMessage;
  method: string | null;
  uid: string;
  entries: ParsedEvent[];
  primary: ParsedEvent;
};

export type LoadInviteResult =
  | { ok: true; invite: LoadedInvite | null }
  | {
      ok: false;
      status: ReturnType<typeof statusOfFetchError>;
      error: string;
    };

const clip = (value: string | null, max: number) =>
  value === null ? null : value.slice(0, max);

/** http(s) の URL で長すぎないものだけ (calendars.ts の conferenceUrl と同じ扱い)。 */
function safeUrl(value: string | null): string | null {
  if (!value || value.length > LIMITS.conferenceUrl) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

/** 招待として扱う RRULE か (FREQ= で始まり、1 秒・1 分ごとの繰り返しではない)。 */
function acceptableRrule(value: string | null): boolean {
  if (value === null) return true;
  const rule = value.replace(/^RRULE:/i, "");
  if (rule.length > LIMITS.rrule || !/^FREQ=/i.test(rule)) return false;
  return !/^FREQ=(SECONDLY|MINUTELY)\b/i.test(rule);
}

/**
 * 招待の VEVENT を、取り込める大きさと形にそろえる (指摘 4・5)。題名・場所・メモ・名前は
 * 切り詰め、SEQUENCE・参加者の数・繰り返し・時刻が扱えないものがあれば null (招待として扱わない)。
 * アドレスの形 (空白なし、320 文字まで) は parseICalendar が確かめている。
 */
function sanitizeEntry(entry: ParsedEvent): ParsedEvent | null {
  if (entry.sequence > MAX_INVITE_SEQUENCE) return null;
  if (entry.attendees.length > LIMITS.attendees) return null;
  if (!acceptableRrule(entry.rrule)) return null;
  if ((entry.rdates?.length ?? 0) > LIMITS.rdates) return null;
  if ((entry.exdates?.length ?? 0) > LIMITS.exdates) return null;
  if (
    entry.recurrenceId !== null &&
    entry.recurrenceId.length > LIMITS.recurrenceId
  ) {
    return null;
  }
  if (entry.allDay ? !entry.startDate || !entry.endDate : !entry.startAt) {
    return null;
  }
  return {
    ...entry,
    summary: clip(entry.summary, LIMITS.summary),
    location: clip(entry.location, LIMITS.location),
    description: clip(entry.description, LIMITS.description),
    conferenceUrl: safeUrl(entry.conferenceUrl),
    organizer: entry.organizer
      ? {
          ...entry.organizer,
          ...(entry.organizer.name
            ? { name: entry.organizer.name.slice(0, LIMITS.name) }
            : {}),
        }
      : null,
    attendees: entry.attendees.map((attendee) => ({
      ...attendee,
      name: clip(attendee.name, LIMITS.name),
    })),
  };
}

/** 招待として読む添付か。text/calendar を優先し、次に名前が .ics のもの。 */
function invitePriority(file: {
  filename: string | null;
  contentType: string;
}): number {
  const type = file.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "text/calendar") return 2;
  if (type === "application/ics" || /\.ics$/i.test(file.filename ?? "")) {
    return 1;
  }
  return 0;
}

/**
 * メールを利用者の ID で探し、招待の添付を読む。メールが無ければ 404。招待として読めなければ
 * invite: null (表示もしない)。
 */
export async function loadMessageInvite(
  deps: { db: Database; hub: EventsHub; dir: string },
  userId: string,
  messageId: string,
): Promise<LoadInviteResult> {
  const { db, hub, dir } = deps;
  // 1. メールを利用者の ID で探す。
  const [message] = await db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      from: messages.from,
      senderCheck: messages.senderCheck,
      sentAt: messages.sentAt,
      receivedAt: messages.receivedAt,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(and(eq(messages.id, messageId), eq(accounts.userId, userId)));
  if (!message) return { ok: false, status: 404, error: "not_found" };

  // 2. 対象の添付を 1 つ選ぶ。
  const files = await db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      contentType: attachments.contentType,
      size: attachments.size,
    })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.partId));
  const candidate = files
    .filter((file) => invitePriority(file) > 0)
    .sort((a, b) => invitePriority(b) - invitePriority(a))[0];
  if (!candidate || candidate.size > MAX_INVITE_BYTES) {
    return { ok: true, invite: null };
  }

  // 3. 実体を用意して読む。
  const result = await ensureReceivedAttachment(
    { db, hub, dir },
    userId,
    messageId,
    candidate.id,
  );
  if (!result.ok) {
    return {
      ok: false,
      status: statusOfFetchError(result.error),
      error: result.error,
    };
  }
  const path = attachmentPath(dir, result.attachment.storageKey);
  // 申告の大きさが小さくても、実体が大きければ読まない (メモリに載せない)。
  const size = await stat(path)
    .then((info) => info.size)
    .catch(() => null);
  if (size === null) return { ok: false, status: 502, error: "fetch_failed" };
  if (size > MAX_INVITE_BYTES) return { ok: true, invite: null };
  const content = await readFile(path).catch(() => null);
  if (!content) return { ok: false, status: 502, error: "fetch_failed" };
  if (content.byteLength > MAX_INVITE_BYTES) return { ok: true, invite: null };

  // 4. 先頭の UID の予定 (原本があれば原本、無ければ最初の例外) を使う。
  let parsed: ParsedCalendar;
  try {
    parsed = parseICalendar(content.toString("utf8"), {
      defaultTimeZone: "UTC",
      maxEvents: 100,
      maxLines: MAX_INVITE_LINES,
    });
  } catch {
    return { ok: true, invite: null };
  }
  const uid = parsed.events[0]?.uid;
  // 長すぎる UID は扱わない (索引の行の大きさを超えて 500 になるため。指摘 5)。
  if (!uid || uid.length > LIMITS.uid) return { ok: true, invite: null };
  // 同じ回が重なっていれば先の方を使う。
  const seen = new Set<string>();
  const picked: ParsedEvent[] = [];
  for (const event of parsed.events) {
    if (event.uid !== uid) continue;
    const key = event.recurrenceId ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = sanitizeEntry(event);
    if (!entry) return { ok: true, invite: null };
    picked.push(entry);
  }
  const master = picked.find((entry) => entry.recurrenceId === null);
  const primary = master ?? picked[0];
  if (!primary) return { ok: true, invite: null };
  // 原本の無い招待は、先頭の 1 回だけを扱う (7.3 の「繰り返さない 1 件の予定」。同じ UID の
  // 親の無い行を複数作ると、CalDAV に同じ UID のリソースが 2 つ積まれるため。指摘 9)。
  const entries = master ? picked : [primary];
  return {
    ok: true,
    invite: {
      message: {
        id: message.id,
        accountId: message.accountId,
        fromAddress: message.from[0]?.address
          ? lower(message.from[0].address)
          : null,
        senderCheck: message.senderCheck,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      method: parsed.method,
      uid,
      entries,
      primary,
    },
  };
}

/** 差出人の認証の結果 (messages.senderCheck から)。 */
export function senderAuth(
  check: InviteMessage["senderCheck"],
): InviteSenderAuth {
  // 信頼する判定サーバーとの照合を入れる前の結果は使わない (取り直すまで確認中)。
  if (!isCurrentSenderCheck(check)) return "pending";
  if (
    check.warnings.includes("dmarc_fail") ||
    check.warnings.includes("auth_fail")
  ) {
    return "failed";
  }
  return check.verified ? "verified" : "unknown";
}

/**
 * 招待を取り込める・反映できるカレンダーか (7.2、未決 11 の推奨 A)。書き込めて、scheduling が
 * mail か none の、Orbit 内か CalDAV のカレンダー。CalDAV は自動スケジュールでないと
 * 分かっているもの (autoSchedule === false) だけ。まだ調べていない (不明) ものは入れない
 * (実は自動スケジュールなら、サーバーが主催者へ返事を送り直すおそれ。指摘 6)。
 */
export function isMailSideCalendar(
  calendar: Pick<
    CalendarRow,
    "source" | "readOnly" | "accountId" | "providerState"
  >,
  writable: ReadonlySet<string>,
): boolean {
  if (calendar.readOnly) return false;
  if (calendar.source === "local") return true;
  return (
    calendar.source === "caldav" &&
    writable.has("caldav") &&
    calendar.accountId !== null &&
    calendar.providerState?.autoSchedule === false
  );
}

/** サービスが招待を配るカレンダー (Google、Microsoft、自動スケジュールの CalDAV) で、書き込めるもの。 */
function isServerCalendar(
  calendar: Pick<
    CalendarRow,
    "source" | "readOnly" | "accountId" | "providerState"
  >,
  writable: ReadonlySet<string>,
): boolean {
  if (calendar.readOnly || calendar.accountId === null) return false;
  if (!writable.has(calendar.source)) return false;
  return (
    calendar.source === "google" ||
    calendar.source === "microsoft" ||
    (calendar.source === "caldav" &&
      calendar.providerState?.autoSchedule === true)
  );
}

/** 予定の行と、そのカレンダー。 */
type Candidate = { event: EventRow; calendar: CalendarRow };

/** inspectInvite が決めた、実行する対象 (apply が使う)。 */
type InvitePlan =
  | { kind: "none" }
  | { kind: "import" }
  | { kind: "update"; calendar: CalendarRow; target: EventRow }
  | { kind: "remove"; calendar: CalendarRow; target: EventRow }
  | {
      kind: "apply_reply";
      calendar: CalendarRow;
      target: EventRow;
      attendee: AttendeeRow;
      status: "accepted" | "tentative" | "declined";
      comment: string | null;
      stamp: Date;
      sequence: number;
    };

/** 招待の判定の結果。GET の応答 (fields) と、apply の対象 (plan)。 */
export type InviteInspection = {
  fields: MessageInviteImipFields;
  plan: InvitePlan;
  /** 対象の予定 (done で apply が返す eventId にも使う)。 */
  eventId: string | null;
};

type Base = Pick<MessageInviteImipFields, "dtstamp" | "sender" | "calendars">;

function result(
  base: Base,
  action: InviteAction,
  actionState: InviteActionState,
  blocked: InviteBlocked | null,
  options: {
    plan?: InvitePlan;
    eventId?: string | null;
    confirmReason?: InviteConfirmReason | null;
  } = {},
): InviteInspection {
  return {
    fields: {
      ...base,
      action,
      actionState,
      blocked,
      confirmReason:
        actionState === "confirm" ? (options.confirmReason ?? null) : null,
    },
    plan: options.plan ?? { kind: "none" },
    eventId: options.eventId ?? null,
  };
}

/** 利用者のすべてのメールアカウントのアドレスと、そのメールを受け取ったアカウントのアドレス。 */
async function userAddresses(
  db: Executor,
  userId: string,
  receivingAccountId: string,
) {
  const rows = await db
    .select({
      id: accounts.id,
      email: accounts.email,
      username: accounts.username,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const all = new Set<string>();
  let receiving = new Set<string>();
  for (const row of rows) {
    const own = ownAddresses(row);
    for (const address of own) all.add(address);
    if (row.id === receivingAccountId) receiving = own;
  }
  return { all, receiving };
}

type UserAddresses = Awaited<ReturnType<typeof userAddresses>>;

/**
 * 取り込む予定の self にする参加者のアドレス (7.3、指摘 7)。
 * - CalDAV: そのカレンダーの「自分」(アカウントのアドレスと送信元。calendarIdentities) にある
 *   参加者だけ。書き戻した後の読み直しで、同期は同じアドレスで self を決めるため、ほかのアドレスを
 *   self にしても消えてしまう。
 * - Orbit 内: メールを受け取ったアカウント → カレンダーの送信元 → 利用者のほかのアカウントの順。
 * どれにも無ければ null (self なしで取り込み、出欠は返せない)。
 */
function selfAddressFor(
  entry: ParsedEvent,
  calendar: Pick<CalendarRow, "source">,
  identity: CalendarIdentity | undefined,
  addresses: UserAddresses,
): string | null {
  const find = (set: ReadonlySet<string> | undefined) =>
    set
      ? (entry.attendees.find((attendee) => set.has(lower(attendee.email)))
          ?.email ?? null)
      : null;
  if (calendar.source === "caldav") return find(identity?.addresses);
  return (
    find(addresses.receiving) ??
    find(identity?.addresses) ??
    find(addresses.all)
  );
}

/** 主催者が自分か (inviteRole の organizer)。印が無ければカレンダーのアカウントのアドレスで決める。 */
async function isOrganizerRow(
  db: Executor,
  candidate: Candidate,
  attendees: readonly { email: string; self: boolean }[],
): Promise<boolean> {
  const { event, calendar } = candidate;
  let organizer = event.organizer
    ? { ...event.organizer, self: event.organizer.self }
    : null;
  if (organizer && typeof organizer.self !== "boolean") {
    let addresses = new Set<string>();
    if (calendar.accountId) {
      const [account] = await db
        .select({ email: accounts.email, username: accounts.username })
        .from(accounts)
        .where(eq(accounts.id, calendar.accountId));
      if (account) addresses = ownAddresses(account);
    }
    organizer = { ...organizer, self: addresses.has(lower(organizer.email)) };
  }
  return inviteRole({ organizer, attendees }) === "organizer";
}

/** 比べる時刻 (DTSTAMP)。無ければ null。 */
function stampOf(entry: ParsedEvent): Date | null {
  if (!entry.dtstamp) return null;
  const time = Date.parse(entry.dtstamp);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * 招待の新旧 (7.1): SEQUENCE が大きい、または同じで DTSTAMP が新しければ newer。
 * 同じなら same、古ければ older。
 */
function compareInvite(
  entry: ParsedEvent,
  row: Pick<EventRow, "sequence" | "inviteStamp">,
): "newer" | "same" | "older" {
  if (entry.sequence > row.sequence) return "newer";
  if (entry.sequence < row.sequence) return "older";
  const stamp = stampOf(entry);
  if (!stamp || !row.inviteStamp) return "same";
  const diff = stamp.getTime() - row.inviteStamp.getTime();
  if (diff > 0) return "newer";
  return diff < 0 ? "older" : "same";
}

/** 同じ回か (RECURRENCE-ID の書き方の違いを無視する)。null は原本。 */
function sameRecurrence(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalizeRecurrenceId(a) === normalizeRecurrenceId(b);
}

/**
 * 招待全体の新旧。原本 (primary) が古ければ older。原本が同じでも、例外のどれか 1 つが
 * カレンダーの同じ回の行 (無ければ原本の行) より新しければ newer (指摘 14)。
 */
function compareWholeInvite(
  entries: readonly ParsedEvent[],
  primary: ParsedEvent,
  found: Candidate,
  rows: readonly Candidate[],
): "newer" | "same" | "older" {
  const order = compareInvite(primary, found.event);
  if (order !== "same") return order;
  for (const entry of entries) {
    if (entry === primary || entry.recurrenceId === null) continue;
    const row = rows.find(
      (candidate) =>
        candidate.calendar.id === found.calendar.id &&
        candidate.event.parentId === found.event.id &&
        sameRecurrence(candidate.event.recurrenceId, entry.recurrenceId),
    );
    if (compareInvite(entry, row?.event ?? found.event) === "newer") {
      return "newer";
    }
  }
  return "same";
}

/**
 * 招待のメールについて、いまできる操作を決める (7.1・7.4・8.2)。GET はそのまま返し、
 * apply はトランザクションの中でもう一度呼んで実行する。
 */
export async function inspectInvite(
  db: Executor,
  options: {
    userId: string;
    invite: LoadedInvite;
    writable: ReadonlySet<string>;
    now?: Date;
  },
): Promise<InviteInspection> {
  const { userId, invite, writable } = options;
  const now = options.now ?? new Date();
  const { message, primary, entries, uid } = invite;
  const method = invite.method?.toUpperCase() ?? null;
  const auth = senderAuth(message.senderCheck);
  const from = message.fromAddress;

  // 取り込める先 (import のときだけ返す)。
  const own = await db
    .select()
    .from(calendars)
    .where(eq(calendars.userId, userId))
    .orderBy(asc(calendars.sortOrder), asc(calendars.createdAt));
  const targets = own.filter((row) => isMailSideCalendar(row, writable));

  // 利用者の、同じ UID の予定 (どのカレンダーでも)。
  const rows = await db
    .select({ event: events, calendar: calendars })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(
      and(
        eq(events.userId, userId),
        eq(calendars.userId, userId),
        eq(events.uid, uid),
      ),
    );
  // 同じアカウントのカレンダーを先に。
  rows.sort(
    (a, b) =>
      Number(b.calendar.accountId === message.accountId) -
      Number(a.calendar.accountId === message.accountId),
  );
  const mailSide = rows.filter((row) =>
    isMailSideCalendar(row.calendar, writable),
  );
  const onServer = rows.some((row) => isServerCalendar(row.calendar, writable));

  const dtstamp = primary.dtstamp ?? null;
  const replying =
    method === "REPLY"
      ? primary.attendees.length === 1
        ? primary.attendees[0]
        : (primary.attendees.find(
            (attendee) => from !== null && lower(attendee.email) === from,
          ) ?? primary.attendees[0])
      : undefined;
  const claimed =
    method === "REPLY" ? replying?.email : primary.organizer?.email;
  const base: Base = {
    dtstamp,
    sender: {
      email: from ?? "",
      matches: from !== null && !!claimed && lower(claimed) === from,
      auth,
    },
    calendars: [],
  };

  if (method === "REPLY") {
    return inspectReply(db, {
      base,
      invite,
      replying,
      mailSide,
      onServer,
      writable,
      now,
    });
  }
  if (method !== "REQUEST" && method !== "CANCEL") {
    return result(base, "none", "blocked", "unsupported_method");
  }
  const organizer = primary.organizer;
  // ORGANIZER の無い招待、代理 (SENT-BY) の招待は扱わない (2.2)。
  if (!organizer || organizer.sentBy) {
    return result(base, "none", "blocked", "unsupported_method");
  }
  const addresses = await userAddresses(db, userId, message.accountId);
  const ownEvent = addresses.all.has(lower(organizer.email));

  // カレンダーにある、メールの予定に当たる行 (原本の招待なら原本、1 回だけなら同じ回)。
  const hasMaster = entries.some((entry) => entry.recurrenceId === null);
  const pick = (recurrenceId: string | null) =>
    mailSide.find((row) =>
      sameRecurrence(row.event.recurrenceId, recurrenceId),
    );
  let found: Candidate | undefined = hasMaster
    ? pick(null)
    : pick(primary.recurrenceId);
  let occurrenceOfMaster = false;
  if (!found && !hasMaster) {
    // 1 回だけの招待で、例外の行が無く原本がある。
    found = pick(null);
    occurrenceOfMaster = found !== undefined;
  }
  // 既にある予定を変える操作は、送信元を確認できたときだけそのまま実行できる。認証の結果が
  // 無い (unknown) ときは、主催者からの連絡か確かめてもらう (指摘 2)。
  const changeState = (
    jump: boolean,
  ): { state: InviteActionState; reason: InviteConfirmReason | null } =>
    auth !== "verified"
      ? { state: "confirm", reason: "sender_unverified" }
      : jump
        ? { state: "confirm", reason: "sequence_jump" }
        : { state: "ready", reason: null };

  if (method === "CANCEL") {
    if (!found) {
      // 消す予定が無い (取り消し済み、取り込んでいない)。
      return result(
        base,
        "remove",
        onServer ? "blocked" : "done",
        onServer ? "server_calendar" : null,
      );
    }
    const eventId = found.event.id;
    if (occurrenceOfMaster) {
      const exdates = (found.event.exdates ?? []).map(normalizeRecurrenceId);
      const recurrenceId = normalizeRecurrenceId(primary.recurrenceId ?? "");
      if (exdates.includes(recurrenceId)) {
        return result(base, "remove", "done", null, { eventId });
      }
    }
    const blocked = await existingChecks(db, found, {
      ownEvent,
      auth,
      from,
      organizerEmail: organizer.email,
    });
    if (blocked) {
      return result(base, "remove", "blocked", blocked, { eventId });
    }
    if (primary.sequence < found.event.sequence) {
      return result(base, "remove", "stale", null, { eventId });
    }
    const { state, reason } = changeState(false);
    return result(base, "remove", state, null, {
      plan: { kind: "remove", calendar: found.calendar, target: found.event },
      eventId,
      confirmReason: reason,
    });
  }

  // REQUEST
  if (found && occurrenceOfMaster) {
    // 例外の行が無い回の変更は対象外 (未決 7 の推奨 A)。
    return result(base, "update", "blocked", "occurrence_unsupported", {
      eventId: found.event.id,
    });
  }
  if (found) {
    const eventId = found.event.id;
    const order = compareWholeInvite(entries, primary, found, mailSide);
    if (order !== "newer") {
      return result(base, "update", order === "same" ? "done" : "stale", null, {
        eventId,
      });
    }
    const blocked = await existingChecks(db, found, {
      ownEvent,
      auth,
      from,
      organizerEmail: organizer.email,
    });
    if (blocked) {
      return result(base, "update", "blocked", blocked, { eventId });
    }
    const { state, reason } = changeState(
      primary.sequence > found.event.sequence + SEQUENCE_JUMP,
    );
    return result(base, "update", state, null, {
      plan: { kind: "update", calendar: found.calendar, target: found.event },
      eventId,
      confirmReason: reason,
    });
  }
  if (onServer) {
    // サービスのカレンダーにある予定は、サービスが更新する (8a のまま、返事だけ)。
    return result(base, "none", "blocked", "server_calendar");
  }

  // 新しく追加 (7.3・7.4)。
  const identities = await calendarIdentities(
    db,
    targets.map((row) => row.id),
  );
  const addressed =
    selfAddressFor(primary, { source: "local" }, undefined, addresses) !== null;
  // 自分宛ての招待なら、自分を self にできない CalDAV のカレンダーは既定にしない (指摘 7)。
  const usable = (row: CalendarRow) =>
    !addressed ||
    selfAddressFor(primary, row, identities.get(row.id), addresses) !== null;
  const candidates = targets.map((row) => ({ id: row.id, default: false }));
  const preferred =
    targets.find(
      (row) =>
        usable(row) &&
        (row.imipAccountId === message.accountId ||
          row.accountId === message.accountId),
    ) ??
    targets.find((row) => row.source === "local") ??
    targets.find(usable);
  for (const entry of candidates) entry.default = entry.id === preferred?.id;
  const withCalendars = { ...base, calendars: candidates };
  if (ownEvent) return result(withCalendars, "import", "blocked", "own_event");
  if (candidates.length === 0) {
    return result(withCalendars, "import", "blocked", "no_calendar");
  }
  if (auth === "pending") {
    // 送信元の確認が済むまでは追加しない (画面は「送信元を確認中です」)。
    return result(withCalendars, "import", "blocked", "sender_unverified");
  }
  return result(
    withCalendars,
    "import",
    auth === "failed" ? "confirm" : "ready",
    null,
    { plan: { kind: "import" }, confirmReason: "sender_failed" },
  );
}

/**
 * 既にある予定を変える (更新・取り消し) ときの差出人の検査 (7.4)。外れたら理由を返す。
 * 比べる相手はメールの ORGANIZER ではなく、カレンダーにある予定の主催者アドレス。
 */
async function existingChecks(
  db: Executor,
  found: Candidate,
  options: {
    ownEvent: boolean;
    auth: InviteSenderAuth;
    from: string | null;
    organizerEmail: string;
  },
): Promise<InviteBlocked | null> {
  const attendees = await db
    .select({ email: eventAttendees.email, self: eventAttendees.self })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, found.event.id));
  if (options.ownEvent || (await isOrganizerRow(db, found, attendees))) {
    return "own_event";
  }
  if (options.auth === "pending" || options.auth === "failed") {
    return "sender_unverified";
  }
  const stored = found.event.organizer?.email;
  if (
    !stored ||
    options.from === null ||
    lower(stored) !== options.from ||
    lower(options.organizerEmail) !== lower(stored)
  ) {
    return "sender_mismatch";
  }
  return null;
}

const REPLY_STATUSES = new Set(["accepted", "tentative", "declined"]);

/** REPLY の検査 (8.2)。上から順に当てはめ、1 つでも外れたら反映しない。 */
async function inspectReply(
  db: Executor,
  options: {
    base: Base;
    invite: LoadedInvite;
    replying: ParsedEvent["attendees"][number] | undefined;
    mailSide: Candidate[];
    onServer: boolean;
    writable: ReadonlySet<string>;
    now: Date;
  },
): Promise<InviteInspection> {
  const { base, invite, replying, mailSide, onServer, writable, now } = options;
  const { message, primary } = invite;
  const from = message.fromAddress;
  // 1. 返事をした ATTENDEE。
  if (!replying) return result(base, "none", "blocked", "unsupported_method");
  // 2. From = その ATTENDEE のアドレス。代理 (SENT-BY) は認めない。
  if (from === null || lower(replying.email) !== from || replying.sentBy) {
    return result(base, "apply_reply", "blocked", "sender_mismatch");
  }
  // 3. 送信元の認証が取れていて、失敗していない。
  if (base.sender.auth === "pending" || base.sender.auth === "failed") {
    return result(base, "apply_reply", "blocked", "sender_unverified");
  }
  // 4. 自分が主催する予定 (原本、無ければ同じ回の親の無い行)。
  const organizedOf = async (
    accept: (candidate: Candidate) => boolean,
  ): Promise<{ candidate: Candidate; attendees: AttendeeRow[] } | null> => {
    for (const candidate of mailSide) {
      if (!accept(candidate)) continue;
      const attendees = await db
        .select()
        .from(eventAttendees)
        .where(eq(eventAttendees.eventId, candidate.event.id));
      if (await isOrganizerRow(db, candidate, attendees)) {
        return { candidate, attendees };
      }
    }
    return null;
  };
  const organized =
    (await organizedOf((row) => row.event.recurrenceId === null)) ??
    (primary.recurrenceId !== null
      ? await organizedOf(
          (row) =>
            row.event.parentId === null &&
            row.event.recurrenceId !== null &&
            sameRecurrence(row.event.recurrenceId, primary.recurrenceId),
        )
      : null);
  if (!organized) {
    return onServer
      ? result(base, "apply_reply", "blocked", "server_calendar")
      : result(base, "none", "blocked", null);
  }
  // 4 の続き: カレンダーの scheduling が mail (Orbit が招待をメールで送る) のときだけ反映する
  // (送信元の無いカレンダー・自動スケジュールか不明の CalDAV は返事を受け取る立場にない。指摘 12)。
  const organizedCalendar = organized.candidate.calendar;
  const scheduling = await loadSchedulingInfo(
    db,
    organizedCalendar,
    !isMailSideCalendar(organizedCalendar, writable),
  );
  if (scheduling.scheduling !== "mail") {
    return result(base, "none", "blocked", null, {
      eventId: organized.candidate.event.id,
    });
  }
  // 6. この回だけの返事なら、その回の例外の行がある。
  let target = organized.candidate.event;
  let attendees = organized.attendees;
  if (primary.recurrenceId !== null && target.recurrenceId === null) {
    const masterId = target.id;
    const exception = mailSide.find(
      (row) =>
        row.event.parentId === masterId &&
        row.event.recurrenceId !== null &&
        sameRecurrence(row.event.recurrenceId, primary.recurrenceId),
    );
    if (!exception) {
      return result(base, "apply_reply", "blocked", "occurrence_unsupported", {
        eventId: target.id,
      });
    }
    target = exception.event;
    attendees = await db
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, target.id));
  }
  const eventId = target.id;
  // 5. ATTENDEE がその予定の参加者にいる。
  const attendee = attendees.find(
    (row) => lower(row.email) === lower(replying.email),
  );
  if (!attendee) {
    return result(base, "apply_reply", "blocked", "not_attendee_of_event", {
      eventId,
    });
  }
  // 7. SEQUENCE が予定と同じ。
  if (primary.sequence !== target.sequence) {
    return result(base, "apply_reply", "stale", null, { eventId });
  }
  // 8. DTSTAMP (無ければメールの日時) が、前に反映した返事より新しい。メールを受け取った時刻より
  //    先の DTSTAMP は受け取った時刻に丸め、それでも未来すぎるものは断る。
  let stamp = stampOf(primary) ?? message.sentAt ?? message.receivedAt;
  if (stamp.getTime() > message.receivedAt.getTime()) {
    stamp = message.receivedAt;
  }
  if (stamp.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    return result(base, "apply_reply", "stale", null, { eventId });
  }
  if (attendee.repliedAt && stamp.getTime() <= attendee.repliedAt.getTime()) {
    return result(base, "apply_reply", "done", null, { eventId });
  }
  // 9. PARTSTAT が accepted / tentative / declined。
  if (!REPLY_STATUSES.has(replying.status)) {
    return result(base, "apply_reply", "blocked", "unsupported_method", {
      eventId,
    });
  }
  // 自動では反映しない (いつもボタン)。送信元の確認済みは、受信サーバーが RFC 8601 のとおりに
  // 偽のヘッダーを消しているかに頼るため、利用者の目を通らない書き換えの根拠にしない (指摘 1 の B・D)。
  return result(base, "apply_reply", "ready", null, {
    plan: {
      kind: "apply_reply",
      calendar: organizedCalendar,
      target,
      attendee,
      status: replying.status as "accepted" | "tentative" | "declined",
      comment: primary.comment
        ? primary.comment.slice(0, RSVP_COMMENT_MAX)
        : null,
      stamp,
      sequence: primary.sequence,
    },
    eventId,
  });
}

/* ------------------------------------------------------------------ */
/* 実行                                                                */
/* ------------------------------------------------------------------ */

/** apply の結果。error は 409 (InviteApplyErrorCode) か、カレンダーの状態。 */
export type ApplyOutcome =
  | { ok: true; applied: boolean; eventId: string | null }
  | {
      ok: false;
      status: 404 | 409;
      error:
        | InviteBlocked
        | "changed"
        | "not_found"
        | "calendar_disabled"
        | "calendar_sync_stopped";
    };

/** 書き込む項目 (fieldUpdatedAt の鍵)。busy と通知は利用者のものなので書かない。 */
const INVITE_FIELDS = [
  "summary",
  "location",
  "description",
  "status",
  "time",
  "recurrence",
  "conferenceUrl",
  "attendees",
] as const;
type InviteField = (typeof INVITE_FIELDS)[number];

/** 予定の行に入れる、主催者が決める項目 (event-rows.ts の形。calendars.ts と同じ変換を通す)。 */
function inviteFields(entry: ParsedEvent): EventFieldsInput {
  const master = entry.recurrenceId === null;
  return {
    summary: entry.summary,
    location: entry.location,
    description: entry.description,
    status: entry.status,
    // sanitizeEntry が、終日なら日付、時刻付きなら開始があることを確かめている。
    time: entry.allDay
      ? {
          allDay: true,
          startDate: entry.startDate as string,
          endDate: entry.endDate as string,
        }
      : {
          allDay: false,
          startAt: entry.startAt as string,
          endAt: entry.endAt ?? (entry.startAt as string),
          startTimeZone: entry.startTimeZone,
          endTimeZone: entry.endTimeZone,
        },
    recurrence: master
      ? { rrule: entry.rrule, rdates: entry.rdates, exdates: entry.exdates }
      : { rrule: null, rdates: null, exdates: null },
    conferenceUrl: entry.conferenceUrl,
  };
}

/** 主催者・SEQUENCE・DTSTAMP (項目の外の列)。 */
function inviteMeta(entry: ParsedEvent) {
  return {
    organizer: entry.organizer
      ? {
          email: entry.organizer.email,
          ...(entry.organizer.name ? { name: entry.organizer.name } : {}),
          self: false,
        }
      : null,
    sequence: entry.sequence,
    inviteStamp: stampOf(entry),
  };
}

/** self の行の出欠の扱い。undefined の項目は、いまの行から引き継ぐ (replaceEventExtras)。 */
type SelfKeep = Pick<EventAttendeeInput, "status" | "comment" | "repliedAt">;

/**
 * 参加者 (event-rows.ts の形)。ほかの参加者の出欠は主催者が書いた値。self の出欠は keep の値、
 * keep に無い項目は、inherit なら同じアドレスのいまの行から引き継ぎ (replaceEventExtras)、
 * そうでなければ (新しい行) 招待に書かれた値。同じアドレスの重なりは replaceEventExtras がまとめる。
 */
function inviteAttendees(
  entry: ParsedEvent,
  selfAddress: string | null,
  keep: SelfKeep,
  inherit: boolean,
): EventAttendeeInput[] {
  const self = selfAddress === null ? null : lower(selfAddress);
  return entry.attendees.map((attendee) =>
    lower(attendee.email) === self
      ? {
          email: attendee.email,
          name: attendee.name,
          role: attendee.role,
          self: true,
          ...(inherit ? {} : { status: attendee.status }),
          ...keep,
        }
      : {
          email: attendee.email,
          name: attendee.name,
          role: attendee.role,
          status: attendee.status,
          self: false,
        },
  );
}

/** 変更の書き戻し (CalDAV)。冪等キーのハッシュは、その回の DTSTAMP と SEQUENCE から作る。 */
async function enqueueInviteUpdate(
  tx: Tx,
  calendar: CalendarRow,
  row: Pick<EventRow, "id" | "fieldUpdatedAt">,
  fields: readonly InviteField[],
  marker: Record<string, unknown>,
) {
  await enqueueEventUpdate(
    tx,
    calendar,
    row,
    Object.fromEntries(fields.map((field) => [field, marker])),
  );
}

/** expect と、done のときに「もう済んでいる」とみなす action の組。 */
function sameRequest(expect: InviteApplyExpect, action: InviteAction): boolean {
  if (expect === action) return true;
  // 取り込んだ直後に、同じ招待の「追加」がもう一度届いた (二度押し、再送)。
  return expect === "import" && action === "update";
}

/**
 * 招待を反映する (POST /v1/messages/:id/invite/apply)。サーバーが添付を読み直して操作を決め、
 * expect と違えば changed。何度呼んでも結果は同じ (済んでいれば applied: false)。
 */
export async function applyInvite(
  db: Database,
  options: {
    userId: string;
    invite: LoadedInvite;
    writable: ReadonlySet<string>;
    expect: InviteApplyExpect;
    calendarId?: string;
    confirmed?: boolean;
    now?: Date;
  },
): Promise<ApplyOutcome> {
  const { userId, invite, writable, expect } = options;
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    // 同じ招待の apply を順番に (二度押しで 2 件作らない)。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`invite:${userId}:${invite.uid}`}, 0))`,
    );
    const inspection = await inspectInvite(tx, {
      userId,
      invite,
      writable,
      now,
    });
    const { action, actionState, blocked } = inspection.fields;
    if (!sameRequest(expect, action)) {
      return { ok: false, status: 409, error: "changed" } as const;
    }
    if (actionState === "done" || actionState === "stale") {
      return { ok: true, applied: false, eventId: inspection.eventId } as const;
    }
    if (actionState === "blocked") {
      return { ok: false, status: 409, error: blocked ?? "changed" } as const;
    }
    if (actionState === "confirm" && options.confirmed !== true) {
      // 確認 (送信元を確認できていない、SEQUENCE の大きな飛び) を経ていない。
      return { ok: false, status: 409, error: "sender_unverified" } as const;
    }
    const plan = inspection.plan;
    switch (plan.kind) {
      case "import":
        return importInvite(tx, {
          userId,
          invite,
          writable,
          calendarId:
            options.calendarId ??
            inspection.fields.calendars.find((entry) => entry.default)?.id,
          now,
        });
      case "update":
        return updateInvite(tx, { userId, invite, plan, now });
      case "remove":
        return removeInvite(tx, { userId, invite, plan, now });
      case "apply_reply":
        return applyReply(tx, { userId, plan, now });
      default:
        return { ok: false, status: 409, error: "changed" } as const;
    }
  });
}

/**
 * 書き換える予定の行をロックし、判定のときに読んだ行から変わっていないか確かめる
 * (同時の PATCH・同期と排他する。calendars.ts の lockEventForWrite と同じ順)。
 */
async function lockUnchanged(
  tx: Tx,
  userId: string,
  target: EventRow,
): Promise<EventRow | null> {
  const row = await lockEventForWrite(tx, userId, target.id);
  if (
    !row ||
    row.calendarId !== target.calendarId ||
    row.sequence !== target.sequence ||
    (row.inviteStamp?.getTime() ?? null) !==
      (target.inviteStamp?.getTime() ?? null) ||
    (row.organizer?.email ?? null) !== (target.organizer?.email ?? null)
  ) {
    return null;
  }
  return row;
}

/** 7.3: メールの REQUEST から予定を作る。 */
async function importInvite(
  tx: Tx,
  options: {
    userId: string;
    invite: LoadedInvite;
    writable: ReadonlySet<string>;
    calendarId: string | undefined;
    now: Date;
  },
): Promise<ApplyOutcome> {
  const { userId, invite, writable, now } = options;
  if (!options.calendarId) {
    return { ok: false, status: 409, error: "no_calendar" };
  }
  const [calendar] = await tx
    .select()
    .from(calendars)
    .where(
      and(eq(calendars.id, options.calendarId), eq(calendars.userId, userId)),
    );
  if (!calendar) return { ok: false, status: 404, error: "not_found" };
  if (!isMailSideCalendar(calendar, writable)) {
    return {
      ok: false,
      status: 409,
      error: isServerCalendar(calendar, writable)
        ? "server_calendar"
        : "no_calendar",
    };
  }
  const blocked = await providerWriteBlocked(tx, calendar);
  if (blocked) return { ok: false, status: 409, error: blocked };
  if (isProviderCalendar(calendar)) {
    await lockCalendarAccount(tx, calendar.accountId);
  }
  // self は取り込み先が決まってから選ぶ (指摘 7)。
  const addresses = await userAddresses(tx, userId, invite.message.accountId);
  const identity = (await calendarIdentities(tx, [calendar.id])).get(
    calendar.id,
  );
  const selfAddress = selfAddressFor(
    invite.primary,
    calendar,
    identity,
    addresses,
  );

  const at = now.toISOString();
  const fieldUpdatedAt = Object.fromEntries(
    [...INVITE_FIELDS, "busy"].map((key) => [key, at]),
  );
  const ordered = [...invite.entries].sort(
    (a, b) => Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null),
  );
  const hasMaster = ordered[0]?.recurrenceId === null;

  // 先に 1 回だけの招待で入れた、親の無い例外の行 (同じカレンダー・同じ UID) は、原本の招待で
  // 置き換える (指摘 8)。同じ回が招待にあればその内容で作り直し、無ければ原本の繰り返しに任せる。
  // 自分の出欠は、その回の SEQUENCE が変わっていなければ引き継ぐ。
  const orphanSelf = new Map<string, SelfKeep>();
  const removed: string[] = [];
  if (hasMaster) {
    const orphans = await tx
      .select()
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendar.id),
          eq(events.uid, invite.uid),
          isNull(events.parentId),
          isNotNull(events.recurrenceId),
        ),
      )
      .for("update");
    for (const orphan of orphans) {
      const entry = ordered.find((item) =>
        sameRecurrence(item.recurrenceId, orphan.recurrenceId),
      );
      const [self] = await tx
        .select()
        .from(eventAttendees)
        .where(
          and(
            eq(eventAttendees.eventId, orphan.id),
            eq(eventAttendees.self, true),
          ),
        );
      if (entry && self && entry.sequence === orphan.sequence) {
        orphanSelf.set(normalizeRecurrenceId(orphan.recurrenceId as string), {
          status: self.status,
          comment: self.comment,
        });
      }
      removed.push(orphan.id);
    }
    if (removed.length > 0) {
      await tx.delete(events).where(inArray(events.id, removed));
      await cancelPendingWrites(tx, calendar, removed);
      for (const orphan of orphans) {
        await enqueueDelete(tx, calendar, orphan, now);
      }
    }
  }

  let masterId: string | null = null;
  const created: string[] = [];
  const topLevel: string[] = [];
  for (const entry of ordered) {
    const parentId: string | null =
      entry.recurrenceId === null ? null : masterId;
    const keep =
      entry.recurrenceId !== null
        ? orphanSelf.get(normalizeRecurrenceId(entry.recurrenceId))
        : undefined;
    const row = await insertEvent(tx, {
      userId,
      calendarId: calendar.id,
      uid: invite.uid,
      recurrenceId: entry.recurrenceId,
      parentId,
      fields: {
        ...inviteFields(entry),
        busy: entry.busy,
        attendees: inviteAttendees(entry, selfAddress, keep ?? {}, false),
      },
      ...inviteMeta(entry),
      fieldUpdatedAt,
    });
    if (!row) {
      // 同じカレンダーに同じ予定が既にある (ほかの経路で入った)。作らない。
      if (created.length === 0) {
        const [existing] = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(eq(events.calendarId, calendar.id), eq(events.uid, invite.uid)),
          )
          .orderBy(asc(events.recurrenceId));
        return { ok: true, applied: false, eventId: existing?.id ?? null };
      }
      continue;
    }
    if (entry.recurrenceId === null) masterId = row.id;
    if (parentId === null) topLevel.push(row.id);
    created.push(row.id);
  }
  await recordChanges(tx, userId, "event", removed, "delete");
  await recordChanges(tx, userId, "event", created);
  // CalDAV なら作成を書き戻す (原本が例外もまとめて書く)。取り込みでは招待メールを送らない。
  for (const id of topLevel) {
    await enqueueEventOperation(
      tx,
      calendar,
      {
        kind: "event_create",
        payload: { eventId: id, calendarId: calendar.id },
      },
      eventCreateKey(id),
    );
  }
  return {
    ok: true,
    applied: true,
    eventId: topLevel[0] ?? created[0] ?? null,
  };
}

/** 7.1: 取り込んだ予定を、新しい REQUEST で上書きする。 */
async function updateInvite(
  tx: Tx,
  options: {
    userId: string;
    invite: LoadedInvite;
    plan: Extract<InvitePlan, { kind: "update" }>;
    now: Date;
  },
): Promise<ApplyOutcome> {
  const { userId, invite, plan, now } = options;
  const { calendar } = plan;
  const blocked = await providerWriteBlocked(tx, calendar);
  if (blocked) return { ok: false, status: 409, error: blocked };
  if (!(await lockUnchanged(tx, userId, plan.target))) {
    return { ok: false, status: 409, error: "changed" };
  }
  const at = now.toISOString();
  const hasMaster = invite.entries.some((entry) => entry.recurrenceId === null);
  const existing = await tx
    .select()
    .from(events)
    .where(and(eq(events.calendarId, calendar.id), eq(events.uid, invite.uid)))
    .for("update");
  const master = hasMaster
    ? existing.find((row) => row.recurrenceId === null)
    : undefined;
  const rowOf = (entry: ParsedEvent) =>
    existing.find(
      (row) =>
        sameRecurrence(row.recurrenceId, entry.recurrenceId) &&
        (entry.recurrenceId === null ||
          row.parentId === (master?.id ?? null) ||
          row.id === plan.target.id),
    );
  const masterSelf = master ? await selfOf(tx, master.id) : undefined;
  const touched: string[] = [];
  for (const entry of invite.entries) {
    const row = rowOf(entry);
    const fields = INVITE_FIELDS.filter(
      (field) => field !== "recurrence" || entry.recurrenceId === null,
    );
    const marker = { stamp: entry.dtstamp, sequence: entry.sequence };
    if (!row) {
      // 原本の招待に入っていた新しい例外。1 回だけの招待では、ここには来ない。
      if (!master) continue;
      const fieldUpdatedAt = Object.fromEntries(
        [...fields, "busy"].map((key) => [key, at]),
      );
      const inserted = await insertEvent(tx, {
        userId,
        calendarId: calendar.id,
        uid: invite.uid,
        recurrenceId: entry.recurrenceId,
        parentId: master.id,
        fields: {
          ...inviteFields(entry),
          busy: master.busy,
          useDefaultReminders: master.useDefaultReminders,
          attendees: inviteAttendees(
            entry,
            masterSelf?.email ?? null,
            {},
            false,
          ),
        },
        ...inviteMeta(entry),
        fieldUpdatedAt,
      });
      if (!inserted) continue;
      touched.push(inserted.id);
      await enqueueInviteUpdate(tx, calendar, inserted, fields, marker);
      continue;
    }
    const fieldUpdatedAt = {
      ...(row.fieldUpdatedAt ?? {}),
      ...Object.fromEntries(fields.map((key) => [key, at])),
    };
    await tx
      .update(events)
      .set({
        ...eventFieldColumns(inviteFields(entry)),
        ...inviteMeta(entry),
        fieldUpdatedAt,
      })
      .where(eq(events.id, row.id));
    // 自分の出欠は残す (replaceEventExtras が同じアドレスの行から引き継ぐ)。SEQUENCE が
    // 上がっていれば (時刻などの変更) 未返信に戻す。
    const selfRow = await selfOf(tx, row.id);
    const keep: SelfKeep =
      entry.sequence > row.sequence
        ? { status: "needs_action", comment: null, repliedAt: null }
        : {};
    await replaceEventExtras(tx, row.id, {
      attendees: inviteAttendees(entry, selfRow?.email ?? null, keep, true),
    });
    touched.push(row.id);
    await enqueueInviteUpdate(
      tx,
      calendar,
      { id: row.id, fieldUpdatedAt },
      fields,
      marker,
    );
  }
  const removed: string[] = [];
  if (master && calendar.source === "local") {
    // 原本の招待に入っていない例外は、主催者が取りやめた (Orbit 内のカレンダーだけ)。
    // CalDAV では、例外の VEVENT だけをリソースから取り除く書き戻しが無い (回の削除は EXDATE を
    // 足して回そのものを消してしまう) ので、残す (指摘 13。読み直しで戻らないようにするため)。
    for (const row of existing) {
      if (
        row.parentId === master.id &&
        !invite.entries.some((entry) =>
          sameRecurrence(entry.recurrenceId, row.recurrenceId),
        )
      ) {
        removed.push(row.id);
      }
    }
    if (removed.length > 0) {
      await tx.delete(events).where(inArray(events.id, removed));
    }
  }
  await recordChanges(tx, userId, "event", touched);
  await recordChanges(tx, userId, "event", removed, "delete");
  return { ok: true, applied: true, eventId: plan.target.id };
}

async function selfOf(tx: Tx, eventId: string) {
  const [row] = await tx
    .select()
    .from(eventAttendees)
    .where(
      and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.self, true)),
    );
  return row;
}

/** 7.1・未決 12 の推奨 A: CANCEL で予定を消す。RECURRENCE-ID 付きなら、その回だけ消す。 */
async function removeInvite(
  tx: Tx,
  options: {
    userId: string;
    invite: LoadedInvite;
    plan: Extract<InvitePlan, { kind: "remove" }>;
    now: Date;
  },
): Promise<ApplyOutcome> {
  const { userId, invite, plan, now } = options;
  const { calendar } = plan;
  const blocked = await providerWriteBlocked(tx, calendar);
  if (blocked) return { ok: false, status: 409, error: blocked };
  const target = await lockUnchanged(tx, userId, plan.target);
  if (!target) return { ok: false, status: 409, error: "changed" };
  const occurrence = invite.primary.recurrenceId;
  if (occurrence !== null && target.recurrenceId === null) {
    // 原本の 1 回を取り消す: EXDATE に足し、その回の例外があれば消す (calendars.ts の回の削除と同じ)。
    const recurrenceId = normalizeRecurrenceId(occurrence);
    await excludeOccurrence(tx, calendar, target, recurrenceId, now);
    const removed = await tx
      .delete(events)
      .where(
        and(
          eq(events.parentId, target.id),
          eq(events.recurrenceId, recurrenceId),
        ),
      )
      .returning({ id: events.id });
    await cancelPendingWrites(
      tx,
      calendar,
      removed.map((row) => row.id),
    );
    await recordChanges(tx, userId, "event", [target.id]);
    await recordChanges(
      tx,
      userId,
      "event",
      removed.map((row) => row.id),
      "delete",
    );
    return { ok: true, applied: true, eventId: target.id };
  }
  let master: EventRow | undefined;
  if (target.parentId && target.recurrenceId) {
    // 例外の行の取り消し = その回を消す。原本の EXDATE に足す。
    master = await lockEventForWrite(tx, userId, target.parentId);
    if (master) {
      await excludeOccurrence(tx, calendar, master, target.recurrenceId, now);
      await recordChanges(tx, userId, "event", [master.id]);
    }
  }
  const removed = await tx
    .delete(events)
    .where(
      and(
        eq(events.userId, userId),
        or(eq(events.id, target.id), eq(events.parentId, target.id)),
      ),
    )
    .returning({ id: events.id });
  await cancelPendingWrites(
    tx,
    calendar,
    removed.map((row) => row.id),
  );
  if (!master) await enqueueDelete(tx, calendar, target, now);
  await recordChanges(
    tx,
    userId,
    "event",
    removed.map((row) => row.id),
    "delete",
  );
  return { ok: true, applied: true, eventId: target.id };
}

/** 8.3: REPLY を参加者の出欠に反映する。CalDAV なら PARTSTAT を書き戻す (招待メールは送らない)。 */
async function applyReply(
  tx: Tx,
  options: {
    userId: string;
    plan: Extract<InvitePlan, { kind: "apply_reply" }>;
    now: Date;
  },
): Promise<ApplyOutcome> {
  const { userId, plan, now } = options;
  const { calendar } = plan;
  const blocked = await providerWriteBlocked(tx, calendar);
  if (blocked) return { ok: false, status: 409, error: blocked };
  const row = await lockEventForWrite(tx, userId, plan.target.id);
  if (!row || row.sequence !== plan.sequence) {
    return { ok: false, status: 409, error: "changed" };
  }
  await tx
    .update(eventAttendees)
    .set({
      status: plan.status,
      comment: plan.comment,
      repliedAt: plan.stamp,
      replySequence: plan.sequence,
    })
    .where(eq(eventAttendees.id, plan.attendee.id));
  const fieldUpdatedAt = {
    ...(row.fieldUpdatedAt ?? {}),
    attendees: now.toISOString(),
  };
  await tx.update(events).set({ fieldUpdatedAt }).where(eq(events.id, row.id));
  await recordChanges(tx, userId, "event", [row.id]);
  await enqueueInviteUpdate(
    tx,
    calendar,
    { id: row.id, fieldUpdatedAt },
    ["attendees"],
    {
      reply: plan.attendee.email,
      status: plan.status,
      stamp: plan.stamp.toISOString(),
    },
  );
  return { ok: true, applied: true, eventId: row.id };
}
