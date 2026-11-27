import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema.js";
import {
  type CalendarReminder,
  eventAttendees,
  eventReminders,
  events,
} from "./schema.js";

/**
 * 同期で受け取った予定 (ICS の購読、祝日、CalDAV など) を、カレンダーの予定とそろえる。
 * 中身 (raw) の変わらない予定は触らない。
 */

/** 取り込む予定 (@orbit/core の ParsedEvent と同じ形)。 */
export type CalendarEventInput = {
  uid: string;
  recurrenceId: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  busy: boolean;
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  endTimeZone: string | null;
  rrule: string | null;
  rdates: string[] | null;
  exdates: string[] | null;
  organizer: { email: string; name?: string } | null;
  attendees: {
    email: string;
    name: string | null;
    role: "chair" | "required" | "optional" | "non_participant";
    status:
      | "needs_action"
      | "accepted"
      | "declined"
      | "tentative"
      | "delegated";
  }[];
  sequence: number;
  conferenceUrl: string | null;
  remoteUpdatedAt: string | null;
  reminders: CalendarReminder[] | null;
  raw: string;
};

type Executor = Pick<
  NodePgDatabase<typeof schema>,
  "select" | "insert" | "update" | "delete"
>;

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const keyOf = (uid: string, recurrenceId: string | null) =>
  `${uid}\u0000${recurrenceId ?? ""}`;

function columns(input: CalendarEventInput, parentId: string | null) {
  return {
    uid: input.uid,
    recurrenceId: input.recurrenceId,
    parentId,
    summary: input.summary,
    location: input.location,
    description: input.description,
    status: input.status,
    busy: input.busy,
    allDay: input.allDay,
    startAt: input.startAt ? new Date(input.startAt) : null,
    endAt: input.endAt ? new Date(input.endAt) : null,
    startDate: input.startDate,
    endDate: input.endDate,
    startTimeZone: input.startTimeZone,
    endTimeZone: input.endTimeZone,
    rrule: input.rrule,
    rdates: input.rdates,
    exdates: input.exdates,
    organizer: input.organizer,
    sequence: input.sequence,
    conferenceUrl: input.conferenceUrl,
    useDefaultReminders: input.reminders === null,
    remoteUpdatedAt: input.remoteUpdatedAt
      ? new Date(input.remoteUpdatedAt)
      : null,
    raw: input.raw,
  };
}

/**
 * カレンダーの予定を inputs と同じにする。返すのは、作った・変えた予定と、消した予定の ID
 * (変更履歴に記録するため)。トランザクションの中で呼ぶ。
 */
export async function replaceCalendarEvents(
  tx: Executor,
  { userId, calendarId }: { userId: string; calendarId: string },
  inputs: readonly CalendarEventInput[],
): Promise<{ upserted: string[]; deleted: string[] }> {
  const existing = await tx
    .select({
      id: events.id,
      uid: events.uid,
      recurrenceId: events.recurrenceId,
      parentId: events.parentId,
      raw: events.raw,
    })
    .from(events)
    .where(eq(events.calendarId, calendarId));
  const byKey = new Map(
    existing.map((row) => [keyOf(row.uid, row.recurrenceId), row]),
  );
  const wanted = new Map<string, CalendarEventInput>();
  for (const input of inputs)
    wanted.set(keyOf(input.uid, input.recurrenceId), input);

  // 原本 (と繰り返さない予定) を先に入れ、例外の parentId に使う。
  const masterIds = new Map<string, string>();
  const upserted: string[] = [];
  const ordered = [...wanted.values()].sort(
    (a, b) => Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null),
  );

  const inserts: { input: CalendarEventInput; parentId: string | null }[] = [];
  const flushInserts = async () => {
    for (const batch of chunks(inserts.splice(0))) {
      const rows = await tx
        .insert(events)
        .values(
          batch.map(({ input, parentId }) => ({
            userId,
            calendarId,
            ...columns(input, parentId),
          })),
        )
        .returning({
          id: events.id,
          uid: events.uid,
          recurrenceId: events.recurrenceId,
        });
      const reminderRows: (typeof eventReminders.$inferInsert)[] = [];
      const attendeeRows: (typeof eventAttendees.$inferInsert)[] = [];
      for (const row of rows) {
        if (row.recurrenceId === null) masterIds.set(row.uid, row.id);
        upserted.push(row.id);
        const input = wanted.get(keyOf(row.uid, row.recurrenceId));
        if (!input) continue;
        for (const value of input.reminders ?? []) {
          reminderRows.push({ eventId: row.id, ...value });
        }
        attendeeRows.push(...attendeeValues(row.id, input));
      }
      for (const part of chunks(reminderRows)) {
        await tx.insert(eventReminders).values(part);
      }
      for (const part of chunks(attendeeRows)) {
        await tx.insert(eventAttendees).values(part);
      }
    }
  };

  let flushedMasters = false;
  for (const input of ordered) {
    if (input.recurrenceId !== null && !flushedMasters) {
      await flushInserts();
      flushedMasters = true;
    }
    const parentId =
      input.recurrenceId === null ? null : (masterIds.get(input.uid) ?? null);
    const row = byKey.get(keyOf(input.uid, input.recurrenceId));
    if (!row) {
      inserts.push({ input, parentId });
      continue;
    }
    if (input.recurrenceId === null) masterIds.set(input.uid, row.id);
    if (row.raw === input.raw && row.parentId === parentId) continue;
    await tx
      .update(events)
      .set(columns(input, parentId))
      .where(eq(events.id, row.id));
    await replaceExtras(tx, row.id, input);
    upserted.push(row.id);
  }
  await flushInserts();

  const deleted = existing
    .filter((row) => !wanted.has(keyOf(row.uid, row.recurrenceId)))
    .map((row) => row.id);
  for (const batch of chunks(deleted)) {
    await tx
      .delete(events)
      .where(and(eq(events.calendarId, calendarId), inArray(events.id, batch)));
  }
  return { upserted, deleted };
}

async function replaceExtras(
  tx: Executor,
  eventId: string,
  input: CalendarEventInput,
) {
  await tx.delete(eventReminders).where(eq(eventReminders.eventId, eventId));
  if (input.reminders && input.reminders.length > 0) {
    await tx
      .insert(eventReminders)
      .values(input.reminders.map((value) => ({ eventId, ...value })));
  }
  await tx.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId));
  const attendees = attendeeValues(eventId, input);
  if (attendees.length > 0) await tx.insert(eventAttendees).values(attendees);
}

function attendeeValues(
  eventId: string,
  input: CalendarEventInput,
): (typeof eventAttendees.$inferInsert)[] {
  return input.attendees.map((value) => ({
    eventId,
    email: value.email,
    name: value.name,
    role: value.role,
    status: value.status,
  }));
}
