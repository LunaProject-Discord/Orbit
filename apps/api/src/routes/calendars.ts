import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  ATTENDEE_EDITABLE_FIELDS,
  CALENDAR_WRITEBACK_SOURCES,
  calendarNotifies,
  calendarNotifyDefault,
  changedEventFields,
  correctClientTime,
  correctClientTimes,
  type EventFieldSource,
  type EventTiming,
  eventFieldValues,
  expandOccurrences,
  HOLIDAYS_VERSION,
  holidayEvents,
  type ImipEvent,
  type ImipPlan,
  type InviteErrorCode,
  type InvitePerson,
  type InviteRole,
  inviteRole,
  isSendableAccount,
  loadSubscription,
  MY_RESPONSE_FIELD,
  normalizeRecurrenceId,
  planImip,
  REMINDER_MAX_MINUTES,
  type RecurrenceException,
  RSVP_COMMENT_MAX,
  reminderMinMinutes,
  subscriptionUrlCandidates,
} from "@orbit/core";
import {
  accounts,
  calendars,
  changes,
  type Database,
  enqueueImip as defaultEnqueueImip,
  type EventWithExtras,
  eventAttendees,
  eventConflicts,
  eventReminders,
  eventSearch,
  events,
  replaceCalendarEvents,
} from "@orbit/db";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import {
  type CalendarIdentity,
  calendarIdentities,
  ownAddresses,
  selfIsMe,
} from "../lib/calendar-identity.js";
import { recordChanges } from "../lib/changes.js";
import {
  assertInviteLimit,
  type CalendarSchedulingInfo,
  InviteLimitError,
  imipEventOf,
  loadEventsWithExtras,
  loadSchedulingInfo,
  loadSeriesWithExtras,
  MAIL_CALENDAR_SOURCES,
  pendingRemovalRecipients,
  recordInviteFailed,
  schedulingInfo,
  withRemovalCancels,
} from "../lib/event-imip.js";
import {
  cancelPendingWrites,
  enqueueDelete,
  enqueueEventOperation,
  enqueueEventUpdate,
  eventCreateKey,
  eventDeleteKey,
  excludeOccurrence,
  isProviderCalendar,
  lockCalendarAccount,
  lockEventForWrite,
  providerWriteBlocked,
} from "../lib/event-outbox.js";
import {
  dispatchInvites as dispatchImip,
  type EventExtras,
  isWritable,
  loadExtras,
  resolveOrganizer,
  respondToEvent,
  roleOf,
} from "../lib/event-respond.js";
import {
  eventFieldColumns,
  insertEvent,
  replaceEventExtras,
} from "../lib/event-rows.js";
import {
  loadSenderAccounts,
  pickImipSenderForAddress,
  type SenderAccount,
} from "../lib/imip-sender.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EventRow = typeof events.$inferSelect;
type CalendarRow = typeof calendars.$inferSelect;

/** 1 人が持てるカレンダーの数。 */
const MAX_CALENDARS = 500;
/** 一度に取得できる期間 (日)。 */
const MAX_RANGE_DAYS = 400;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z.string().min(1).max(100).refine(isTimeZone, {
  message: "タイムゾーンの名前が正しくありません。",
});
const plainDate = z.iso.date();
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();

const idParam = z.object({ id: z.uuid() });
const occurrenceParam = z.object({
  id: z.uuid(),
  recurrenceId: z.string().min(1).max(40),
});

const calendarCreate = z.object({
  name: z.string().trim().min(1).max(200),
  color: color.default(null),
  timeZone: timeZone.nullable().default(null),
});

const subscriptionCreate = z.object({
  url: z.string().trim().min(1).max(2000),
  /** 空なら、カレンダーに書かれた名前 (X-WR-CALNAME) か URL のホスト名。 */
  name: z.string().trim().max(200).optional(),
  color: color.default(null),
  /** 浮動時刻 (タイムゾーン無し) の予定を読むときのタイムゾーン。端末のタイムゾーンを送る。 */
  timeZone: timeZone.default("Asia/Tokyo"),
});

/** 既定のリマインダーの数の上限 (Google と同じ 5 件)。 */
const MAX_DEFAULT_REMINDERS = 5;
/**
 * 既定のリマインダーを Orbit が持つカレンダー。Google は相手側の値が正で、CalDAV と Microsoft は
 * 同期のたびに null で上書きされる (packages/db の upsertAccountCalendars) ので含めない。
 */
const OWN_DEFAULT_REMINDER_SOURCES: ReadonlySet<string> = new Set([
  "local",
  "ics",
]);

const calendarPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).nullable(),
    color,
    timeZone: timeZone.nullable(),
    visible: z.boolean(),
    sortOrder: z.number().int().min(0).max(1_000_000).nullable(),
    /** CalDAV / ICS の確認間隔 (秒)。null は既定。 */
    pollIntervalSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400)
      .nullable(),
    /**
     * 招待メールの送信元に選ぶメールアカウント (Orbit 内と CalDAV のカレンダーだけ)。null は自動。
     */
    imipAccountId: z.uuid().nullable(),
    /** 予定の通知 (段取り 9)。null は種類ごとの既定 (購読・祝日・誕生日はオフ、ほかはオン)。 */
    notify: z.boolean().nullable(),
    /**
     * 既定のリマインダー。相手側に既定を持たないカレンダー (Orbit 内と購読) だけ変えられる。
     * null と空の配列は「既定の通知なし」。
     */
    defaultReminders: z
      .array(
        z.object({
          method: z.enum(["display", "email"]),
          minutes: z.number().int().min(0).max(REMINDER_MAX_MINUTES),
        }),
      )
      .max(MAX_DEFAULT_REMINDERS)
      .nullable(),
  })
  .partial();

/** 予定の時刻。終日は日付 (endDate はその日を含まない)、時刻付きは ISO 8601 とタイムゾーン。 */
const timing = z
  .discriminatedUnion("allDay", [
    z.object({
      allDay: z.literal(true),
      startDate: plainDate,
      endDate: plainDate,
    }),
    z.object({
      allDay: z.literal(false),
      startAt: z.iso.datetime({ offset: true }),
      endAt: z.iso.datetime({ offset: true }),
      startTimeZone: timeZone.nullable(),
      endTimeZone: timeZone.nullable().optional(),
    }),
  ])
  .refine(
    (value) =>
      value.allDay
        ? value.endDate > value.startDate
        : Date.parse(value.endAt) >= Date.parse(value.startAt),
    { message: "終わりが始まりより前です。" },
  );

/** 暦にある日付か (2026-02-30 などを断る)。 */
function validDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

/**
 * 回の ID: 日付 (YYYY-MM-DD) か、オフセット付きの日時。iCalendar (CalDAV の書き戻しと招待メール)
 * にそのまま書くので、日時として読めない値と制御文字は断る (imip レビュー L7、M5)。
 */
const recurrenceIdValue = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/i.test(
        value,
      ) &&
      validDate(value.slice(0, 10)) &&
      !Number.isNaN(Date.parse(value)),
  );

const recurrence = z.object({
  /**
   * RRULE の値。null で繰り返しをやめる。iCalendar の 1 行にそのまま書くので、規則に使う文字
   * (英数字と = ; , : + -) だけを受け付ける (改行で行を差し込めないように。imip レビュー M5)。
   */
  rrule: z
    .string()
    .max(1000)
    .regex(/^(RRULE:)?FREQ=[A-Z0-9=;,:+-]*$/i)
    .nullable(),
  rdates: z.array(recurrenceIdValue).max(1000).nullable().default(null),
  exdates: z.array(recurrenceIdValue).max(5000).nullable().default(null),
});

/**
 * リマインダー。minutes は開始の何分前か。終日の予定は「開始日の 0:00 から何分前か」で、
 * 負 (当日 0:00 より後。当日 9:00 = -540) を -1439 まで許す。終日以外の予定の負の分は
 * remindersFitTiming で断る (設計 13 章の 1 の B)。
 */
const reminder = z.object({
  method: z.enum(["display", "email"]),
  minutes: z
    .number()
    .int()
    .min(reminderMinMinutes(true))
    .max(40 * 24 * 60),
});

/** リマインダーの分が、予定の種類 (終日か) の範囲に収まるか。終日以外は負を断る。 */
function remindersFitTiming(
  reminders: readonly { minutes: number }[] | undefined,
  allDay: boolean,
): boolean {
  const min = reminderMinMinutes(allDay);
  return (reminders ?? []).every((item) => item.minutes >= min);
}

const NEGATIVE_REMINDER_MESSAGE =
  "開始より後のリマインダーは終日の予定だけで使えます。";

const attendee = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .regex(/^\S+@\S+$/),
  name: z.string().max(300).nullable().default(null),
  role: z
    .enum(["chair", "required", "optional", "non_participant"])
    .default("required"),
});

/** 項目ごとに変えられる内容。time と recurrence は、関係する値をまとめて 1 つの項目として扱う。 */
const eventFields = z
  .object({
    summary: z.string().max(1000).nullable(),
    location: z.string().max(2000).nullable(),
    description: z.string().max(100_000).nullable(),
    status: z.enum(["confirmed", "tentative", "cancelled"]),
    busy: z.boolean(),
    time: timing,
    recurrence,
    // 空白と制御文字 (改行を含む) を含む URL は、URL として読む (改行を黙って除く) 前に断る
    // (iCalendar に行を差し込めないように。imip レビュー M5)。
    conferenceUrl: z
      .string()
      .max(2000)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を断るための正規表現
      .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value))
      .pipe(z.url())
      .nullable(),
    useDefaultReminders: z.boolean(),
    reminders: z.array(reminder).max(20),
    attendees: z.array(attendee).max(500),
  })
  .partial();
type EventFields = z.infer<typeof eventFields>;
type FieldName = keyof EventFields;

const isoTime = z.iso.datetime({ offset: true });

