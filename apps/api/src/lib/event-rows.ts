import { normalizeRecurrenceId } from "@orbit/core";
import {
  type Database,
  eventAttendees,
  eventReminders,
  events,
} from "@orbit/db";
import { eq } from "drizzle-orm";

/**
 * 予定の行と、そのリマインダー・参加者を入れる処理 (calendars.ts と、メールの招待の取り込み
 * (message-invite.ts、段取り 8b) で使う)。値の検査は呼ぶ側が済ませておく。
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EventRow = typeof events.$inferSelect;
type AttendeeRow = typeof eventAttendees.$inferSelect;

/** 予定の時刻。終日は日付 (endDate はその日を含まない)、時刻付きは ISO 8601 とタイムゾーン。 */
export type EventTimingInput =
  | { allDay: true; startDate: string; endDate: string }
  | {
      allDay: false;
      startAt: string;
      endAt: string;
      startTimeZone: string | null;
      endTimeZone?: string | null;
    };

export type EventRecurrenceInput = {
  /** RRULE の値 (先頭の "RRULE:" はあってもよい)。null は繰り返さない。 */
  rrule: string | null;
  rdates: readonly string[] | null;
  exdates: readonly string[] | null;
};

/**
 * 参加者 1 人分。status / self / comment / repliedAt / replySequence は、省けば同じアドレスの
 * いまの行から引き継ぐ (無ければ needs_action / false / null)。API の PATCH はアドレス・名前・
 * 役割だけを渡し、メールの招待の取り込みは出欠と self も渡す。
 */
export type EventAttendeeInput = {
  email: string;
  name: string | null;
  role: AttendeeRow["role"];
  status?: AttendeeRow["status"];
  self?: boolean;
  comment?: string | null;
  repliedAt?: Date | null;
  replySequence?: number | null;
};

/** 項目ごとの値 (calendars.ts の eventFields と同じ形)。undefined の項目は触らない。 */
export type EventFieldsInput = {
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  status?: EventRow["status"];
  busy?: boolean;
  time?: EventTimingInput;
  recurrence?: EventRecurrenceInput;
  conferenceUrl?: string | null;
  useDefaultReminders?: boolean;
  reminders?: readonly { method: "display" | "email"; minutes: number }[];
  attendees?: readonly EventAttendeeInput[];
};

/** 時刻の項目を列の値にする。 */
export function timingColumns(value: EventTimingInput) {
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

/** 項目の値を列の値にする (予定の行に入る項目だけ。リマインダーと参加者は別の表)。 */
export function eventFieldColumns(
  fields: EventFieldsInput,
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

const lower = (email: string) => email.trim().toLowerCase();

/**
 * リマインダーと参加者を入れ直す (fields にある方だけ)。参加者は、同じアドレス (大文字小文字を
 * 無視) の行が残るなら、出欠・self・コメント・最後に反映した返事 (replied_at / reply_sequence)
 * を引き継ぐ。同じアドレスが重なれば後の方を使う。
 */
export async function replaceEventExtras(
  tx: Tx,
  eventId: string,
  fields: Pick<EventFieldsInput, "reminders" | "attendees">,
) {
  if (fields.reminders !== undefined) {
    await tx.delete(eventReminders).where(eq(eventReminders.eventId, eventId));
    if (fields.reminders.length > 0) {
      await tx
        .insert(eventReminders)
        .values(fields.reminders.map((value) => ({ eventId, ...value })));
    }
  }
  if (fields.attendees !== undefined) {
    const before = await tx
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));
    const previous = new Map(before.map((row) => [lower(row.email), row]));
    await tx.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId));
    const unique = new Map(
      fields.attendees.map((value) => [lower(value.email), value]),
    );
    if (unique.size > 0) {
      await tx.insert(eventAttendees).values(
        [...unique].map(([key, value]) => {
          const old = previous.get(key);
          return {
            eventId,
            email: value.email,
            name: value.name,
            role: value.role,
            status: value.status ?? old?.status ?? "needs_action",
            self: value.self ?? old?.self ?? false,
            comment:
              value.comment !== undefined
                ? value.comment
                : (old?.comment ?? null),
            repliedAt:
              value.repliedAt !== undefined
                ? value.repliedAt
                : (old?.repliedAt ?? null),
            replySequence:
              value.replySequence !== undefined
                ? value.replySequence
                : (old?.replySequence ?? null),
          };
        }),
      );
    }
  }
}

export type InsertEventInput = {
  /** 省けば新しい UUID。 */
  id?: string;
  userId: string;
  calendarId: string;
  /** 省けば `<id>@orbit` (Orbit で作った予定)。メールから取り込む予定は相手の UID。 */
  uid?: string;
  fields: EventFieldsInput;
  organizer: EventRow["organizer"];
  fieldUpdatedAt: Record<string, string>;
  /** 繰り返しの例外として入れるとき。 */
  recurrenceId?: string | null;
  parentId?: string | null;
  sequence?: number;
  /** メールから取り込んだ招待の DTSTAMP。 */
  inviteStamp?: Date | null;
};

/**
 * 予定の行を入れ、リマインダーと参加者を入れる。同じ ID の行が既にあれば何もせず null
 * (呼ぶ側が既存の行を読んで扱う)。変更履歴 (recordChanges) と書き戻し・招待メールは呼ぶ側が行う。
 */
export async function insertEvent(
  tx: Tx,
  input: InsertEventInput,
): Promise<EventRow | null> {
  const id = input.id ?? crypto.randomUUID();
  const [row] = await tx
    .insert(events)
    .values({
      id,
      userId: input.userId,
      calendarId: input.calendarId,
      uid: input.uid ?? `${id}@orbit`,
      ...eventFieldColumns(input.fields),
      organizer: input.organizer,
      fieldUpdatedAt: input.fieldUpdatedAt,
      ...(input.recurrenceId !== undefined
        ? { recurrenceId: input.recurrenceId }
        : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      ...(input.inviteStamp !== undefined
        ? { inviteStamp: input.inviteStamp }
        : {}),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await replaceEventExtras(tx, row.id, input.fields);
  return row;
}
