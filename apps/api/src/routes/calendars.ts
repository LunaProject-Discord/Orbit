import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  CALENDAR_WRITEBACK_SOURCES,
  type EventFieldName,
  type EventTiming,
  expandOccurrences,
  HOLIDAYS_VERSION,
  holidayEvents,
  loadSubscription,
  normalizeRecurrenceId,
  type RecurrenceException,
  subscriptionUrlCandidates,
} from "@orbit/core";
import {
  accounts,
  calendars,
  changes,
  type Database,
  eventAttendees,
  eventReminders,
  eventSearch,
  events,
  outbox,
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
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { recordChanges } from "../lib/changes.js";
import {
  enqueueEventOperation,
  eventCreateKey,
  eventDeleteKey,
  eventUpdateKey,
  isProviderCalendar,
  lockCalendarAccount,
} from "../lib/event-outbox.js";

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

const recurrenceIdValue = z
  .string()
  .max(40)
  .refine((value) => /^\d{4}-\d{2}-\d{2}(T.+)?$/.test(value));

const recurrence = z.object({
  /** RRULE の値。null で繰り返しをやめる。 */
  rrule: z
    .string()
    .max(1000)
    .regex(/^(RRULE:)?FREQ=/i)
    .nullable(),
  rdates: z.array(recurrenceIdValue).max(1000).nullable().default(null),
  exdates: z.array(recurrenceIdValue).max(5000).nullable().default(null),
});

const reminder = z.object({
  method: z.enum(["display", "email"]),
  minutes: z
    .number()
    .int()
    .min(0)
    .max(40 * 24 * 60),
});

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
    conferenceUrl: z.url().max(2000).nullable(),
    useDefaultReminders: z.boolean(),
    reminders: z.array(reminder).max(20),
    attendees: z.array(attendee).max(500),
  })
  .partial();
type EventFields = z.infer<typeof eventFields>;
type FieldName = keyof EventFields;

const eventCreate = eventFields
  .extend({
    /** 端末が決める ID (オフラインで作った予定を、再送しても二重に作らない)。 */
    id: z.uuid().optional(),
    calendarId: z.uuid(),
    time: timing,
  })
  .strict();