/**
 * 送る瞬間の端末の時刻 (ISO 8601)。付けると、端末の時計のずれ (10 秒を超えるもの) を
 * changedAt などに足して直す (@orbit/core の client-time)。
 */
const clientNow = isoTime.optional();

const eventCreate = eventFields
  .extend({
    /** 端末が決める ID (オフラインで作った予定を、再送しても二重に作らない)。 */
    id: z.uuid().optional(),
    calendarId: z.uuid(),
    time: timing,
    /** 端末で作った時刻。全項目の fieldUpdatedAt になる。無ければ届いた時刻。 */
    changedAt: isoTime.optional(),
    clientNow,
  })
  .strict()
  .refine((value) => remindersFitTiming(value.reminders, value.time.allDay), {
    message: NEGATIVE_REMINDER_MESSAGE,
    path: ["reminders"],
  });

const eventPatch = z.object({
  /** 時刻を一緒に変えるなら、その終日かどうかで負の分を確かめる (無ければ行の値で、処理の中で)。 */
  changes: eventFields
    .strict()
    .refine(
      (value) =>
        value.time === undefined ||
        remindersFitTiming(value.reminders, value.time.allDay),
      { message: NEGATIVE_REMINDER_MESSAGE, path: ["reminders"] },
    ),
  /**
   * 項目ごとの、端末で変えた時刻 (ISO 8601)。無い項目は届いた時刻。
   * サーバーにある同じ項目の変更の方が新しければ、その項目は変えない (rejected で返す)。
   */
  changedAt: z.record(z.string(), isoTime).default({}),
  clientNow,
});

/** POST /events/:id/respond の本文 (段取り 7 で端末と決めた形)。 */
const eventRespond = z.object({
  status: z.enum(["accepted", "tentative", "declined"]),
  /** 省けばいまのコメントを残す。null で消す。 */
  comment: z.string().max(RSVP_COMMENT_MAX).nullable().optional(),
  /** 端末で返事をした時刻。同じ返事の再送は同じ値で送る (outbox の冪等キーになる)。 */
  respondedAt: isoTime,
  clientNow,
});

/** DELETE /events/:id の本文 (省略できる)。 */
const eventDelete = z.object({
  /**
   * 端末で消した時刻。付けると、これより後に変わった項目がある予定は消さずに
   * 409 changed_since を返す。無ければいままでどおり無条件で消す。
   */
  deletedAt: isoTime.optional(),
  clientNow,
});

/** DELETE /events/:id/occurrences/:recurrenceId の本文 (省略できる)。 */
const occurrenceDelete = z.object({
  /**
   * 端末でその回を消した時刻。原本の繰り返しの変更時刻に使う。付けると、その回の例外が
   * これより後に変わっていれば消さずに 409 changed_since を返す。
   */
  changedAt: isoTime.optional(),
  clientNow,
});

const rangeQuery = z.object({
  /** 期間の最初の日と、最後の日の翌日 (timeZone での日付)。 */
  from: plainDate,
  to: plainDate,
  timeZone,
});

