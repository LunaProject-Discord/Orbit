import { readFile } from "node:fs/promises";
import {
  attachmentPath,
  calendarScheduling,
  type InviteAction,
  type InviteActionState,
  type InviteApplyExpect,
  type InviteBlocked,
  type InviteSenderAuth,
  inviteRole,
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
  outbox,
} from "@orbit/db";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { ownAddresses } from "./calendar-identity.js";
import { recordChanges } from "./changes.js";
import {
  enqueueEventOperation,
  eventCreateKey,
  eventDeleteKey,
  eventUpdateKey,
  isProviderCalendar,
  lockCalendarAccount,
} from "./event-outbox.js";
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

/** REPLY の DTSTAMP が、いまよりこれ以上先なら断る (8.2 の 8)。 */
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

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
  const content = await readFile(
    attachmentPath(dir, result.attachment.storageKey),
  ).catch(() => null);
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
  if (!uid) return { ok: true, invite: null };
  // 同じ回が重なっていれば先の方を使う。
  const seen = new Set<string>();
  const entries = parsed.events.filter((event) => {
    if (event.uid !== uid) return false;
    const key = event.recurrenceId ?? "";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const primary =
    entries.find((entry) => entry.recurrenceId === null) ?? entries[0];
  if (!primary) return { ok: true, invite: null };
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
  if (!check) return "pending";
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
 * mail か none の、Orbit 内か CalDAV (自動スケジュールでない) のカレンダー。
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
    calendar.providerState?.autoSchedule !== true
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
  return calendarScheduling(calendar) === "server";
}

/** 予定の行と、そのカレンダー。 */
type Candidate = { event: EventRow; calendar: CalendarRow };

/** inspectInvite が決めた、実行する対象 (apply が使う)。 */
type InvitePlan =
  | { kind: "none" }
  | {
      kind: "import";
      /** self にする参加者のアドレス。無ければ null (出欠は返せない)。 */
      selfAddress: string | null;
    }
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

const result = (
  base: Pick<MessageInviteImipFields, "dtstamp" | "sender" | "calendars">,
  action: InviteAction,
  actionState: InviteActionState,
  blocked: InviteBlocked | null,
  plan: InvitePlan = { kind: "none" },
  eventId: string | null = null,
): InviteInspection => ({
  fields: { ...base, action, actionState, blocked },
  plan,
  eventId,
});

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
  const base = {
    dtstamp,
    sender: {
      email: from ?? "",
      matches: from !== null && !!claimed && lower(claimed) === from,
      auth,
    },
    calendars: [] as MessageInviteImipFields["calendars"],
  };

  if (method === "REPLY") {
    return inspectReply(db, {
      base,
      invite,
      replying,
      mailSide,
      onServer,
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
    mailSide.find((row) => row.event.recurrenceId === recurrenceId);
  let found: Candidate | undefined = hasMaster
    ? pick(null)
    : pick(primary.recurrenceId);
  let occurrenceOfMaster = false;
  if (!found && !hasMaster) {
    // 1 回だけの招待で、例外の行が無く原本がある。
    found = pick(null);
    occurrenceOfMaster = found !== undefined;
  }

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
    if (occurrenceOfMaster) {
      const exdates = (found.event.exdates ?? []).map(normalizeRecurrenceId);
      const recurrenceId = normalizeRecurrenceId(primary.recurrenceId ?? "");
      if (exdates.includes(recurrenceId)) {
        return result(
          base,
          "remove",
          "done",
          null,
          { kind: "none" },
          found.event.id,
        );
      }
    }
    const blocked = await existingChecks(db, found, {
      ownEvent,
      auth,
      from,
      organizerEmail: organizer.email,
    });
    if (blocked) {
      return result(
        base,
        "remove",
        "blocked",
        blocked,
        { kind: "none" },
        found.event.id,
      );
    }
    if (primary.sequence < found.event.sequence) {
      return result(
        base,
        "remove",
        "stale",
        null,
        { kind: "none" },
        found.event.id,
      );
    }
    return result(
      base,
      "remove",
      "ready",
      null,
      { kind: "remove", calendar: found.calendar, target: found.event },
      found.event.id,
    );
  }

  // REQUEST
  if (found && occurrenceOfMaster) {
    // 例外の行が無い回の変更は対象外 (未決 7 の推奨 A)。
    return result(
      base,
      "update",
      "blocked",
      "occurrence_unsupported",
      { kind: "none" },
      found.event.id,
    );
  }
  if (found) {
    const order = compareInvite(primary, found.event);
    if (order !== "newer") {
      return result(
        base,
        "update",
        order === "same" ? "done" : "stale",
        null,
        { kind: "none" },
        found.event.id,
      );
    }
    const blocked = await existingChecks(db, found, {
      ownEvent,
      auth,
      from,
      organizerEmail: organizer.email,
    });
    if (blocked) {
      return result(
        base,
        "update",
        "blocked",
        blocked,
        { kind: "none" },
        found.event.id,
      );
    }
    return result(
      base,
      "update",
      "ready",
      null,
      { kind: "update", calendar: found.calendar, target: found.event },
      found.event.id,
    );
  }
  if (onServer) {
    // サービスのカレンダーにある予定は、サービスが更新する (8a のまま、返事だけ)。
    return result(base, "none", "blocked", "server_calendar");
  }

  // 新しく追加 (7.3・7.4)。
  const candidates = targets.map((row) => ({ id: row.id, default: false }));
  const preferred =
    targets.find(
      (row) =>
        row.imipAccountId === message.accountId ||
        row.accountId === message.accountId,
    ) ??
    targets.find((row) => row.source === "local") ??
    targets[0];
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
  const selfAddress =
    primary.attendees.find((attendee) =>
      addresses.receiving.has(lower(attendee.email)),
    )?.email ??
    primary.attendees.find((attendee) =>
      addresses.all.has(lower(attendee.email)),
    )?.email ??
    null;
  return result(
    withCalendars,
    "import",
    auth === "failed" ? "confirm" : "ready",
    null,
    { kind: "import", selfAddress },
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
    base: Pick<MessageInviteImipFields, "dtstamp" | "sender" | "calendars">;
    invite: LoadedInvite;
    replying: ParsedEvent["attendees"][number] | undefined;
    mailSide: Candidate[];
    onServer: boolean;
    now: Date;
  },
): Promise<InviteInspection> {
  const { base, invite, replying, mailSide, onServer, now } = options;
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
  // 4. 自分が主催する予定 (原本)。
  let organized: { candidate: Candidate; attendees: AttendeeRow[] } | null =
    null;
  for (const candidate of mailSide) {
    if (candidate.event.recurrenceId !== null) continue;
    const attendees = await db
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, candidate.event.id));
    if (await isOrganizerRow(db, candidate, attendees)) {
      organized = { candidate, attendees };
      break;
    }
  }
  if (!organized) {
    // 1 回だけの (親の無い) 予定を主催している場合。
    for (const candidate of mailSide) {
      if (candidate.event.parentId !== null) continue;
      if (candidate.event.recurrenceId !== primary.recurrenceId) continue;
      const attendees = await db
        .select()
        .from(eventAttendees)
        .where(eq(eventAttendees.eventId, candidate.event.id));
      if (await isOrganizerRow(db, candidate, attendees)) {
        organized = { candidate, attendees };
        break;
      }
    }
  }
  if (!organized) {
    return onServer
      ? result(base, "apply_reply", "blocked", "server_calendar")
      : result(base, "none", "blocked", null);
  }
  // 6. この回だけの返事なら、その回の例外の行がある。
  let target = organized.candidate.event;
  let attendees = organized.attendees;
  if (primary.recurrenceId !== null && target.recurrenceId === null) {
    const recurrenceId = normalizeRecurrenceId(primary.recurrenceId);
    const exception = mailSide.find(
      (row) =>
        row.event.parentId === target.id &&
        row.event.recurrenceId !== null &&
        normalizeRecurrenceId(row.event.recurrenceId) === recurrenceId,
    );
    if (!exception) {
      return result(
        base,
        "apply_reply",
        "blocked",
        "occurrence_unsupported",
        { kind: "none" },
        target.id,
      );
    }
    target = exception.event;
    attendees = await db
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, target.id));
  }
  // 5. ATTENDEE がその予定の参加者にいる。
  const attendee = attendees.find(
    (row) => lower(row.email) === lower(replying.email),
  );
  if (!attendee) {
    return result(
      base,
      "apply_reply",
      "blocked",
      "not_attendee_of_event",
      { kind: "none" },
      target.id,
    );
  }
  // 7. SEQUENCE が予定と同じ。
  if (primary.sequence !== target.sequence) {
    return result(
      base,
      "apply_reply",
      "stale",
      null,
      { kind: "none" },
      target.id,
    );
  }
  // 8. DTSTAMP (無ければメールの日時) が、前に反映した返事より新しい。未来すぎるものは断る。
  const stamp = stampOf(primary) ?? message.sentAt ?? message.receivedAt;
  if (stamp.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    return result(
      base,
      "apply_reply",
      "stale",
      null,
      { kind: "none" },
      target.id,
    );
  }
  if (attendee.repliedAt && stamp.getTime() <= attendee.repliedAt.getTime()) {
    return result(
      base,
      "apply_reply",
      "done",
      null,
      { kind: "none" },
      target.id,
    );
  }
  // 9. PARTSTAT が accepted / tentative / declined。
  if (!REPLY_STATUSES.has(replying.status)) {
    return result(
      base,
      "apply_reply",
      "blocked",
      "unsupported_method",
      { kind: "none" },
      target.id,
    );
  }
  return result(
    base,
    "apply_reply",
    base.sender.auth === "verified" ? "auto" : "ready",
    null,
    {
      kind: "apply_reply",
      calendar: organized.candidate.calendar,
      target,
      attendee,
      status: replying.status as "accepted" | "tentative" | "declined",
      comment: primary.comment
        ? primary.comment.slice(0, RSVP_COMMENT_MAX)
        : null,
      stamp,
      sequence: primary.sequence,
    },
    target.id,
  );
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