const eventPatch = z.object({
  changes: eventFields.strict(),
  /**
   * 項目ごとの、端末で変えた時刻 (ISO 8601)。無い項目は届いた時刻。
   * サーバーにある同じ項目の変更の方が新しければ、その項目は変えない (rejected で返す)。
   */
  changedAt: z.record(z.string(), z.iso.datetime({ offset: true })).default({}),
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
function publicCalendar(row: CalendarRow, writable: ReadonlySet<string>) {
  return {
    id: row.id,
    accountId: row.accountId,
    source: row.source,
    name: row.name,
    description: row.description,
    color: row.color,
    timeZone: row.timeZone,
    readOnly: row.readOnly || !isWritable(row, writable),
    visible: row.visible,
    sortOrder: row.sortOrder,
    url: row.url,
    pollIntervalSeconds: row.pollIntervalSeconds,
    defaultReminders: row.defaultReminders ?? [],
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

/**
 * Orbit から予定を書き込めるカレンダーか。Orbit 内のカレンダーと、書き戻しに対応した
 * プロバイダ (writable、既定は CALENDAR_WRITEBACK_SOURCES) のアカウントのカレンダー。
 */
function isWritable(row: CalendarRow, writable: ReadonlySet<string>): boolean {
  if (row.readOnly) return false;
  if (row.source === "local") return true;
  return writable.has(row.source) && row.accountId !== null;
}

type EventExtras = {
  reminders: { method: "display" | "email"; minutes: number }[];
  attendees: {
    email: string;
    name: string | null;
    role: string;
    status: string;
    self: boolean;
  }[];
};

function publicEvent(row: EventRow, extras: EventExtras) {
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
    organizer: row.organizer,
    sequence: row.sequence,
    conferenceUrl: row.conferenceUrl,
    useDefaultReminders: row.useDefaultReminders,
    reminders: extras.reminders,
    attendees: extras.attendees,
    fieldUpdatedAt: row.fieldUpdatedAt ?? {},
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadExtras(
  db: Database | Tx,
  ids: string[],
): Promise<Map<string, EventExtras>> {
  const map = new Map<string, EventExtras>();
  for (const id of ids) map.set(id, { reminders: [], attendees: [] });
  if (ids.length === 0) return map;
  const [reminderRows, attendeeRows] = await Promise.all([
    db
      .select()
      .from(eventReminders)
      .where(inArray(eventReminders.eventId, ids))
      .orderBy(asc(eventReminders.minutes)),
    db
      .select()
      .from(eventAttendees)
      .where(inArray(eventAttendees.eventId, ids))
      .orderBy(asc(eventAttendees.id)),
  ]);
  for (const row of reminderRows) {
    map.get(row.eventId)?.reminders.push({
      method: row.method,
      minutes: row.minutes,
    });
  }
  for (const row of attendeeRows) {
    map.get(row.eventId)?.attendees.push({
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      self: row.self,
    });
  }
  return map;
}

async function publicEvents(db: Database | Tx, rows: EventRow[]) {
  const extras = await loadExtras(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    publicEvent(row, extras.get(row.id) ?? { reminders: [], attendees: [] }),
  );
}

/** 時刻の項目を列の値にする。 */
function timingColumns(value: z.infer<typeof timing>) {
  return value.allDay
    ? {
        allDay: true,
        startDate: value.startDate,
        endDate: value.endDate,
        startAt: null,
        endAt: null,
        startTimeZone: null,
        endTimeZone: null,
      }
    : {
        allDay: false,
        startAt: new Date(value.startAt),
        endAt: new Date(value.endAt),
        startDate: null,
        endDate: null,
        startTimeZone: value.startTimeZone,
        endTimeZone: value.endTimeZone ?? value.startTimeZone,
      };
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

/** 項目の値を列の値にする (予定の行に入る項目だけ。リマインダーと参加者は別の表)。 */
function fieldColumns(
  fields: EventFields,
): Partial<typeof events.$inferInsert> {
  const columns: Partial<typeof events.$inferInsert> = {};
  if (fields.summary !== undefined) columns.summary = fields.summary;
  if (fields.location !== undefined) columns.location = fields.location;
  if (fields.description !== undefined)
    columns.description = fields.description;
  if (fields.status !== undefined) columns.status = fields.status;
  if (fields.busy !== undefined) columns.busy = fields.busy;
  if (fields.conferenceUrl !== undefined)
    columns.conferenceUrl = fields.conferenceUrl;
  if (fields.useDefaultReminders !== undefined)
    columns.useDefaultReminders = fields.useDefaultReminders;
  if (fields.time !== undefined)
    Object.assign(columns, timingColumns(fields.time));
  if (fields.recurrence !== undefined) {
    columns.rrule = fields.recurrence.rrule?.replace(/^RRULE:/i, "") ?? null;
    columns.rdates =
      fields.recurrence.rdates?.map(normalizeRecurrenceId) ?? null;
    columns.exdates =
      fields.recurrence.exdates?.map(normalizeRecurrenceId) ?? null;
  }
  return columns;
}

async function replaceExtras(tx: Tx, eventId: string, fields: EventFields) {
  if (fields.reminders !== undefined) {
    await tx.delete(eventReminders).where(eq(eventReminders.eventId, eventId));
    if (fields.reminders.length > 0) {
      await tx
        .insert(eventReminders)
        .values(fields.reminders.map((value) => ({ eventId, ...value })));
    }
  }
  if (fields.attendees !== undefined) {
    // 出欠は、同じアドレスの参加者が残るなら引き継ぐ。
    const before = await tx
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));
    const previous = new Map(
      before.map((row) => [row.email.toLowerCase(), row]),
    );
    await tx.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId));
    const unique = new Map(
      fields.attendees.map((value) => [value.email, value]),
    );
    if (unique.size > 0) {
      await tx.insert(eventAttendees).values(
        [...unique.values()].map((value) => {
          const old = previous.get(value.email);
          return {
            eventId,
            email: value.email,
            name: value.name,
            role: value.role,
            status: old?.status ?? "needs_action",
            self: old?.self ?? false,
            comment: old?.comment ?? null,
          };
        }),
      );
    }
  }
}

/**
 * プロバイダのカレンダーに書き込めない状態なら、その理由を返す (API は 409 にする)。
 * - calendar_disabled: アカウントの calendarEnabled が false (同期が動かず、書き戻しが溜まるだけ)。
 * - calendar_sync_stopped: 認証の失敗などで同期が止まっている (accounts.calendarError がある。
 *   同期ワーカーは、止まったときだけ calendarError を書く)。
 * Orbit 内のカレンダーなどは null。
 */
async function providerWriteBlocked(
  tx: Tx,
  calendar: Pick<CalendarRow, "source" | "accountId">,
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

/**
 * 予定の取得と変更。プロバイダのカレンダーは、書き戻しに対応したものだけ変えられ、
 * 変更は outbox に積んで同期ワーカーがプロバイダへ反映する。
 */
export function calendarRoutes({
  db,
  allowPrivateMailHosts = false,
  fetchImpl,
  writebackSources = CALENDAR_WRITEBACK_SOURCES,
}: Pick<RouteDeps, "db"> &
  Partial<Pick<RouteDeps, "allowPrivateMailHosts">> & {
    /** ICS の取得 (テストで差し替える)。 */
    fetchImpl?: typeof fetch;
    /** 予定を書き戻せるプロバイダの source (テストで差し替える)。 */
    writebackSources?: readonly string[];
  }) {
  const app = new Hono<AppEnv>();
  const writable: ReadonlySet<string> = new Set(writebackSources);
  const toPublic = (row: CalendarRow) => publicCalendar(row, writable);
  const canWrite = (row: CalendarRow | undefined): row is CalendarRow =>
    row !== undefined && isWritable(row, writable);

  /** applyChanges で採用した項目があれば、変更の書き戻しを積む。 */
  const enqueueUpdate = async (
    tx: Tx,
    calendar: CalendarRow,
    row: EventRow,
    accepted: EventFields,
  ) => {
    const fields = (Object.keys(accepted) as FieldName[])
      .filter((key) => accepted[key] !== undefined)
      .sort();
    if (fields.length === 0) return;
    await enqueueEventOperation(
      tx,
      calendar,
      {
        kind: "event_update",
        payload: {
          eventId: row.id,
          calendarId: calendar.id,
          fields: fields satisfies EventFieldName[],
        },
      },
      eventUpdateKey(
        row.id,
        fields,
        row.fieldUpdatedAt ?? {},
        Object.fromEntries(fields.map((key) => [key, accepted[key]])),
      ),
    );
  };

  /**
   * 繰り返しの 1 回を、原本の EXDATE に足して取り消す。プロバイダのカレンダーなら、
   * 原本の繰り返しの変更 (event_update { fields: ["recurrence"] }) を積む。
   */
  const excludeOccurrence = async (
    tx: Tx,
    calendar: CalendarRow,
    master: EventRow,
    recurrenceId: string,
  ) => {
    const exdates = [...new Set([...(master.exdates ?? []), recurrenceId])];
    const fieldUpdatedAt = {
      ...(master.fieldUpdatedAt ?? {}),
      recurrence: new Date().toISOString(),
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
  };

  /**
   * 消した予定 (eventIds、例外も含む) に向けた、まだ実行していない作成と変更の書き戻しを取り消す。
   * 作成が確定して失敗した行も、予定ごと消えるので片付ける。
   */
  const cancelPendingWrites = async (
    tx: Tx,
    calendar: CalendarRow,
    eventIds: string[],
  ) => {
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
  };

  /**
   * 予定 (原本か単発) を消したときの書き戻しを積む。cancelPendingWrites のあとに呼ぶ。
   * 作成をまだ書き戻していなければ (remoteId が無い)、相手側に何も無いので積まない。
   * ただし作成の書き戻しを実行中なら、相手側にできる予定を消すために積む (remoteId は null)。
   */
  const enqueueDelete = async (
    tx: Tx,
    calendar: CalendarRow,
    row: EventRow,
  ) => {
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
          deletedAt: new Date().toISOString(),
        },
      },
      eventDeleteKey(row.id),
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
    return c.json({ calendars: rows.map(toPublic) });
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
    return c.json({ calendar: toPublic(created) }, 201);
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
      return c.json({ calendar: toPublic(created) }, 201);
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
      return c.json({ calendar: toPublic(updated) });
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
      return c.json({ calendar: toPublic(updated) });
    },
  );

  /** Orbit 内のカレンダーか購読を消す (予定もすべて消える)。祝日は非表示にできるだけ。 */
  app.delete(
    "/:id{[0-9a-fA-F-]{36}}",
    zValidator("param", idParam),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.var.user.id;
      const result = await db.transaction(async (tx) => {
        const row = await ownCalendar(tx, userId, id);
        if (!row) return "not_found" as const;
        if (row.source !== "local" && row.source !== "ics") {
          return "read_only" as const;
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
      });
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
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
    return c.json({
      calendars: calendarRows.map(toPublic),
      events: await publicEvents(db, eventRows),
      deleted: {
        calendars: calendarIds.filter((id) => !foundCalendars.has(id)),
        events: eventIds.filter((id) => !foundEvents.has(id)),
      },
      latestSeq: page.at(-1)?.seq.toString() ?? since,
      hasMore: rows.length > limit,
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
    const result = await db.transaction(async (tx) => {
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
      }
      const { id, calendarId, ...fields } = body;
      const fieldUpdatedAt = Object.fromEntries(
        Object.keys(fields).map((key) => [key, now.toISOString()]),
      );
      const eventId = id ?? randomUUID();
      const [row] = await tx
        .insert(events)
        .values({
          id: eventId,
          userId,
          calendarId,
          uid: `${eventId}@orbit`,
          ...fieldColumns(fields),
          fieldUpdatedAt,
        })
        .onConflictDoNothing()
        .returning();
      // 別の利用者が同じ ID を使っていた (ほぼ起きない)。
      if (!row) return "conflict" as const;
      await replaceExtras(tx, row.id, fields);
      await recordChanges(tx, userId, "event", [row.id]);
      // プロバイダのカレンダーなら、作成を書き戻す (中身は実行時に行から読む)。
      await enqueueEventOperation(
        tx,
        calendar,
        { kind: "event_create", payload: { eventId: row.id, calendarId } },
        eventCreateKey(row.id),
      );
      return row;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "read_only") return c.json({ error: "read_only" }, 409);
    if (result === "calendar_disabled" || result === "calendar_sync_stopped")
      return c.json({ error: result }, 409);
    if (result === "conflict") return c.json({ error: "conflict" }, 409);
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
      const result = await db.transaction(async (tx) => {
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
        const applied = await applyChanges(
          tx,
          userId,
          row,
          body.changes,
          body.changedAt,
        );
        await enqueueUpdate(tx, calendar, applied.row, applied.accepted);
        return applied;
      });
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if (result === "invalid") return c.json({ error: "invalid" }, 400);
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
      if (body.changes.recurrence !== undefined) {
        return c.json({ error: "invalid" }, 400);
      }
      const result = await db.transaction(async (tx) => {
        const master = await lockEventForWrite(tx, userId, id);
        if (!master || master.parentId) return "not_found" as const;
        const calendar = await ownCalendar(tx, userId, master.calendarId);
        if (!canWrite(calendar)) return "read_only" as const;
        const blocked = await providerWriteBlocked(tx, calendar);
        if (blocked) return blocked;
        const exception = await findOrCreateException(
          tx,
          userId,
          master,
          normalizeRecurrenceId(recurrenceId),
        );
        if (!exception) return "invalid" as const;
        const applied = await applyChanges(
          tx,
          userId,
          exception,
          body.changes,
          body.changedAt,
        );
        // 例外の行の変更として積む。例外の remoteId が無ければ、ワーカーがその回を
        // 上書きする書き込みとしてプロバイダへ渡す。
        await enqueueUpdate(tx, calendar, applied.row, applied.accepted);
        return applied;
      });
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
      if (result === "invalid") return c.json({ error: "invalid" }, 400);
      const [event] = await publicEvents(db, [result.row]);
      return c.json({ event, rejected: result.rejected });
    },
  );

  /** 繰り返しのうち 1 回だけを消す (原本の EXDATE に足し、例外があれば消す)。 */
  app.delete(
    "/events/:id{[0-9a-fA-F-]{36}}/occurrences/:recurrenceId",
    zValidator("param", occurrenceParam),
    async (c) => {
      const { id, recurrenceId } = c.req.valid("param");
      const userId = c.var.user.id;
      const normalized = normalizeRecurrenceId(recurrenceId);
      const result = await db.transaction(async (tx) => {
        const master = await lockEventForWrite(tx, userId, id);
        if (!master || master.parentId) return "not_found" as const;
        const calendar = await ownCalendar(tx, userId, master.calendarId);
        if (!canWrite(calendar)) return "read_only" as const;
        const blocked = await providerWriteBlocked(tx, calendar);
        if (blocked) return blocked;
        await excludeOccurrence(tx, calendar, master, normalized);
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
      });
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
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
      const result = await db.transaction(async (tx) => {
        const row = await lockEventForWrite(tx, userId, id);
        if (!row) return "not_found" as const;
        const calendar = await ownCalendar(tx, userId, row.calendarId);
        if (!canWrite(calendar)) return "read_only" as const;
        const blocked = await providerWriteBlocked(tx, calendar);
        if (blocked) return blocked;
        let master: EventRow | undefined;
        if (row.parentId && row.recurrenceId) {
          // 例外を消す = その回を消す。プロバイダへは原本の繰り返しの変更として書き戻す。
          [master] = await tx
            .select()
            .from(events)
            .where(eq(events.id, row.parentId))
            .for("update");
          if (master) {
            await excludeOccurrence(tx, calendar, master, row.recurrenceId);
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
        if (!master) await enqueueDelete(tx, calendar, row);
        await recordChanges(
          tx,
          userId,
          "event",
          removed.map((event) => event.id),
          "delete",
        );
        return "ok" as const;
      });
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (result === "read_only") return c.json({ error: "read_only" }, 409);
      if (result === "calendar_disabled" || result === "calendar_sync_stopped")
        return c.json({ error: result }, 409);
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

async function lockEvent(tx: Tx, userId: string, id: string) {
  const [row] = await tx
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.userId, userId)))
    .for("update");
  return row;
}

/**
 * 書き換える予定の行をロックする。プロバイダのカレンダーなら、先にカレンダーの同期の
 * アカウント単位のロックを取る (同期ワーカーと同じ順にして、デッドロックを避ける)。
 */
async function lockEventForWrite(tx: Tx, userId: string, id: string) {
  const [target] = await tx
    .select({ source: calendars.source, accountId: calendars.accountId })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(eq(events.id, id), eq(events.userId, userId)));
  if (target && isProviderCalendar(target)) {
    await lockCalendarAccount(tx, target.accountId);
  }
  return lockEvent(tx, userId, id);
}

async function applyChanges(
  tx: Tx,
  userId: string,
  row: EventRow,
  incoming: EventFields,
  changedAt: Record<string, string>,
) {
  const { accepted, fieldUpdatedAt, rejected } = mergeFields(
    row.fieldUpdatedAt ?? {},
    incoming,
    changedAt,
    new Date(),
  );
  if (Object.keys(accepted).length === 0) return { row, rejected, accepted };
  const [next] = await tx
    .update(events)
    .set({
      ...fieldColumns(accepted),
      fieldUpdatedAt,
      ...(accepted.time !== undefined || accepted.recurrence !== undefined
        ? { sequence: row.sequence + 1 }
        : {}),
    })
    .where(eq(events.id, row.id))
    .returning();
  await replaceExtras(tx, row.id, accepted);
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
      fieldUpdatedAt: master.fieldUpdatedAt,
    })
    .returning();
  if (!row) return null;
  // リマインダーと参加者も原本から写す。
  const extras = (await loadExtras(tx, [master.id])).get(master.id);
  if (extras) {
    if (extras.reminders.length > 0) {
      await tx
        .insert(eventReminders)
        .values(
          extras.reminders.map((value) => ({ eventId: row.id, ...value })),
        );
    }
    if (extras.attendees.length > 0) {
      await tx.insert(eventAttendees).values(
        extras.attendees.map((value) => ({
          eventId: row.id,
          email: value.email,
          name: value.name,
          role: value.role as "required",
          status: value.status as "needs_action",
          self: value.self,
        })),
      );
    }
  }
  return row;
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