const syncQuery = z.object({
  since: z
    .string()
    .regex(/^\d{1,18}$/)
    .default("0"),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 画面に返すカレンダー。同期の位置や変更通知の ID は返さない。 */
function publicCalendar(
  row: CalendarRow,
  writable: ReadonlySet<string>,
  senderAccounts: readonly SenderAccount[],
) {
  const readOnly = row.readOnly || !isWritable(row, writable);
  const info = schedulingInfo(row, readOnly, senderAccounts);
  return {
    id: row.id,
    accountId: row.accountId,
    source: row.source,
    name: row.name,
    description: row.description,
    color: row.color,
    timeZone: row.timeZone,
    readOnly,
    /**
     * 招待の連絡を送れるか (server: サービスが送る、mail: Orbit が招待メールを送る、
     * none: 送れない)。
     */
    scheduling: info.scheduling,
    /** 利用者が選んだ招待メールの送信元。null は自動。 */
    imipAccountId: row.imipAccountId,
    /** 解決した招待メールの送信元 (Orbit 内と CalDAV のカレンダーだけ)。 */
    imipSender: info.sender
      ? { accountId: info.sender.accountId, email: info.sender.email }
      : null,
    /** scheduling が none の理由 (Orbit 内と CalDAV のカレンダーだけ)。 */
    schedulingBlocked: info.blocked,
    visible: row.visible,
    sortOrder: row.sortOrder,
    url: row.url,
    pollIntervalSeconds: row.pollIntervalSeconds,
    defaultReminders: row.defaultReminders ?? [],
    /** 既定のリマインダーを PATCH で変えられるか。 */
    defaultRemindersEditable: OWN_DEFAULT_REMINDER_SOURCES.has(row.source),
    /** 予定の通知が効くか (calendars.notify が null なら種類ごとの既定)。 */
    notify: calendarNotifies(row),
    /** notify を null にしたときの値 (種類ごとの既定)。 */
    notifyDefault: calendarNotifyDefault(row.source),
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function publicEvent(
  row: EventRow,
  extras: EventExtras,
  identity?: CalendarIdentity,
) {
  const organizer = resolveOrganizer(row.organizer, identity?.addresses);
  return {
    id: row.id,
    calendarId: row.calendarId,
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    parentId: row.parentId,
    summary: row.summary,
    location: row.location,
    description: row.description,
    status: row.status,
    busy: row.busy,
    allDay: row.allDay,
    startAt: row.startAt?.toISOString() ?? null,
    endAt: row.endAt?.toISOString() ?? null,
    startDate: row.startDate,
    endDate: row.endDate,
    startTimeZone: row.startTimeZone,
    endTimeZone: row.endTimeZone,
    rrule: row.rrule,
    rdates: row.rdates ?? [],
    exdates: row.exdates ?? [],
    organizer,
    /**
     * 出欠の返事 (POST /events/:id/respond) を受け付ける予定か。招待された予定 (役割が
     * attendee) で、self の行が自分を指しているとき true (レビュー 3)。カレンダーの
     * readOnly、予定の取り消し、同期の停止は含まない (それぞれの値で見る)。
     */
    canRespond:
      inviteRole({ organizer, attendees: extras.attendees }) === "attendee" &&
      selfIsMe(extras.attendees, identity),
    sequence: row.sequence,
    conferenceUrl: row.conferenceUrl,
    useDefaultReminders: row.useDefaultReminders,
    reminders: extras.reminders,
    attendees: extras.attendees,
    fieldUpdatedAt: row.fieldUpdatedAt ?? {},
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function publicEvents(db: Database | Tx, rows: EventRow[]) {
  const [extras, identities] = await Promise.all([
    loadExtras(
      db,
      rows.map((row) => row.id),
    ),
    calendarIdentities(
      db,
      rows.map((row) => row.calendarId),
    ),
  ]);
  return rows.map((row) =>
    publicEvent(
      row,
      extras.get(row.id) ?? { reminders: [], attendees: [] },
      identities.get(row.calendarId),
    ),
  );
}

function rowTiming(row: EventRow): EventTiming | null {
  if (row.allDay) {
    if (!row.startDate) return null;
    const endDate =
      row.endDate && row.endDate > row.startDate
        ? row.endDate
        : nextDay(row.startDate);
    return { allDay: true, startDate: row.startDate, endDate };
  }
  if (!row.startAt) return null;
  return {
    allDay: false,
    startAt: row.startAt.toISOString(),
    endAt: (row.endAt ?? row.startAt).toISOString(),
    startTimeZone: row.startTimeZone,
  };
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/**
 * 変更を項目ごとにまとめる。サーバーにある同じ項目の変更の方が新しければ、その項目は捨てる。
 * 返すのは、採用する項目と、項目ごとの変更時刻 (更新後) と、捨てた項目。
 */
export function mergeFields(
  stored: Record<string, string>,
  incoming: EventFields,
  changedAt: Record<string, string>,
  now: Date,
): {
  accepted: EventFields;
  fieldUpdatedAt: Record<string, string>;
  rejected: FieldName[];
} {
  const accepted: EventFields = {};
  const rejected: FieldName[] = [];
  const fieldUpdatedAt = { ...stored };
  for (const key of Object.keys(incoming) as FieldName[]) {
    if (incoming[key] === undefined) continue;
    // 未来の時刻 (端末の時計のずれ) は、届いた時刻に丸める。
    const requested = changedAt[key] ? new Date(changedAt[key]) : now;
    const at = requested.getTime() > now.getTime() ? now : requested;
    const previous = stored[key] ? Date.parse(stored[key]) : Number.NaN;
    if (!Number.isNaN(previous) && previous > at.getTime()) {
      rejected.push(key);
      continue;
    }
    (accepted as Record<string, unknown>)[key] = incoming[key];
    fieldUpdatedAt[key] = at.toISOString();
  }
  return { accepted, fieldUpdatedAt, rejected };
}

/** 行とリマインダー・参加者を、比べられる値 (eventFieldValues) の入力にする。 */
function rowSource(row: EventRow, extras: EventExtras): EventFieldSource {
  return {
    ...row,
    reminders: extras.reminders,
    attendees: extras.attendees,
  };
}

/**
 * incoming の項目のうち、いまの行と同じ値のもの (eventFieldValues の正規化で比べる)。
 * 再送や時計の補正で時刻だけ古くなった変更を、rejected にしないために使う。
 */
async function unchangedFields(
  tx: Tx,
  row: EventRow,
  incoming: EventFields,
  fields: readonly FieldName[],
): Promise<Set<FieldName>> {
  if (fields.length === 0) return new Set();
  const extras = (await loadExtras(tx, [row.id])).get(row.id) ?? {
    reminders: [],
    attendees: [],
  };
  const current = rowSource(row, extras);
  const previous = new Map(
    extras.attendees.map((attendee) => [
      attendee.email.toLowerCase(),
      attendee,
    ]),
  );
  const next: EventFieldSource = {
    ...current,
    ...(eventFieldColumns(incoming) as Partial<EventFieldSource>),
    reminders: incoming.reminders ?? current.reminders,
    attendees:
      incoming.attendees?.map((attendee) => ({
        ...attendee,
        status: previous.get(attendee.email)?.status ?? "needs_action",
      })) ?? current.attendees,
  };
  const differ = new Set(
    changedEventFields(eventFieldValues(current), eventFieldValues(next)),
  );
  return new Set(fields.filter((field) => !differ.has(field)));
}

const ATTENDEE_EDITABLE: ReadonlySet<string> = new Set(
  ATTENDEE_EDITABLE_FIELDS,
);

/**
 * 予定の変更が、招待の決まり (設計の 4.2) に合うかを確かめる。target は変える行 (回の変更で
 * 例外がまだ無ければ原本)。いまと同じ値の項目は「変えようとしていない」として扱う。
 * - 主催者でない予定: 参加者は変えられない (not_organizer)。招待された予定 (attendee) は
 *   ATTENDEE_EDITABLE_FIELDS だけ変えられる (not_organizer)。同じ値の項目は changes から外す
 *   (主催者の予定の内容を、自分の控えから書き戻さないため)。
 * - 招待を送れないカレンダー (scheduling が none): 参加者を足せない (no_scheduling)。
 *   外すだけ (いまの参加者の一部か空にする) なら通す。
 * 通れば、当てる変更を返す。
 */
async function checkInviteRules(
  tx: Tx,
  target: EventRow,
  calendar: CalendarRow,
  incoming: EventFields,
  scheduling: CalendarSchedulingInfo["scheduling"],
): Promise<{ error: InviteErrorCode } | { changes: EventFields }> {
  const keys = (Object.keys(incoming) as FieldName[]).filter(
    (key) => incoming[key] !== undefined,
  );
  if (keys.length === 0) return { changes: incoming };
  const extras = (await loadExtras(tx, [target.id])).get(target.id) ?? {
    reminders: [],
    attendees: [],
  };
  const role = await roleOf(tx, target, extras);
  const same = await unchangedFields(tx, target, incoming, keys);
  const changed = keys.filter((key) => !same.has(key));
  const current = new Set(
    extras.attendees.map((attendee) => attendee.email.toLowerCase()),
  );
  const onlyRemoves =
    incoming.attendees?.every((attendee) => current.has(attendee.email)) ??
    false;
  // 主催者の分からない予定 (organizer が null) や Orbit 内のカレンダー (アカウントが無い)
  // では、参加者を外すだけの変更は通す (設計 4.2。招待を送れないので外す道だけは残す)。
  const mayRemoveAttendees =
    onlyRemoves && (target.organizer === null || calendar.accountId === null);
  let changes = incoming;
  if (role !== "organizer") {
    if (changed.includes("attendees") && !mayRemoveAttendees) {
      return { error: "not_organizer" };
    }
    if (
      role === "attendee" &&
      changed.some(
        (key) =>
          !ATTENDEE_EDITABLE.has(key) &&
          !(key === "attendees" && mayRemoveAttendees),
      )
    ) {
      return { error: "not_organizer" };
    }
    changes = Object.fromEntries(
      Object.entries(incoming).filter(([key]) => !same.has(key as FieldName)),
    ) as EventFields;
  }
  if (
    scheduling === "none" &&
    changed.includes("attendees") &&
    incoming.attendees &&
    !onlyRemoves
  ) {
    return { error: "no_scheduling" };
  }
  return { changes };
}

/**
 * fieldUpdatedAt のうち、at より後の時刻があれば true。自分の出欠 (myResponse) は見ない
 * (レビュー 5)。「不参加にして削除」は返事の直後に削除を送るので、時計のずれの補正量が
 * 返事と削除で揺れると、自分の返事を「消した後の変更」と取り違えて 409 になる。
 */
function changedAfter(
  fieldUpdatedAt: Record<string, string> | null,
  at: Date,
): boolean {
  return Object.entries(fieldUpdatedAt ?? {}).some(([field, value]) => {
    if (field === MY_RESPONSE_FIELD) return false;
    const time = Date.parse(value);
    return !Number.isNaN(time) && time > at.getTime();
  });
}

/**
 * 時刻か繰り返し (規則と追加の回。除いた回は見ない) が変わったか。主催者がこれを変えたら、
 * ほかの参加者の出欠を「未返信」に戻す (imip-design 3.2、8.3)。
 */
function timingChanged(before: EventRow, after: EventRow): boolean {
  const key = (row: EventRow) =>
    JSON.stringify([rowTiming(row), row.rrule ?? null, row.rdates ?? null]);
  return key(before) !== key(after);
}

/** 自分と主催者を除く参加者の出欠と、最後に反映した返事を消す。 */
async function resetReplies(tx: Tx, row: EventRow) {
  const organizer = row.organizer?.email.trim().toLowerCase() ?? "";
  await tx
    .update(eventAttendees)
    .set({ status: "needs_action", repliedAt: null, replySequence: null })
    .where(
      and(
        eq(eventAttendees.eventId, row.id),
        eq(eventAttendees.self, false),
        sql`lower(${eventAttendees.email}) <> ${organizer}`,
      ),
    );
}

/** トランザクションの中で投げた InviteLimitError を、応答のエラーコードにする。 */
function inviteLimit(error: unknown): "invite_limit" | "invite_too_many" {
  if (error instanceof InviteLimitError) return error.code;
  throw error;
}

/**
 * 省略できる JSON の本文を読む (DELETE の本文など)。空なら {} として schema に通す。
 * 読めなければ null。
 */
async function optionalJson<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
): Promise<z.infer<T> | null> {
  const text = await c.req.text();
  let value: unknown = {};
  if (text.trim() !== "") {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * 予定の取得と変更。プロバイダのカレンダーは、書き戻しに対応したものだけ変えられ、
 * 変更は outbox に積んで同期ワーカーがプロバイダへ反映する。
 */
export function calendarRoutes({
  db,
  allowPrivateMailHosts = false,
  fetchImpl,
  writebackSources = CALENDAR_WRITEBACK_SOURCES,
  enqueueImip = defaultEnqueueImip,
}: Pick<RouteDeps, "db"> &
  Partial<Pick<RouteDeps, "allowPrivateMailHosts">> & {
    /** ICS の取得 (テストで差し替える)。 */
    fetchImpl?: typeof fetch;
    /** 予定を書き戻せるプロバイダの source (テストで差し替える)。 */
    writebackSources?: readonly string[];
    /** 招待メールを outbox に積む (テストで差し替える)。 */
    enqueueImip?: typeof defaultEnqueueImip;
  }) {
  const app = new Hono<AppEnv>();
  const writable: ReadonlySet<string> = new Set(writebackSources);
  const canWrite = (row: CalendarRow | undefined): row is CalendarRow =>
    row !== undefined && isWritable(row, writable);

  /** 画面に返すカレンダー (招待メールの送信元を解決するため、利用者のアカウントを 1 回読む)。 */
  const publicCalendars = async (
    executor: Database | Tx,
    rows: CalendarRow[],
  ) => {
    const lists = new Map<string, SenderAccount[]>();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      lists.set(userId, await loadSenderAccounts(executor, userId));
    }
    return rows.map((row) =>
      publicCalendar(row, writable, lists.get(row.userId) ?? []),
    );
  };
  const toPublic = async (executor: Database | Tx, row: CalendarRow) =>
    (await publicCalendars(executor, [row]))[0];

  /** 浮動時刻と終了済みの判定に使うタイムゾーン。 */
  const zoneOf = (calendar: CalendarRow) => calendar.timeZone ?? "UTC";

  /**
   * 招待メールの計画を作る (imip-design 3.2、4.2)。scheduling が mail のカレンダーでだけ呼ぶ。
   * 送信元は senderAddress (主催者なら予定の ORGANIZER、参加者なら自分の ATTENDEE) と同じ
   * アドレスの送信できるアカウント。主催者の送信元が無ければ、変更は保存して invite_failed を
   * 記録し、null を返す。返事 (respond) 以外は送信数の上限を確かめる (超えれば InviteLimitError)。
   */
  const planInvites = async (
    tx: Tx,
    input: {
      info: CalendarSchedulingInfo & { accounts: SenderAccount[] };
      calendar: CalendarRow;
      before: ImipEvent | null;
      after: ImipEvent | null;
      operation: "create" | "update" | "delete" | "respond";
      role: InviteRole;
      senderAddress: string | null;
      now: Date;
      eventId: string;
      title: string | null;
    },
  ): Promise<ImipPlan | null> => {
    const { calendar, now } = input;
    if (input.info.scheduling !== "mail" || input.role === "none") return null;
    if (!input.senderAddress) return null;
    const accepted = {
      operation: input.operation,
      stamp: now,
      defaultTimeZone: zoneOf(calendar),
    };
    const sender = pickImipSenderForAddress(
      input.info.accounts,
      input.senderAddress,
      calendar,
    );
    if (!sender) {
      if (input.role !== "organizer") return null;
      const unsent = planImip(input.before, input.after, accepted, input.role, {
        accountId: "",
        email: input.senderAddress,
      });
      if (unsent) {
        await recordInviteFailed(tx, {
          userId: calendar.userId,
          calendarId: calendar.id,
          eventId: input.eventId,
          title: input.title,
          plan: unsent,
          reason: `主催者のアドレス (${input.senderAddress}) から送信できるメールアカウントがありません。`,
        });
        await recordChanges(tx, calendar.userId, "calendar", [calendar.id]);
      }
      return null;
    }
    const plan = planImip(
      input.before,
      input.after,
      accepted,
      input.role,
      sender,
    );
    if (input.operation !== "respond") {
      await assertInviteLimit(tx, calendar.userId, plan, now);
    }
    return plan;
  };

  /** 招待メールを積む (lib/event-respond.ts の dispatchInvites。enqueueImip を差し替えられる)。 */
  const dispatchInvites = (
    tx: Tx,
    calendar: CalendarRow,
    plan: ImipPlan | null,
    rows: readonly EventWithExtras[],
    eventId: string,
    baseKey: string,
    title: string | null,
  ) =>
    dispatchImip(
      tx,
      enqueueImip,
      calendar,
      plan,
      rows,
      eventId,
      baseKey,
      title,
    );

  /**
   * 招待の本文に使う行 (原本の変更なら原本と例外、例外の変更ならその行と、RECURRENCE-ID の形を
   * そろえるための原本。L8)。
   */
  const inviteRows = (tx: Tx, row: EventRow) =>
    row.parentId === null
      ? loadSeriesWithExtras(tx, row.id)
      : loadEventsWithExtras(tx, [row.id, row.parentId]);

  /**
   * 予定に変更を当て、書き戻しと招待メールを積む (PATCH /events/:id と回の PATCH)。
   * mail のカレンダーで自分が主催者なら、変更前後の予定から計画を作る (imip-design 3.2):
   * - 主催者の無い予定に参加者を足すときは、送信元のアドレスを主催者にする。
   * - 時刻か繰り返しが変わったら、ほかの参加者の出欠を「未返信」に戻す (8.3)。
   */
  const applyWithInvites = async (
    tx: Tx,
    input: {
      userId: string;
      calendar: CalendarRow;
      info: CalendarSchedulingInfo & { accounts: SenderAccount[] };
      target: EventRow;
      changes: EventFields;
      changedAt: Record<string, string>;
      now: Date;
    },
  ) => {
    const { calendar, info, now } = input;
    const mail = info.scheduling === "mail";
    let row = input.target;
    let role: InviteRole = "none";
    let before: ImipEvent | null = null;
    if (mail) {
      const extras = (await loadExtras(tx, [row.id])).get(row.id) ?? {
        reminders: [],
        attendees: [],
      };
      role = await roleOf(tx, row, extras);
      if (
        role === "organizer" &&
        row.organizer === null &&
        (input.changes.attendees?.length ?? 0) > 0 &&
        info.sender
      ) {
        const [next] = await tx
          .update(events)
          .set({
            organizer: {
              email: info.sender.email,
              ...(info.sender.displayName
                ? { name: info.sender.displayName }
                : {}),
              self: true,
            },
          })
          .where(eq(events.id, row.id))
          .returning();
        row = next ?? row;
      }
      before = imipEventOf(row, extras.attendees);
    }
    const applied = await applyChanges(
      tx,
      input.userId,
      row,
      input.changes,
      input.changedAt,
      now,
    );
    let plan: ImipPlan | null = null;
    let rows: EventWithExtras[] = [];
    if (
      mail &&
      role === "organizer" &&
      Object.keys(applied.accepted).length > 0
    ) {
      if (timingChanged(row, applied.row)) {
        await resetReplies(tx, applied.row);
      }
      rows = await inviteRows(tx, applied.row);
      const current = rows.find((item) => item.id === applied.row.id);
      plan = await planInvites(tx, {
        info,
        calendar,
        before,
        after: imipEventOf(applied.row, current?.attendees ?? []),
        operation: "update",
        role,
        senderAddress: applied.row.organizer?.email ?? null,
        now,
        eventId: applied.row.id,
        title: applied.row.summary,
      });
    }
    const key = await enqueueEventUpdate(
      tx,
      calendar,
      applied.row,
      applied.accepted,
      plan,
    );
    if (key) {
      await dispatchInvites(
        tx,
        calendar,
        plan,
        rows,
        applied.row.id,
        key,
        applied.row.summary,
      );
    }
    return applied;
  };

  /** 主催者として予定 (row) を消すときの取り消し (CANCEL) の計画。消す前に呼ぶ。 */
  const planCancel = async (
    tx: Tx,
    info: CalendarSchedulingInfo & { accounts: SenderAccount[] },
    calendar: CalendarRow,
    row: EventRow,
    now: Date,
  ) => {
    if (info.scheduling !== "mail") return null;
    const extras = (await loadExtras(tx, [row.id])).get(row.id);
    const role = await roleOf(tx, row, extras);
    if (role !== "organizer") return null;
    // 原本を消すときは、例外の回にだけいる参加者にも取り消しを送る (L3)。
    const attendees = [...(extras?.attendees ?? [])];
    if (row.parentId === null) {
      const seen = new Set(attendees.map((item) => item.email.toLowerCase()));
      const children = await tx
        .select({ id: events.id })
        .from(events)
        .where(eq(events.parentId, row.id));
      const childExtras = await loadExtras(
        tx,
        children.map((child) => child.id),
      );
      for (const child of childExtras.values()) {
        for (const attendee of child.attendees) {
          const key = attendee.email.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          attendees.push(attendee);
        }
      }
    }
    return planInvites(tx, {
      info,
      calendar,
      before: imipEventOf(row, attendees),
      after: null,
      operation: "delete",
      role,
      senderAddress: row.organizer?.email ?? null,
      now,
      eventId: row.id,
      title: row.summary,
    });
  };

  /**
   * 予定 (row と、原本ならその例外) を消すとき、まだ書き戻していない変更で参加者から外した人への
   * 取り消しを、削除の計画に足す (imip レビュー M3)。その変更は cancelPendingWrites で計画ごと
   * 消えるため。cancelPendingWrites の前に呼ぶ。CalDAV (書き戻しのあるカレンダー) だけ。
   */
  const withPendingRemovals = async (
    tx: Tx,
    calendar: CalendarRow,
    row: EventRow,
    plan: ImipPlan | null,
    now: Date,
  ) => {
    if (!isProviderCalendar(calendar)) return plan;
    const children =
      row.parentId === null
        ? await tx
            .select({ id: events.id })
            .from(events)
            .where(eq(events.parentId, row.id))
        : [];
    const removals = await pendingRemovalRecipients(tx, calendar.accountId, [
      row.id,
      ...children.map((child) => child.id),
    ]);
    if (!removals) return plan;
    const extras = (await loadExtras(tx, [row.id])).get(row.id);
    return withRemovalCancels(
      plan,
      removals,
      imipEventOf(row, extras?.attendees ?? []),
      now,
      zoneOf(calendar),
    );
  };

  const ownCalendar = async (
    executor: Database | Tx,
    userId: string,
    id: string,
  ) => {
    const [row] = await executor
      .select()
      .from(calendars)
      .where(and(eq(calendars.id, id), eq(calendars.userId, userId)));
    return row;
  };

  const ownEvent = async (
    executor: Database | Tx,
    userId: string,
    id: string,
  ) => {
    const [row] = await executor
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.userId, userId)));
    return row;
  };

  app.get("/", async (c) => {
    await ensureHolidays(db, c.var.user.id);
    const rows = await db
      .select()
      .from(calendars)
      .where(eq(calendars.userId, c.var.user.id))
      .orderBy(
        sql`${calendars.sortOrder} asc nulls last`,
        asc(calendars.createdAt),
        asc(calendars.id),
      );
    return c.json({ calendars: await publicCalendars(db, rows) });
  });

  /** Orbit 内だけのカレンダーを作る。 */
  app.post("/", zValidator("json", calendarCreate), async (c) => {
    const body = c.req.valid("json");
    const userId = c.var.user.id;
    const created = await db.transaction(async (tx) => {
      const [{ total } = { total: 0 }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(calendars)
        .where(eq(calendars.userId, userId));
      if (total >= MAX_CALENDARS) return null;
      const [row] = await tx
        .insert(calendars)
        .values({ userId, source: "local", ...body })
        .returning();
      if (!row) return null;
      await recordChanges(tx, userId, "calendar", [row.id]);
      return row;
    });
    if (!created) return c.json({ error: "too_many_calendars" }, 409);
    return c.json({ calendar: await toPublic(db, created) }, 201);
  });

  /** ICS の URL を購読する。その場で取得して、読めなければ作らない。 */
  app.post(
    "/subscriptions",
    zValidator("json", subscriptionCreate),
    async (c) => {
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const candidates = subscriptionUrlCandidates(body.url);
      if (candidates.length === 0) {
        return c.json(
          { error: "invalid_url", message: "URL の形式が正しくありません。" },
          400,
        );
      }
      let url = candidates[0] as string;
      let loaded = await loadSubscription(url, {
        allowPrivate: allowPrivateMailHosts,
        defaultTimeZone: body.timeZone,
        fetchImpl,
      });
      for (const next of candidates.slice(1)) {
        if (loaded.status === "ok") break;
        const retry = await loadSubscription(next, {
          allowPrivate: allowPrivateMailHosts,
          defaultTimeZone: body.timeZone,
          fetchImpl,
        });
        if (retry.status === "ok") {
          url = next;
          loaded = retry;
        }
      }
      if (loaded.status !== "ok") {
        return c.json(
          {
            error: "fetch_failed",
            message:
              loaded.status === "error"
                ? loaded.message
                : "取得できませんでした。",
          },
          400,
        );
      }
      const created = await db.transaction(async (tx) => {
        const [{ total } = { total: 0 }] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(calendars)
          .where(eq(calendars.userId, userId));
        if (total >= MAX_CALENDARS) return null;
        const [row] = await tx
          .insert(calendars)
          .values({
            userId,
            source: "ics",
            name:
              body.name ||
              loaded.calendar.name ||
              new URL(url).hostname ||
              "購読",
            description: loaded.calendar.description,
            color: body.color ?? loaded.calendar.color,
            timeZone: loaded.calendar.timeZone ?? body.timeZone,
            readOnly: true,
            url,
            etag: loaded.validator,
            lastSyncedAt: new Date(),
          })
          .returning();
        if (!row) return null;
        const { upserted } = await replaceCalendarEvents(
          tx,
          { userId, calendarId: row.id },
          loaded.calendar.events,
        );
        await recordChanges(tx, userId, "calendar", [row.id]);
        await recordChanges(tx, userId, "event", upserted);
        return row;
      });
      if (!created) return c.json({ error: "too_many_calendars" }, 409);
      return c.json({ calendar: await toPublic(db, created) }, 201);
    },
  );

  /** 購読を今すぐ取得し直す。 */
  app.post(
    "/:id{[0-9a-fA-F-]{36}}/refresh",
    zValidator("param", idParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.var.user.id;
      const row = await ownCalendar(db, userId, id);
      if (!row) return c.json({ error: "not_found" }, 404);
      if (row.source !== "ics" || !row.url) {
        return c.json({ error: "not_subscription" }, 409);
      }
      const loaded = await loadSubscription(row.url, {
        validator: row.etag,
        allowPrivate: allowPrivateMailHosts,
        defaultTimeZone: row.timeZone ?? "Asia/Tokyo",
        fetchImpl,
      });
      const updated = await db.transaction(async (tx) => {
        const set: Partial<typeof calendars.$inferInsert> = {
          lastSyncedAt: new Date(),
          lastError: loaded.status === "error" ? loaded.message : null,
        };
        if (loaded.status === "ok") {
          set.etag = loaded.validator;
          const { upserted, deleted } = await replaceCalendarEvents(
            tx,
            { userId, calendarId: id },
            loaded.calendar.events,
          );
          await recordChanges(tx, userId, "event", upserted);
          await recordChanges(tx, userId, "event", deleted, "delete");
        }
        const [next] = await tx
          .update(calendars)
          .set(set)
          .where(eq(calendars.id, id))
          .returning();
        await recordChanges(tx, userId, "calendar", [id]);
        return next ?? row;
      });
      return c.json({ calendar: await toPublic(db, updated) });
    },
  );

  app.patch(
    "/:id{[0-9a-fA-F-]{36}}",
    zValidator("param", idParam),
    zValidator("json", calendarPatch),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const updated = await db.transaction(async (tx) => {
        const row = await ownCalendar(tx, userId, id);
        if (!row) return "not_found" as const;
        // 名前・説明・タイムゾーンは Orbit 内のカレンダーだけ変えられる (ほかは同期で上書きされる)。
        // 購読の名前は Orbit が持つだけなので変えられる。
        const local = row.source === "local";
        const renamable = local || row.source === "ics";
        if (
          (!renamable && body.name !== undefined) ||
          (!local &&
            (body.description !== undefined || body.timeZone !== undefined))
        ) {
          return "read_only" as const;
        }
        if (
          body.defaultReminders !== undefined &&
          !OWN_DEFAULT_REMINDER_SOURCES.has(row.source)
        ) {
          return "read_only" as const;
        }
        if (body.imipAccountId !== undefined) {
          // 招待メールの送信元は、Orbit が招待を送りうるカレンダーだけ選べる。
          if (!MAIL_CALENDAR_SOURCES.has(row.source)) {
            return "imip_unsupported" as const;
          }
          if (body.imipAccountId !== null) {
            const [account] = await tx
              .select()
              .from(accounts)
              .where(
                and(
                  eq(accounts.id, body.imipAccountId),
                  eq(accounts.userId, userId),
                ),
              );
            if (!account) return "account_not_found" as const;
            if (!isSendableAccount(account)) return "receive_only" as const;
          }
        }
        if (Object.keys(body).length === 0) return row;
        const [next] = await tx
          .update(calendars)
          .set(body)
          .where(eq(calendars.id, id))
          .returning();
        await recordChanges(tx, userId, "calendar", [id]);
        return next ?? row;
      });
      if (updated === "not_found") return c.json({ error: "not_found" }, 404);
      if (updated === "read_only") return c.json({ error: "read_only" }, 409);
      if (updated === "account_not_found") {
        return c.json({ error: "not_found" }, 404);
      }
      if (updated === "imip_unsupported" || updated === "receive_only") {
        return c.json({ error: updated }, 400);
      }
      return c.json({ calendar: await toPublic(db, updated) });
    },
  );

  /** Orbit 内のカレンダーか購読を消す (予定もすべて消える)。祝日は非表示にできるだけ。 */
  app.delete(
    "/:id{[0-9a-fA-F-]{36}}",
    zValidator("param", idParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.var.user.id;
      const now = new Date();
      const result = await db
        .transaction(async (tx) => {
          const row = await ownCalendar(tx, userId, id);
          if (!row) return "not_found" as const;
          if (row.source !== "local" && row.source !== "ics") {
            return "read_only" as const;
          }
          // 主催している予定の参加者へ取り消し (CANCEL) を積んでから消す (imip レビュー M9)。
          // 積んだ取り消しは、カレンダーが消えた後も送る (worker の送る直前の検査)。
          if (row.source === "local") {
            const info = await loadSchedulingInfo(tx, row, false);
            if (info.scheduling === "mail") {
              const masters = await tx
                .select()
                .from(events)
                .where(and(eq(events.calendarId, id), isNull(events.parentId)));
              for (const master of masters) {
                const plan = await planCancel(tx, info, row, master, now);
                await dispatchInvites(
                  tx,
                  row,
                  plan,
                  [],
                  master.id,
                  eventDeleteKey(master.id),
                  master.summary,
                );
              }
            }
          }
          const removed = await tx
            .delete(events)
            .where(eq(events.calendarId, id))
            .returning({ id: events.id });
          await tx.delete(calendars).where(eq(calendars.id, id));
          await recordChanges(
            tx,
            userId,
            "event",
            removed.map((event) => event.id),
            "delete",
          );
          await recordChanges(tx, userId, "calendar", [id], "delete");
          return "ok" as const;
        })
        .catch(inviteLimit);
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "invite_limit" || result === "invite_too_many")
        return c.json({ error: result }, 409);
      return c.body(null, 204);
    },
  );

  /**
   * 期間内の回。events は回の中身 (原本と例外)、occurrences は回ごとの時刻で、
   * eventId で events を引く。非表示のカレンダーも含める (表示するかは端末が決める)。
   */
  app.get("/events", zValidator("query", rangeQuery), async (c) => {
    const range = c.req.valid("query");
    const userId = c.var.user.id;
    if (range.to <= range.from) return c.json({ error: "invalid_range" }, 400);
    const days =
      (Date.parse(`${range.to}T00:00:00Z`) -
        Date.parse(`${range.from}T00:00:00Z`)) /
      86_400_000;
    if (days > MAX_RANGE_DAYS) return c.json({ error: "range_too_long" }, 400);

    // タイムゾーンの差 (最大 ±14 時間) を見込んで、1 日ずつ広く取る。
    const fromDate = shiftDate(range.from, -1);
    const toDate = shiftDate(range.to, 1);
    const fromAt = new Date(`${fromDate}T00:00:00Z`);
    const toAt = new Date(`${toDate}T00:00:00Z`);
    const recurring = or(isNotNull(events.rrule), isNotNull(events.rdates));
    const masters = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          isNull(events.parentId),
          or(
            and(
              recurring,
              or(
                sql`${events.startAt} < ${toAt}`,
                sql`${events.startDate} < ${toDate}`,
              ),
            ),
            and(
              sql`not (${recurring})`,
              or(
                and(
                  sql`${events.startAt} < ${toAt}`,
                  sql`coalesce(${events.endAt}, ${events.startAt}) >= ${fromAt}`,
                ),
                and(
                  sql`${events.startDate} < ${toDate}`,
                  sql`coalesce(${events.endDate}, ${events.startDate}) >= ${fromDate}`,
                ),
              ),
            ),
          ),
        ),
      );
    const recurringIds = masters
      .filter((row) => row.rrule || (row.rdates && row.rdates.length > 0))
      .map((row) => row.id);
    const exceptionRows =
      recurringIds.length === 0
        ? []
        : await db
            .select()
            .from(events)
            .where(
              and(
                eq(events.userId, userId),
                inArray(events.parentId, recurringIds),
              ),
            );
    const exceptionsByParent = new Map<string, EventRow[]>();
    for (const row of exceptionRows) {
      if (!row.parentId) continue;
      const list = exceptionsByParent.get(row.parentId) ?? [];
      list.push(row);
      exceptionsByParent.set(row.parentId, list);
    }

    const occurrences: {
      eventId: string;
      masterId: string;
      recurrenceId: string | null;
      allDay: boolean;
      startAt: string | null;
      endAt: string | null;
      startDate: string | null;
      endDate: string | null;
    }[] = [];
    const used = new Map<string, EventRow>();
    for (const master of masters) {
      const masterTiming = rowTiming(master);
      if (!masterTiming || master.status === "cancelled") continue;
      const exceptions: RecurrenceException<EventRow>[] = [];
      for (const row of exceptionsByParent.get(master.id) ?? []) {
        const value = rowTiming(row);
        if (!value || !row.recurrenceId) continue;
        exceptions.push({
          ...value,
          key: row,
          recurrenceId: row.recurrenceId,
          cancelled: row.status === "cancelled",
        });
      }
      const expanded = expandOccurrences(
        {
          ...masterTiming,
          rrule: master.rrule,
          rdates: master.rdates,
          exdates: master.exdates,
        },
        exceptions,
        range,
        { defaultTimeZone: range.timeZone },
      );
      for (const occurrence of expanded) {
        const event = occurrence.exception ?? master;
        used.set(event.id, event);
        occurrences.push({
          eventId: event.id,
          masterId: master.id,
          recurrenceId: occurrence.recurrenceId,
          allDay: occurrence.allDay,
          startAt: occurrence.allDay ? null : occurrence.startAt,
          endAt: occurrence.allDay ? null : occurrence.endAt,
          startDate: occurrence.allDay ? occurrence.startDate : null,
          endDate: occurrence.allDay ? occurrence.endDate : null,
        });
      }
      if (expanded.length > 0) used.set(master.id, master);
    }
    return c.json({
      events: await publicEvents(db, [...used.values()]),
      occurrences,
    });
  });

  /** タイトル・場所・メモで探す (空白で区切った語をすべて含む予定)。新しい順。 */
  app.get("/events/search", zValidator("query", searchQuery), async (c) => {
    const { q, limit } = c.req.valid("query");
    const userId = c.var.user.id;
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 10);
    const conditions = terms.map((term) => {
      const value = sql`mail_search_normalize(${term})`;
      return sql`${events.id} in (
        select ${eventSearch.eventId} from ${eventSearch}
        where ${eventSearch.userId} = ${userId}
          and mail_search_grams(${eventSearch.doc}) @> mail_search_query_grams(${value})
          and ${eventSearch.doc} like mail_search_like_pattern(${value})
        offset 0
      )`;
    });
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), ...conditions))
      .orderBy(
        desc(
          sql`coalesce(${events.startAt}, ${events.startDate}::timestamptz)`,
        ),
        desc(events.id),
      )
      .limit(limit);
    return c.json({ events: await publicEvents(db, rows) });
  });

  /**
   * 変更番号 since より後に変わったカレンダーと予定 (差分同期)。
   * 消えたもの (と、もう見られないもの) は deleted に入る。
   */
  app.get("/sync", zValidator("query", syncQuery), async (c) => {
    const { since, limit } = c.req.valid("query");
    const userId = c.var.user.id;
    const rows = await db
      .select({
        seq: changes.seq,
        entity: changes.entity,
        entityId: changes.entityId,
      })
      .from(changes)
      .where(
        and(
          eq(changes.userId, userId),
          gt(changes.seq, BigInt(since)),
          inArray(changes.entity, ["calendar", "event"]),
        ),
      )
      .orderBy(asc(changes.seq))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const calendarIds = [
      ...new Set(
        page.filter((r) => r.entity === "calendar").map((r) => r.entityId),
      ),
    ];
    const eventIds = [
      ...new Set(
        page.filter((r) => r.entity === "event").map((r) => r.entityId),
      ),
    ];
    const [calendarRows, eventRows] = await Promise.all([
      calendarIds.length === 0
        ? []
        : db
            .select()
            .from(calendars)
            .where(
              and(
                eq(calendars.userId, userId),
                inArray(calendars.id, calendarIds),
              ),
            ),
      eventIds.length === 0
        ? []
        : db
            .select()
            .from(events)
            .where(
              and(eq(events.userId, userId), inArray(events.id, eventIds)),
            ),
    ]);
    const foundCalendars = new Set(calendarRows.map((row) => row.id));
    const foundEvents = new Set(eventRows.map((row) => row.id));
    // 反映されなかった変更 (event_conflicts) の未解決の件数と、最新の記録の時刻。
    // 端末は値が変わったときだけ /v1/calendars/conflicts を取り直す。
    const [open] = await db
      .select({
        count: sql<number>`count(*)::int`,
        latest: sql<Date | null>`max(${eventConflicts.createdAt})`.mapWith(
          eventConflicts.createdAt,
        ),
      })
      .from(eventConflicts)
      .where(
        and(
          eq(eventConflicts.userId, userId),
          isNull(eventConflicts.resolvedAt),
        ),
      );
    return c.json({
      calendars: await publicCalendars(db, calendarRows),
      events: await publicEvents(db, eventRows),
      deleted: {
        calendars: calendarIds.filter((id) => !foundCalendars.has(id)),
        events: eventIds.filter((id) => !foundEvents.has(id)),
      },
      latestSeq: page.at(-1)?.seq.toString() ?? since,
      hasMore: rows.length > limit,
      openConflicts: open?.count ?? 0,
      conflictsAt: open?.latest?.toISOString() ?? null,
    });
  });

  app.get(
    "/events/:id{[0-9a-fA-F-]{36}}",
    zValidator("param", idParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await ownEvent(db, c.var.user.id, id);
      if (!row) return c.json({ error: "not_found" }, 404);
      const [event] = await publicEvents(db, [row]);
      return c.json({ event });
    },
  );

  app.post("/events", zValidator("json", eventCreate), async (c) => {
    const body = c.req.valid("json");
    const userId = c.var.user.id;
    const now = new Date();
    const result = await db
      .transaction(async (tx) => {
        const calendar = await ownCalendar(tx, userId, body.calendarId);
        if (!calendar) return "not_found" as const;
        if (!canWrite(calendar)) return "read_only" as const;
        const blocked = await providerWriteBlocked(tx, calendar);
        if (blocked) return blocked;
        if (isProviderCalendar(calendar)) {
          await lockCalendarAccount(tx, calendar.accountId);
        }
        if (body.id) {
          // 同じ ID で再送された (端末の送信待ちの再送)。作り直さずにそのまま返す。
          const existing = await ownEvent(tx, userId, body.id);
          if (existing) return existing;
          // 作ったあと (ほかの端末で) 消された予定の再送。作り直さない。
          if (await wasDeleted(tx, userId, body.id)) return "gone" as const;
        }
        // 参加者のいる予定は、招待を送れるカレンダーにだけ作れる (server: サービスが送る、
        // mail: Orbit が招待メールを送る)。
        const inviting = (body.attendees?.length ?? 0) > 0;
        const info = await loadSchedulingInfo(tx, calendar, false);
        if (inviting && info.scheduling === "none") {
          return "no_scheduling" as const;
        }
        // 自分が主催者 (inviteRole の organizer) になるよう、self を付けて入れる。
        // mail: 招待メールの送信元のアドレス (ORGANIZER と From をそろえる。imip-design 4.2)。
        // server: 書き戻しの結果でプロバイダが決めた主催者が入るまでの仮の値 (アカウントのアドレス)。
        let organizer: InvitePerson | null = null;
        if (inviting && info.scheduling === "mail" && info.sender) {
          organizer = {
            email: info.sender.email,
            ...(info.sender.displayName
              ? { name: info.sender.displayName }
              : {}),
            self: true,
          };
        } else if (inviting && calendar.accountId) {
          const [account] = await tx
            .select({ email: accounts.email, username: accounts.username })
            .from(accounts)
            .where(eq(accounts.id, calendar.accountId));
          if (account) {
            const email = [...ownAddresses(account)][0] ?? account.email;
            organizer = { email, self: true };
          }
        }
        const {
          id,
          calendarId,
          changedAt: _changedAt,
          clientNow: _clientNow,
          ...fields
        } = body;
        // 端末で作った時刻 (時計のずれを直したもの) を全項目の変更時刻にする。
        // 作ったあとオフラインのまま変えた項目の PATCH が、届いた時刻に負けないようにするため。
        const createdAt = correctClientTime(
          body.changedAt,
          body.clientNow,
          now,
        ).toISOString();
        const fieldUpdatedAt = Object.fromEntries(
          Object.keys(fields).map((key) => [key, createdAt]),
        );
        const eventId = id ?? randomUUID();
        const row = await insertEvent(tx, {
          id: eventId,
          userId,
          calendarId,
          fields,
          organizer,
          fieldUpdatedAt,
        });
        if (!row) {
          // 同じ作成が同時に届き、先の方が確定した。同じ利用者の行なら再送と同じに、その行を返す。
          const existing = await ownEvent(tx, userId, eventId);
          if (existing) return existing;
          // 別の利用者が同じ ID を使っていた (ほぼ起きない)。
          return "conflict" as const;
        }
        await recordChanges(tx, userId, "event", [row.id]);
        // 招待メール (mail のカレンダーで参加者がいるとき)。
        let plan: ImipPlan | null = null;
        let rows: EventWithExtras[] = [];
        if (inviting && info.scheduling === "mail") {
          rows = await loadEventsWithExtras(tx, [row.id]);
          plan = await planInvites(tx, {
            info,
            calendar,
            before: null,
            after: imipEventOf(row, rows[0]?.attendees ?? []),
            operation: "create",
            role: "organizer",
            senderAddress: organizer?.email ?? null,
            now,
            eventId: row.id,
            title: row.summary,
          });
        }
        // プロバイダのカレンダーなら、作成を書き戻す (中身は実行時に行から読む)。
        await enqueueEventOperation(
          tx,
          calendar,
          {
            kind: "event_create",
            payload: {
              eventId: row.id,
              calendarId,
              ...(plan ? { imip: plan } : {}),
            },
          },
          eventCreateKey(row.id),
        );
        await dispatchInvites(
          tx,
          calendar,
          plan,
          rows,
          row.id,
          eventCreateKey(row.id),
          row.summary,
        );
        return row;
      })
      .catch(inviteLimit);
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "invite_limit" || result === "invite_too_many")
      return c.json({ error: result }, 409);
    if (result === "read_only") return c.json({ error: "read_only" }, 409);
    if (result === "calendar_disabled" || result === "calendar_sync_stopped")
      return c.json({ error: result }, 409);
    if (result === "conflict") return c.json({ error: "conflict" }, 409);
    if (result === "no_scheduling") return c.json({ error: result }, 409);
    if (result === "gone") return c.json({ error: "gone" }, 410);
    const [event] = await publicEvents(db, [result]);
    return c.json({ event }, 201);
  });

  /**
   * 予定を変える。変えた項目と、項目ごとの変えた時刻を送る。
   * ほかの端末が同じ項目を後から変えていれば、その項目は変えずに rejected で返す
   * (別の項目なら両方とも残る)。
   */
  app.patch(
    "/events/:id{[0-9a-fA-F-]{36}}",
    zValidator("param", idParam),
    zValidator("json", eventPatch),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const now = new Date();
      const result = await db
        .transaction(async (tx) => {
          const row = await lockEventForWrite(tx, userId, id);
          if (!row) return "not_found" as const;
          const calendar = await ownCalendar(tx, userId, row.calendarId);
          if (!canWrite(calendar)) return "read_only" as const;
          const blocked = await providerWriteBlocked(tx, calendar);
          if (blocked) return blocked;
          // 例外では繰り返しを変えられない。
          if (row.parentId && body.changes.recurrence !== undefined) {
            return "invalid" as const;
          }
          // 時刻を変えない変更の負の分は、いまの予定が終日かで確かめる。
          if (
            body.changes.time === undefined &&
            !remindersFitTiming(body.changes.reminders, row.allDay)
          ) {
            return "invalid" as const;
          }
          const info = await loadSchedulingInfo(tx, calendar, false);
          const checked = await checkInviteRules(
            tx,
            row,
            calendar,
            body.changes,
            info.scheduling,
          );
          if ("error" in checked) return checked;
          return applyWithInvites(tx, {
            userId,
            calendar,
            info,
            target: row,
            changes: checked.changes,
            changedAt: correctClientTimes(body.changedAt, body.clientNow, now),
            now,
          });
        })
        .catch(inviteLimit);
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "invite_limit" || result === "invite_too_many")
        return c.json({ error: result }, 409);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if (result === "invalid") return c.json({ error: "invalid" }, 400);
      if ("error" in result) return c.json({ error: result.error }, 409);
      const [event] = await publicEvents(db, [result.row]);
      return c.json({ event, rejected: result.rejected });
    },
  );

  /**
   * 繰り返しのうち 1 回だけを変える (例外を作る、またはその例外を変える)。
   * recurrenceId は回の元の開始 (GET /events の occurrences の値)。
   */
  app.patch(
    "/events/:id{[0-9a-fA-F-]{36}}/occurrences/:recurrenceId",
    zValidator("param", occurrenceParam),
    zValidator("json", eventPatch),
    async (c) => {
      const { id, recurrenceId } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const now = new Date();
      if (body.changes.recurrence !== undefined) {
        return c.json({ error: "invalid" }, 400);
      }
      const result = await db
        .transaction(async (tx) => {
          const master = await lockEventForWrite(tx, userId, id);
          if (!master || master.parentId) return "not_found" as const;
          const calendar = await ownCalendar(tx, userId, master.calendarId);
          if (!canWrite(calendar)) return "read_only" as const;
          const blocked = await providerWriteBlocked(tx, calendar);
          if (blocked) return blocked;
          const normalized = normalizeRecurrenceId(recurrenceId);
          // 招待の決まりは、例外を作る前に確かめる (断るときに例外の行を残さないため)。
          // 例外がまだ無ければ、原本の内容と比べる。
          const [existing] = await tx
            .select()
            .from(events)
            .where(
              and(
                eq(events.parentId, master.id),
                eq(events.recurrenceId, normalized),
              ),
            );
          const info = await loadSchedulingInfo(tx, calendar, false);
          const checked = await checkInviteRules(
            tx,
            existing ?? master,
            calendar,
            body.changes,
            info.scheduling,
          );
          if ("error" in checked) return checked;
          if (
            body.changes.time === undefined &&
            !remindersFitTiming(
              body.changes.reminders,
              (existing ?? master).allDay,
            )
          ) {
            return "invalid" as const;
          }
          const exception = await findOrCreateException(
            tx,
            userId,
            master,
            normalized,
          );
          if (!exception) return "invalid" as const;
          // 例外の行の変更として積む。例外の remoteId が無ければ、ワーカーがその回を
          // 上書きする書き込みとしてプロバイダへ渡す。招待メールは、作ったばかりの例外なら
          // 原本の写しとの差で決める (その回だけの REQUEST)。
          return applyWithInvites(tx, {
            userId,
            calendar,
            info,
            target: exception,
            changes: checked.changes,
            changedAt: correctClientTimes(body.changedAt, body.clientNow, now),
            now,
          });
        })
        .catch(inviteLimit);
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "invite_limit" || result === "invite_too_many")
        return c.json({ error: result }, 409);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if (result === "invalid") return c.json({ error: "invalid" }, 400);
      if ("error" in result) return c.json({ error: result.error }, 409);
      const [event] = await publicEvents(db, [result.row]);
      return c.json({ event, rejected: result.rejected });
    },
  );

  /**
   * 自分の出欠を返事する (設計の 4.1)。返事できるのは、自分が参加者 (self の行がある) で
   * 主催者でない予定だけ。返事の対象のアドレスは要求に含めず、サーバーが self の行を書き換える。
   * プロバイダのカレンダーなら返事の書き戻し (event_respond) を積む。招待を自分で送らない
   * CalDAV サーバーでは、自分のカレンダーにだけ記録され、主催者には届かない
   * (応答の notifiesOrganizer が false)。
   */
  app.post(
    "/events/:id{[0-9a-fA-F-]{36}}/respond",
    zValidator("param", idParam),
    zValidator("json", eventRespond),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await respondToEvent(db, c.var.user.id, id, body, {
        writable,
        enqueueImip,
      });
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if ("error" in result) return c.json({ error: result.error }, 409);
      const [event] = await publicEvents(db, [result.row]);
      return c.json({
        event,
        applied: result.applied,
        /** 主催者に返事が届くか (server: サービスが送る、mail: Orbit が REPLY を送る)。 */
        notifiesOrganizer: result.notify !== "none",
        notify: result.notify,
        notifyBlocked: result.notifyBlocked,
      });
    },
  );

  /** 繰り返しのうち 1 回だけを消す (原本の EXDATE に足し、例外があれば消す)。 */
  app.delete(
    "/events/:id{[0-9a-fA-F-]{36}}/occurrences/:recurrenceId",
    zValidator("param", occurrenceParam),
    async (c) => {
      const { id, recurrenceId } = c.req.valid("param");
      const userId = c.var.user.id;
      const body = await optionalJson(c, occurrenceDelete);
      if (!body) return c.json({ error: "invalid" }, 400);
      const now = new Date();
      const at = correctClientTime(body.changedAt, body.clientNow, now);
      const normalized = normalizeRecurrenceId(recurrenceId);
      const result = await db
        .transaction(async (tx) => {
          const master = await lockEventForWrite(tx, userId, id);
          if (!master || master.parentId) return "not_found" as const;
          const calendar = await ownCalendar(tx, userId, master.calendarId);
          if (!canWrite(calendar)) return "read_only" as const;
          const blocked = await providerWriteBlocked(tx, calendar);
          if (blocked) return blocked;
          const [exception] = await tx
            .select()
            .from(events)
            .where(
              and(
                eq(events.parentId, master.id),
                eq(events.recurrenceId, normalized),
              ),
            );
          // その回が、消した後に (ほかの端末などで) 変えられていれば消さない。
          if (
            body.changedAt &&
            exception &&
            changedAfter(exception.fieldUpdatedAt, at)
          ) {
            return { changedSince: exception };
          }
          // 招待メール: 例外の行があればその回の取り消し、無ければ原本の EXDATE の差 (planImip が
          // その回の CANCEL を作る)。
          const info = await loadSchedulingInfo(tx, calendar, false);
          let plan: ImipPlan | null = null;
          if (exception) {
            plan = await withPendingRemovals(
              tx,
              calendar,
              exception,
              await planCancel(tx, info, calendar, exception, now),
              now,
            );
          } else if (info.scheduling === "mail") {
            const extras = (await loadExtras(tx, [master.id])).get(master.id);
            const role = await roleOf(tx, master, extras);
            if (role === "organizer") {
              const before = imipEventOf(master, extras?.attendees ?? []);
              plan = await planInvites(tx, {
                info,
                calendar,
                before,
                after: {
                  ...before,
                  exdates: [
                    ...new Set([...(master.exdates ?? []), normalized]),
                  ],
                },
                operation: "update",
                role,
                senderAddress: master.organizer?.email ?? null,
                now,
                eventId: master.id,
                title: master.summary,
              });
            }
          }
          const updateKey = await excludeOccurrence(
            tx,
            calendar,
            master,
            normalized,
            at,
            plan,
          );
          await dispatchInvites(
            tx,
            calendar,
            plan,
            [],
            exception?.id ?? master.id,
            exception ? eventDeleteKey(exception.id) : updateKey,
            (exception ?? master).summary,
          );
          const removed = await tx
            .delete(events)
            .where(
              and(
                eq(events.parentId, master.id),
                eq(events.recurrenceId, normalized),
              ),
            )
            .returning({ id: events.id });
          await cancelPendingWrites(
            tx,
            calendar,
            removed.map((row) => row.id),
          );
          await recordChanges(tx, userId, "event", [master.id]);
          await recordChanges(
            tx,
            userId,
            "event",
            removed.map((row) => row.id),
            "delete",
          );
          return "ok" as const;
        })
        .catch(inviteLimit);
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "invite_limit" || result === "invite_too_many")
        return c.json({ error: result }, 409);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if (typeof result === "object") {
        const [event] = await publicEvents(db, [result.changedSince]);
        return c.json({ error: "changed_since", event }, 409);
      }
      return c.body(null, 204);
    },
  );

  /** 予定を消す。繰り返しの原本なら、すべての回 (例外も) が消える。 */
  app.delete(
    "/events/:id{[0-9a-fA-F-]{36}}",
    zValidator("param", idParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.var.user.id;
      const body = await optionalJson(c, eventDelete);
      if (!body) return c.json({ error: "invalid" }, 400);
      const now = new Date();
      const deletedAt = correctClientTime(body.deletedAt, body.clientNow, now);
      const result = await db
        .transaction(async (tx) => {
          const row = await lockEventForWrite(tx, userId, id);
          if (!row) return "not_found" as const;
          const calendar = await ownCalendar(tx, userId, row.calendarId);
          if (!canWrite(calendar)) return "read_only" as const;
          const blocked = await providerWriteBlocked(tx, calendar);
          if (blocked) return blocked;
          if (body.deletedAt) {
            // 削除と変更は後から行った方を採る。消した後に (ほかの端末などで) 変えられた
            // 項目があれば消さない。原本なら例外の変更も見る。
            const exceptions =
              row.parentId === null
                ? await tx
                    .select({ fieldUpdatedAt: events.fieldUpdatedAt })
                    .from(events)
                    .where(eq(events.parentId, row.id))
                : [];
            if (
              [row, ...exceptions].some((item) =>
                changedAfter(item.fieldUpdatedAt, deletedAt),
              )
            ) {
              return { changedSince: row };
            }
          }
          // 主催者として消すなら、参加者へ取り消し (CANCEL) を送る。行が消えるので先に作る。
          const info = await loadSchedulingInfo(tx, calendar, false);
          const plan = await withPendingRemovals(
            tx,
            calendar,
            row,
            await planCancel(tx, info, calendar, row, now),
            now,
          );
          let master: EventRow | undefined;
          if (row.parentId && row.recurrenceId) {
            // 例外を消す = その回を消す。プロバイダへは原本の繰り返しの変更として書き戻す。
            [master] = await tx
              .select()
              .from(events)
              .where(eq(events.id, row.parentId))
              .for("update");
            if (master) {
              await excludeOccurrence(
                tx,
                calendar,
                master,
                row.recurrenceId,
                deletedAt,
                plan,
              );
              await recordChanges(tx, userId, "event", [master.id]);
            }
          }
          const removed = await tx
            .delete(events)
            .where(or(eq(events.id, id), eq(events.parentId, id)))
            .returning({ id: events.id });
          await cancelPendingWrites(
            tx,
            calendar,
            removed.map((event) => event.id),
          );
          // 原本の EXDATE で取り消した回は、削除を積まない。
          if (!master) await enqueueDelete(tx, calendar, row, deletedAt, plan);
          await dispatchInvites(
            tx,
            calendar,
            plan,
            [],
            row.id,
            eventDeleteKey(row.id),
            row.summary,
          );
          await recordChanges(
            tx,
            userId,
            "event",
            removed.map((event) => event.id),
            "delete",
          );
          return "ok" as const;
        })
        .catch(inviteLimit);
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "invite_limit" || result === "invite_too_many")
        return c.json({ error: result }, 409);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if (typeof result === "object") {
        const [event] = await publicEvents(db, [result.changedSince]);
        return c.json({ error: "changed_since", event }, 409);
      }
      return c.body(null, 204);
    },
  );

  return app;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * 予定に変更を当てる。changedAt は時計のずれを直したもの。時刻で負けた項目のうち、
 * 値がいまの行と同じもの (再送など) は rejected に入れない (何もしない)。
 */