/** 予定の行に入れる、主催者が決める項目。 */
function inviteColumns(entry: ParsedEvent) {
  const master = entry.recurrenceId === null;
  return {
    summary: entry.summary,
    location: entry.location,
    description: entry.description,
    status: entry.status,
    allDay: entry.allDay,
    startAt: entry.startAt ? new Date(entry.startAt) : null,
    endAt: entry.endAt ? new Date(entry.endAt) : null,
    startDate: entry.startDate,
    endDate: entry.endDate,
    startTimeZone: entry.startTimeZone,
    endTimeZone: entry.endTimeZone,
    rrule: master ? entry.rrule : null,
    rdates: master ? entry.rdates : null,
    exdates: master ? entry.exdates : null,
    organizer: entry.organizer
      ? {
          email: entry.organizer.email,
          ...(entry.organizer.name ? { name: entry.organizer.name } : {}),
          self: false,
        }
      : null,
    sequence: entry.sequence,
    conferenceUrl: entry.conferenceUrl,
    inviteStamp: stampOf(entry),
  };
}

/** 参加者の行 (同じアドレスは 1 行に)。selfAddress に self を付ける。keep は self の行の出欠を残す。 */
function attendeeRows(
  eventId: string,
  entry: ParsedEvent,
  selfAddress: string | null,
  keep?: { status: AttendeeRow["status"]; comment: string | null } | null,
): (typeof eventAttendees.$inferInsert)[] {
  const seen = new Set<string>();
  const rows: (typeof eventAttendees.$inferInsert)[] = [];
  for (const attendee of entry.attendees) {
    const key = lower(attendee.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const self = selfAddress !== null && key === lower(selfAddress);
    rows.push({
      eventId,
      email: attendee.email,
      name: attendee.name,
      role: attendee.role,
      status: self && keep ? keep.status : attendee.status,
      self,
      ...(self && keep ? { comment: keep.comment } : {}),
    });
  }
  return rows;
}

async function providerWriteBlocked(
  tx: Tx,
  calendar: CalendarRow,
): Promise<"calendar_disabled" | "calendar_sync_stopped" | null> {
  if (!isProviderCalendar(calendar)) return null;
  const [account] = await tx
    .select({
      calendarEnabled: accounts.calendarEnabled,
      calendarError: accounts.calendarError,
    })
    .from(accounts)
    .where(eq(accounts.id, calendar.accountId));
  if (!account || !account.calendarEnabled) return "calendar_disabled";
  if (account.calendarError !== null) return "calendar_sync_stopped";
  return null;
}

/** 変更の書き戻しを積む (CalDAV のカレンダーだけ。calendars.ts の enqueueUpdate と同じ形)。 */
async function enqueueUpdate(
  tx: Tx,
  calendar: CalendarRow,
  row: Pick<EventRow, "id">,
  fields: (typeof INVITE_FIELDS)[number][],
  fieldUpdatedAt: Record<string, string>,
  values: Record<string, unknown>,
) {
  const sorted = [...fields].sort();
  await enqueueEventOperation(
    tx,
    calendar,
    {
      kind: "event_update",
      payload: { eventId: row.id, calendarId: calendar.id, fields: sorted },
    },
    eventUpdateKey(row.id, sorted, fieldUpdatedAt, values),
  );
}

/** 消した予定に向けた、まだ実行していない作成と変更の書き戻しを取り消す (calendars.ts と同じ)。 */
async function cancelPendingWrites(
  tx: Tx,
  calendar: CalendarRow,
  eventIds: string[],
) {
  if (!isProviderCalendar(calendar) || eventIds.length === 0) return;
  await tx
    .delete(outbox)
    .where(
      and(
        eq(outbox.accountId, calendar.accountId),
        or(
          and(
            inArray(outbox.kind, ["event_create", "event_update"]),
            eq(outbox.status, "pending"),
          ),
          and(eq(outbox.kind, "event_create"), eq(outbox.status, "failed")),
        ),
        inArray(sql<string>`${outbox.payload}->>'eventId'`, eventIds),
      ),
    );
}

/** 予定 (原本か単発) を消したときの書き戻しを積む (calendars.ts の enqueueDelete と同じ)。 */
async function enqueueDelete(
  tx: Tx,
  calendar: CalendarRow,
  row: EventRow,
  deletedAt: Date,
) {
  if (!isProviderCalendar(calendar)) return;
  if (row.remoteId === null) {
    const [running] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.accountId, calendar.accountId),
          eq(outbox.idempotencyKey, eventCreateKey(row.id)),
          eq(outbox.status, "processing"),
        ),
      );
    if (!running) return;
  }
  await enqueueEventOperation(
    tx,
    calendar,
    {
      kind: "event_delete",
      payload: {
        calendarId: calendar.id,
        target: {
          eventId: row.id,
          calendarId: calendar.id,
          remoteId: row.remoteId,
          etag: row.etag,
          uid: row.uid,
          recurrenceId: row.recurrenceId,
          parentRemoteId: null,
        },
        deletedAt: deletedAt.toISOString(),
      },
    },
    eventDeleteKey(row.id),
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
      return { ok: false, status: 409, error: "sender_unverified" } as const;
    }
    const plan = inspection.plan;
    switch (plan.kind) {
      case "import":
        return importInvite(tx, {
          userId,
          invite,
          writable,
          selfAddress: plan.selfAddress,
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

/** 7.3: メールの REQUEST から予定を作る。 */
async function importInvite(
  tx: Tx,
  options: {
    userId: string;
    invite: LoadedInvite;
    writable: ReadonlySet<string>;
    selfAddress: string | null;
    calendarId: string | undefined;
    now: Date;
  },
): Promise<ApplyOutcome> {
  const { userId, invite, writable, selfAddress, now } = options;
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
  const at = now.toISOString();
  const fieldUpdatedAt = Object.fromEntries(
    [...INVITE_FIELDS, "busy"].map((key) => [key, at]),
  );
  const ordered = [...invite.entries].sort(
    (a, b) => Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null),
  );
  let masterId: string | null = null;
  const created: string[] = [];
  const topLevel: string[] = [];
  for (const entry of ordered) {
    const parentId: string | null =
      entry.recurrenceId === null ? null : masterId;
    const [row]: { id: string }[] = await tx
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: invite.uid,
        recurrenceId: entry.recurrenceId,
        parentId,
        ...inviteColumns(entry),
        busy: entry.busy,
        fieldUpdatedAt,
      })
      .onConflictDoNothing()
      .returning({ id: events.id });
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
    const attendees = attendeeRows(row.id, entry, selfAddress);
    if (attendees.length > 0) await tx.insert(eventAttendees).values(attendees);
  }
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
  if (isProviderCalendar(calendar)) {
    await lockCalendarAccount(tx, calendar.accountId);
  }
  const at = now.toISOString();
  const hasMaster = invite.entries.some((entry) => entry.recurrenceId === null);
  const existing = await tx
    .select()
    .from(events)
    .where(and(eq(events.calendarId, calendar.id), eq(events.uid, invite.uid)))
    .for("update");
  const byRecurrence = new Map(
    existing.map((row) => [row.recurrenceId ?? "", row]),
  );
  const master = hasMaster ? byRecurrence.get("") : undefined;
  const touched: string[] = [];
  for (const entry of invite.entries) {
    const row = byRecurrence.get(entry.recurrenceId ?? "");
    const fields = INVITE_FIELDS.filter(
      (field) => field !== "recurrence" || entry.recurrenceId === null,
    );
    if (!row) {
      // 原本の招待に入っていた新しい例外。1 回だけの招待では、ここには来ない。
      if (!master) continue;
      const fieldUpdatedAt = Object.fromEntries(
        [...fields, "busy"].map((key) => [key, at]),
      );
      const [inserted] = await tx
        .insert(events)
        .values({
          userId,
          calendarId: calendar.id,
          uid: invite.uid,
          recurrenceId: entry.recurrenceId,
          parentId: master.id,
          ...inviteColumns(entry),
          busy: master.busy,
          useDefaultReminders: master.useDefaultReminders,
          fieldUpdatedAt,
        })
        .returning({ id: events.id });
      if (!inserted) continue;
      const selfRow = await selfOf(tx, master.id);
      await insertAttendees(
        tx,
        inserted.id,
        entry,
        selfRow?.email ?? null,
        null,
      );
      touched.push(inserted.id);
      await enqueueUpdate(tx, calendar, inserted, fields, fieldUpdatedAt, {
        stamp: entry.dtstamp,
        sequence: entry.sequence,
      });
      continue;
    }
    const fieldUpdatedAt = {
      ...(row.fieldUpdatedAt ?? {}),
      ...Object.fromEntries(fields.map((key) => [key, at])),
    };
    await tx
      .update(events)
      .set({ ...inviteColumns(entry), fieldUpdatedAt })
      .where(eq(events.id, row.id));
    // 自分の出欠は残す。SEQUENCE が上がっていれば (時刻などの変更) 未返信に戻す。
    const selfRow = await selfOf(tx, row.id);
    const keep = selfRow
      ? entry.sequence > row.sequence
        ? { status: "needs_action" as const, comment: null }
        : { status: selfRow.status, comment: selfRow.comment }
      : null;
    await tx.delete(eventAttendees).where(eq(eventAttendees.eventId, row.id));
    await insertAttendees(tx, row.id, entry, selfRow?.email ?? null, keep);
    touched.push(row.id);
    await enqueueUpdate(tx, calendar, row, fields, fieldUpdatedAt, {
      stamp: entry.dtstamp,
      sequence: entry.sequence,
    });
  }
  const removed: string[] = [];
  if (master && calendar.source === "local") {
    // 原本の招待に入っていない例外は、主催者が取りやめた (Orbit 内のカレンダーだけ)。
    const wanted = new Set(
      invite.entries.map((entry) => entry.recurrenceId ?? ""),
    );
    for (const row of existing) {
      if (row.parentId === master.id && !wanted.has(row.recurrenceId ?? "")) {
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

async function insertAttendees(
  tx: Tx,
  eventId: string,
  entry: ParsedEvent,
  selfAddress: string | null,
  keep: { status: AttendeeRow["status"]; comment: string | null } | null,
) {
  const rows = attendeeRows(eventId, entry, selfAddress, keep);
  if (rows.length > 0) await tx.insert(eventAttendees).values(rows);
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
  const { calendar, target } = plan;
  const blocked = await providerWriteBlocked(tx, calendar);
  if (blocked) return { ok: false, status: 409, error: blocked };
  if (isProviderCalendar(calendar)) {
    await lockCalendarAccount(tx, calendar.accountId);
  }
  const occurrence = invite.primary.recurrenceId;
  if (occurrence !== null && target.recurrenceId === null) {
    // 原本の 1 回を取り消す: EXDATE に足し、その回の例外があれば消す。
    const recurrenceId = normalizeRecurrenceId(occurrence);
    const [master] = await tx
      .select()
      .from(events)
      .where(eq(events.id, target.id))
      .for("update");
    if (!master) return { ok: true, applied: false, eventId: null };
    const exdates = [...new Set([...(master.exdates ?? []), recurrenceId])];
    const fieldUpdatedAt = {
      ...(master.fieldUpdatedAt ?? {}),
      recurrence: now.toISOString(),
    };
    await tx
      .update(events)
      .set({ exdates, fieldUpdatedAt })
      .where(eq(events.id, master.id));
    const removed = await tx
      .delete(events)
      .where(
        and(
          eq(events.parentId, master.id),
          eq(events.recurrenceId, recurrenceId),
        ),
      )
      .returning({ id: events.id });
    await cancelPendingWrites(
      tx,
      calendar,
      removed.map((row) => row.id),
    );
    await enqueueEventOperation(
      tx,
      calendar,
      {
        kind: "event_update",
        payload: {
          eventId: master.id,
          calendarId: calendar.id,
          fields: ["recurrence"],
        },
      },
      eventUpdateKey(master.id, ["recurrence"], fieldUpdatedAt, {
        recurrence: { exdates },
      }),
    );
    await recordChanges(tx, userId, "event", [master.id]);
    await recordChanges(
      tx,
      userId,
      "event",
      removed.map((row) => row.id),
      "delete",
    );
    return { ok: true, applied: true, eventId: master.id };
  }
  let master: EventRow | undefined;
  if (target.parentId && target.recurrenceId) {
    // 例外の行の取り消し = その回を消す。原本の EXDATE に足す。
    [master] = await tx
      .select()
      .from(events)
      .where(eq(events.id, target.parentId))
      .for("update");
    if (master) {
      const exdates = [
        ...new Set([...(master.exdates ?? []), target.recurrenceId]),
      ];
      const fieldUpdatedAt = {
        ...(master.fieldUpdatedAt ?? {}),
        recurrence: now.toISOString(),
      };
      await tx
        .update(events)
        .set({ exdates, fieldUpdatedAt })
        .where(eq(events.id, master.id));
      await enqueueEventOperation(
        tx,
        calendar,
        {
          kind: "event_update",
          payload: {
            eventId: master.id,
            calendarId: calendar.id,
            fields: ["recurrence"],
          },
        },
        eventUpdateKey(master.id, ["recurrence"], fieldUpdatedAt, {
          recurrence: { exdates },
        }),
      );
      await recordChanges(tx, userId, "event", [master.id]);
    }
  }
  const removed = await tx
    .delete(events)
    .where(or(eq(events.id, target.id), eq(events.parentId, target.id)))
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
  const { calendar, target } = plan;
  const blocked = await providerWriteBlocked(tx, calendar);
  if (blocked) return { ok: false, status: 409, error: blocked };
  if (isProviderCalendar(calendar)) {
    await lockCalendarAccount(tx, calendar.accountId);
  }
  const [row] = await tx
    .select()
    .from(events)
    .where(eq(events.id, target.id))
    .for("update");
  if (!row) return { ok: false, status: 409, error: "changed" };
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
  await enqueueUpdate(tx, calendar, row, ["attendees"], fieldUpdatedAt, {
    reply: plan.attendee.email,
    status: plan.status,
    stamp: plan.stamp.toISOString(),
  });
  return { ok: true, applied: true, eventId: row.id };
}
