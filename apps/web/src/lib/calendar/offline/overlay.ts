import { normalizeRecurrenceId } from "@orbit/core/recurrence";
import { Temporal } from "temporal-polyfill";
import type {
  Attendee,
  AttendeeStatus,
  Calendar,
  CalendarEvent,
  EventFields,
} from "@/lib/calendar/api";
import type {
  CalendarChanges,
  CreateEventInput,
  QueuedOp,
} from "@/lib/calendar/offline/types";

/**
 * サーバーの内容の控え (base) に、送信待ちの操作を重ねて、画面に出す内容を作る。
 * base には楽観的な値を書かない。取り消しは送信待ちから外すだけで済む
 * (メールの PendingOverlay と同じ考え方)。
 */

export type CalendarView = {
  events: Map<string, CalendarEvent>;
  calendars: Map<string, Calendar>;
};

/** 回の操作でまだ例外の行が無いときに、表示用に作る仮の例外の ID。 */
export function provisionalExceptionId(
  masterId: string,
  recurrenceId: string,
): string {
  return `${masterId}:${normalizeRecurrenceId(recurrenceId)}`;
}

const toIso = (value: string) => new Date(value).toISOString();

function nextDay(date: string): string {
  return Temporal.PlainDate.from(date).add({ days: 1 }).toString();
}

/** 項目の変更を予定に当てる (サーバーの fieldColumns / replaceExtras と同じ値にする)。 */
export function applyFields(
  event: CalendarEvent,
  fields: EventFields,
): CalendarEvent {
  const next: CalendarEvent = { ...event };
  if (fields.summary !== undefined) next.summary = fields.summary;
  if (fields.location !== undefined) next.location = fields.location;
  if (fields.description !== undefined) next.description = fields.description;
  if (fields.status !== undefined) next.status = fields.status;
  if (fields.busy !== undefined) next.busy = fields.busy;
  if (fields.conferenceUrl !== undefined)
    next.conferenceUrl = fields.conferenceUrl;
  if (fields.useDefaultReminders !== undefined)
    next.useDefaultReminders = fields.useDefaultReminders;
  if (fields.reminders !== undefined)
    next.reminders = [...fields.reminders].sort(
      (a, b) => a.minutes - b.minutes,
    );
  if (fields.time !== undefined) {
    const time = fields.time;
    if (time.allDay) {
      Object.assign(next, {
        allDay: true,
        startDate: time.startDate,
        endDate: time.endDate,
        startAt: null,
        endAt: null,
        startTimeZone: null,
        endTimeZone: null,
      });
    } else {
      Object.assign(next, {
        allDay: false,
        startAt: toIso(time.startAt),
        endAt: toIso(time.endAt),
        startDate: null,
        endDate: null,
        startTimeZone: time.startTimeZone,
        endTimeZone: time.endTimeZone ?? time.startTimeZone,
      });
    }
  }
  if (fields.recurrence !== undefined) {
    next.rrule = fields.recurrence.rrule?.replace(/^RRULE:/i, "") ?? null;
    next.rdates = (fields.recurrence.rdates ?? []).map(normalizeRecurrenceId);
    next.exdates = (fields.recurrence.exdates ?? []).map(normalizeRecurrenceId);
  }
  if (fields.attendees !== undefined) {
    const known = new Map(
      event.attendees.map((attendee) => [attendee.email, attendee]),
    );
    next.attendees = fields.attendees.map((attendee): Attendee => {
      const email = attendee.email.trim().toLowerCase();
      const existing = known.get(email);
      return {
        // 返事のコメントなど、変えない項目は残す (新しいサーバーだけの項目も落とさない)。
        ...existing,
        email,
        name: attendee.name ?? null,
        role: attendee.role ?? "required",
        status: existing?.status ?? "needs_action",
        self: existing?.self ?? false,
      };
    });
  }
  return next;
}