async function applyChanges(
  tx: Tx,
  userId: string,
  row: EventRow,
  incoming: EventFields,
  changedAt: Record<string, string>,
  now: Date,
) {
  const merged = mergeFields(
    row.fieldUpdatedAt ?? {},
    incoming,
    changedAt,
    now,
  );
  const { accepted, fieldUpdatedAt } = merged;
  const same = await unchangedFields(tx, row, incoming, merged.rejected);
  const rejected = merged.rejected.filter((field) => !same.has(field));
  if (Object.keys(accepted).length === 0) return { row, rejected, accepted };
  const [next] = await tx
    .update(events)
    .set({
      ...eventFieldColumns(accepted),
      fieldUpdatedAt,
      // 時刻・繰り返しの変更と、取り消し (cancelled) にする・戻すときは SEQUENCE を上げる
      // (取り消しの CANCEL と、戻した後の REQUEST を新しい版として送るため。imip レビュー L2)。
      ...(accepted.time !== undefined ||
      accepted.recurrence !== undefined ||
      (accepted.status !== undefined &&
        (accepted.status === "cancelled") !== (row.status === "cancelled"))
        ? { sequence: row.sequence + 1 }
        : {}),
    })
    .where(eq(events.id, row.id))
    .returning();
  await replaceEventExtras(tx, row.id, accepted);
  await recordChanges(tx, userId, "event", [row.id]);
  return { row: next ?? row, rejected, accepted };
}