/** 予定の今の値を、項目の形 (EventFields) で取り出す。keys を渡すとその項目だけ。 */
export function eventFieldsOf(
  event: CalendarEvent,
  keys?: readonly (keyof EventFields)[],
): EventFields {
  const all: Required<EventFields> = {
    summary: event.summary,
    location: event.location,
    description: event.description,
    status: event.status,
    busy: event.busy,
    time:
      event.allDay && event.startDate
        ? {
            allDay: true,
            startDate: event.startDate,
            endDate:
              event.endDate && event.endDate > event.startDate
                ? event.endDate
                : nextDay(event.startDate),
          }
        : {
            allDay: false,
            startAt: event.startAt ?? "",
            endAt: event.endAt ?? event.startAt ?? "",
            startTimeZone: event.startTimeZone,
            endTimeZone: event.endTimeZone,
          },
    recurrence: {
      rrule: event.rrule,
      rdates: event.rdates,
      exdates: event.exdates,
    },
    conferenceUrl: event.conferenceUrl,
    useDefaultReminders: event.useDefaultReminders,
    reminders: event.reminders,
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      name: attendee.name,
      role: attendee.role,
    })),
  };
  if (!keys) return all;
  const picked: EventFields = {};
  for (const key of keys) {
    (picked as Record<string, unknown>)[key] = all[key];
  }
  return picked;
}

/** 作成の中身から、表示用の予定を作る (サーバーの応答が届くまでの仮の値)。 */
export function eventFromInput(
  input: CreateEventInput & { id: string },
  at: string,
): CalendarEvent {
  const { id, calendarId, ...fields } = input;
  const blank: CalendarEvent = {
    id,
    calendarId,
    uid: `${id}@orbit`,
    recurrenceId: null,
    parentId: null,
    summary: null,
    location: null,
    description: null,
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: null,
    endAt: null,
    startDate: null,
    endDate: null,
    startTimeZone: null,
    endTimeZone: null,
    rrule: null,
    rdates: [],
    exdates: [],
    organizer: null,
    sequence: 0,
    conferenceUrl: null,
    useDefaultReminders: true,
    reminders: [],
    attendees: [],
    fieldUpdatedAt: {},
    updatedAt: at,
  };
  const event = applyFields(blank, fields);
  // 参加者のいる新しい予定は自分が主催者 (サーバーも作成時に仮の主催者を入れる)。
  // 印が無いと、届くまでの間に役割が「none」になり、参加者の欄が無効になる。
  return event.attendees.length > 0 && event.organizer === null
    ? { ...event, organizer: { email: "", self: true } }
    : event;
}

/**
 * 原本の回 (recurrenceId) を写した仮の例外を作る
 * (サーバーの findOrCreateException と同じ写し方)。
 */
export function provisionalException(
  master: CalendarEvent,
  recurrenceId: string,
): CalendarEvent {
  const rid = normalizeRecurrenceId(recurrenceId);
  const timing = eventFieldsOf(master, ["time"]).time;
  let time: EventFields["time"];
  if (timing?.allDay) {
    const days = Math.max(
      Temporal.PlainDate.from(timing.startDate).until(
        Temporal.PlainDate.from(timing.endDate),
        { largestUnit: "days" },
      ).days,
      1,
    );
    const start = Temporal.PlainDate.from(rid.slice(0, 10));
    time = {
      allDay: true,
      startDate: start.toString(),
      endDate: start.add({ days }).toString(),
    };
  } else if (timing?.startAt) {
    const span = Math.max(
      Date.parse(timing.endAt) - Date.parse(timing.startAt),
      0,
    );
    const start = Date.parse(rid);
    time = {
      allDay: false,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + span).toISOString(),
      startTimeZone: master.startTimeZone,
      endTimeZone: master.endTimeZone,
    };
  }
  const base: CalendarEvent = {
    ...master,
    id: provisionalExceptionId(master.id, rid),
    recurrenceId: rid,
    parentId: master.id,
    rrule: null,
    rdates: [],
    exdates: [],
    fieldUpdatedAt: {},
  };
  return time ? applyFields(base, { time }) : base;
}

/** 原本の例外 (recurrenceId が同じもの) を探す。 */
export function findException(
  events: ReadonlyMap<string, CalendarEvent>,
  masterId: string,
  recurrenceId: string,
): CalendarEvent | undefined {
  const rid = normalizeRecurrenceId(recurrenceId);
  const provisional = events.get(provisionalExceptionId(masterId, rid));
  if (provisional) return provisional;
  for (const event of events.values()) {
    if (
      event.parentId === masterId &&
      event.recurrenceId !== null &&
      normalizeRecurrenceId(event.recurrenceId) === rid
    ) {
      return event;
    }
  }
  return undefined;
}

function removeWithExceptions(
  events: Map<string, CalendarEvent>,
  id: string,
): void {
  events.delete(id);
  for (const [key, event] of events) {
    if (event.parentId === id) events.delete(key);
  }
}

function addExdate(
  events: Map<string, CalendarEvent>,
  masterId: string,
  recurrenceId: string,
): void {
  const master = events.get(masterId);
  if (!master) return;
  const rid = normalizeRecurrenceId(recurrenceId);
  if (!master.exdates.map(normalizeRecurrenceId).includes(rid)) {
    events.set(masterId, { ...master, exdates: [...master.exdates, rid] });
  }
}

/**
 * 1 つの操作を予定の一覧に当てる (events は書き換える)。
 * 送信が終わって応答に予定が無い操作 (削除) を base に当てるときにも使う。
 */
export function applyOpToEvents(
  events: Map<string, CalendarEvent>,
  op: QueuedOp,
): void {
  switch (op.kind) {
    case "create": {
      const input = op.body as CreateEventInput & { id: string };
      const existing = events.get(input.id);
      if (existing) {
        const { id: _id, calendarId: _calendar, ...fields } = input;
        events.set(input.id, applyFields(existing, fields));
      } else {
        events.set(input.id, eventFromInput(input, op.at));
      }
      return;
    }
    case "update": {
      if (!op.eventId) return;
      const existing = events.get(op.eventId);
      if (existing)
        events.set(op.eventId, applyFields(existing, op.body as EventFields));
      return;
    }
    case "occurrence_update": {
      if (!op.eventId || !op.recurrenceId) return;
      const master = events.get(op.eventId);
      const existing = findException(events, op.eventId, op.recurrenceId);
      if (existing) {
        events.set(existing.id, applyFields(existing, op.body as EventFields));
      } else if (master) {
        const created = applyFields(
          provisionalException(master, op.recurrenceId),
          op.body as EventFields,
        );
        events.set(created.id, created);
      }
      return;
    }
    case "delete": {
      if (!op.eventId) return;
      const existing = events.get(op.eventId);
      // 例外を消す = その回を消す (サーバーと同じく、原本の EXDATE に足す)。
      if (existing?.parentId && existing.recurrenceId) {
        addExdate(events, existing.parentId, existing.recurrenceId);
      }
      removeWithExceptions(events, op.eventId);
      return;
    }
    case "occurrence_delete": {
      if (!op.eventId || !op.recurrenceId) return;
      addExdate(events, op.eventId, op.recurrenceId);
      const exception = findException(events, op.eventId, op.recurrenceId);
      if (exception) events.delete(exception.id);
      return;
    }
    case "respond": {
      if (!op.eventId) return;
      const existing = events.get(op.eventId);
      if (!existing) return;
      const status = (op.body as { status: AttendeeStatus }).status;
      events.set(op.eventId, {
        ...existing,
        attendees: existing.attendees.map((attendee) =>
          attendee.self ? { ...attendee, status } : attendee,
        ),
      });
      return;
    }
    case "calendar_update":
      return;
  }
}

/**
 * base に送信待ちを重ねた内容。error の操作 (サーバーに断られたもの) は重ねない
 * (反映されなかった変更の一覧に出る)。base の Map は書き換えない。
 */
export function overlay(
  baseEvents: ReadonlyMap<string, CalendarEvent>,
  baseCalendars: ReadonlyMap<string, Calendar>,
  queue: readonly QueuedOp[],
): CalendarView {
  const active = queue.filter((op) => op.state !== "error");
  if (active.length === 0) {
    return { events: new Map(baseEvents), calendars: new Map(baseCalendars) };
  }
  const events = new Map(baseEvents);
  const calendars = new Map(baseCalendars);
  for (const op of active) {
    if (op.kind === "calendar_update") {
      const existing = calendars.get(op.calendarId);
      if (existing) {
        calendars.set(op.calendarId, {
          ...existing,
          ...(op.body as CalendarChanges),
        });
      }
      continue;
    }
    applyOpToEvents(events, op);
  }
  return { events, calendars };
}