/** 回の例外を探し、無ければ原本の中身を写して作る。回が原本の規則に無ければ null。 */
async function findOrCreateException(
  tx: Tx,
  userId: string,
  master: EventRow,
  recurrenceId: string,
): Promise<EventRow | null> {
  const [existing] = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.parentId, master.id),
        eq(events.recurrenceId, recurrenceId),
      ),
    )
    .for("update");
  if (existing) return existing;
  const masterTiming = rowTiming(master);
  if (!masterTiming || !(master.rrule || master.rdates?.length)) return null;
  if (masterTiming.allDay !== /^\d{4}-\d{2}-\d{2}$/.test(recurrenceId)) {
    return null;
  }
  // その回が規則にあることを確かめる (その日の前後だけを展開する)。
  const day = recurrenceId.slice(0, 10);
  const expanded = expandOccurrences(
    {
      ...masterTiming,
      rrule: master.rrule,
      rdates: master.rdates,
      exdates: master.exdates,
    },
    [],
    { from: shiftDate(day, -1), to: shiftDate(day, 2), timeZone: "UTC" },
    { defaultTimeZone: "UTC" },
  );
  const occurrence = expanded.find((o) => o.recurrenceId === recurrenceId);
  if (!occurrence) return null;
  const [row] = await tx
    .insert(events)
    .values({
      userId,
      calendarId: master.calendarId,
      uid: master.uid,
      recurrenceId,
      parentId: master.id,
      summary: master.summary,
      location: master.location,
      description: master.description,
      status: master.status,
      busy: master.busy,
      ...(occurrence.allDay
        ? {
            allDay: true,
            startDate: occurrence.startDate,
            endDate: occurrence.endDate,
          }
        : {
            allDay: false,
            startAt: new Date(occurrence.startAt),
            endAt: new Date(occurrence.endAt),
            startTimeZone: master.startTimeZone,
            endTimeZone: master.endTimeZone,
          }),
      organizer: master.organizer,
      sequence: master.sequence,
      conferenceUrl: master.conferenceUrl,
      useDefaultReminders: master.useDefaultReminders,
      // 原本の時刻は写さない。原本の変更と例外の変更は別の行なので、互いに負けないようにする
      // (原本が後から変わっていても、その前に行ったこの回の変更を採る)。
      fieldUpdatedAt: {},
    })
    .returning();
  if (!row) return null;
  // リマインダーと参加者も原本から写す (出欠と、最後に反映した返事も)。
  const extras = (await loadExtras(tx, [master.id])).get(master.id);
  if (extras && extras.reminders.length > 0) {
    await tx
      .insert(eventReminders)
      .values(extras.reminders.map((value) => ({ eventId: row.id, ...value })));
  }
  const attendees = await tx
    .select()
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, master.id));
  if (attendees.length > 0) {
    await tx.insert(eventAttendees).values(
      attendees.map(({ id: _id, eventId: _eventId, ...value }) => ({
        ...value,
        eventId: row.id,
      })),
    );
  }
  return row;
}

/** 予定 id が、利用者の変更履歴で消されたことになっているか (POST の再送で作り直さないため)。 */
async function wasDeleted(tx: Tx, userId: string, id: string) {
  const [row] = await tx
    .select({ seq: changes.seq })
    .from(changes)
    .where(
      and(
        eq(changes.entityId, id),
        // changes_delete_entity_idx (op = 'delete' の部分索引) を使うよう、値を埋め込む。
        sql`${changes.op} = 'delete'`,
        eq(changes.entity, "event"),
        eq(changes.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * 日本の祝日のカレンダーを用意する (既定で有効)。無ければ作り、祝日のデータの版が
 * 変わっていれば予定を入れ直す。消せないカレンダーなので、オフにするには非表示にする。
 */
export async function ensureHolidays(
  db: Database,
  userId: string,
  today = new Date().toISOString().slice(0, 10),
) {
  const [current] = await db
    .select({ id: calendars.id, etag: calendars.etag })
    .from(calendars)
    .where(and(eq(calendars.userId, userId), eq(calendars.source, "holidays")))
    .limit(1);
  // 祝日は今年の 10 年後まで入れるので、年が変わったときも入れ直す。
  const version = `${HOLIDAYS_VERSION}/${today.slice(0, 4)}`;
  if (current?.etag === version) return;
  await db.transaction(async (tx) => {
    // 同時に呼ばれても 1 つだけ作るように、利用者ごとに順番にする。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`holidays:${userId}`}))`,
    );
    const [row] = await tx
      .select({ id: calendars.id, etag: calendars.etag })
      .from(calendars)
      .where(
        and(eq(calendars.userId, userId), eq(calendars.source, "holidays")),
      )
      .limit(1);
    if (row?.etag === version) return;
    let calendarId = row?.id;
    if (!calendarId) {
      const [created] = await tx
        .insert(calendars)
        .values({
          userId,
          source: "holidays",
          name: "日本の祝日",
          color: "#f43f5e",
          timeZone: "Asia/Tokyo",
          readOnly: true,
          etag: version,
          lastSyncedAt: new Date(),
        })
        .returning({ id: calendars.id });
      if (!created) return;
      calendarId = created.id;
    } else {
      await tx
        .update(calendars)
        .set({ etag: version, lastSyncedAt: new Date() })
        .where(eq(calendars.id, calendarId));
    }
    const { upserted, deleted } = await replaceCalendarEvents(
      tx,
      { userId, calendarId },
      holidayEvents(today),
    );
    await recordChanges(tx, userId, "calendar", [calendarId]);
    await recordChanges(tx, userId, "event", upserted);
    await recordChanges(tx, userId, "event", deleted, "delete");
  });
}
