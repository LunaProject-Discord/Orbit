import {
  instantRecurrenceId,
  normalizeRecurrenceId,
  parseICalendar,
} from "@orbit/core";
import type { CalendarReminder } from "@orbit/db";
import type {
  CalendarRow,
  EventSnapshot,
  RemoteCalendar,
  RemoteEvent,
} from "../provider.js";

/**
 * Google Calendar API の JSON と、Orbit の予定 (RemoteEvent / EventSnapshot) の変換。
 * https://developers.google.com/workspace/calendar/api/v3/reference/events
 * - 原本 (recurrence を持つ予定) は rrule / rdates / exdates に分ける。
 * - 例外 (recurringEventId と originalStartTime を持つ予定) は、originalStartTime を
 *   recurrenceId (normalizeRecurrenceId の書き方) にし、parentRemoteId に recurringEventId を入れる。
 * - 取り消された回 (status: cancelled の例外) は、cancelled の例外として返す。
 * - raw には Google の JSON をそのまま入れ、parseRaw はそれを同じ変換に通す。
 */

export type GoogleDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type GoogleAttendee = {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: string;
  comment?: string;
  [key: string]: unknown;
};

export type GoogleReminder = { method?: string; minutes?: number };

export type GoogleEvent = {
  id: string;
  etag?: string;
  status?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  transparency?: string;
  sequence?: number;
  updated?: string;
  eventType?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GoogleAttendee[];
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  reminders?: { useDefault?: boolean; overrides?: GoogleReminder[] };
  [key: string]: unknown;
};

export type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  backgroundColor?: string;
  accessRole?: string;
  primary?: boolean;
  deleted?: boolean;
  defaultReminders?: GoogleReminder[];
};

/** 誕生日のカレンダー (Orbit が作る仮のカレンダー) の remoteId。Google のカレンダー ID とは重ならない。 */
export const BIRTHDAYS_REMOTE_ID = "orbit:birthdays";

/** 以前の「誕生日」カレンダー (連絡先から作られていたもの)。今は primary の birthday の予定になっている。 */
const LEGACY_CONTACTS_CALENDAR = /#contacts@group\.v\.calendar\.google\.com$/;

/** 予定を読み書きするときの、Google 側のカレンダー ID と、絞り込む予定の種類。 */
export function googleTarget(calendar: Pick<CalendarRow, "remoteId">): {
  calendarId: string;
  eventTypes: string[] | undefined;
  birthdays: boolean;
} {
  if (calendar.remoteId === BIRTHDAYS_REMOTE_ID) {
    return { calendarId: "primary", eventTypes: ["birthday"], birthdays: true };
  }
  if (!calendar.remoteId) {
    throw new Error("カレンダーの remoteId がありません。");
  }
  return {
    calendarId: calendar.remoteId,
    eventTypes: undefined,
    birthdays: false,
  };
}

function reminderOf(value: GoogleReminder): CalendarReminder | null {
  if (typeof value.minutes !== "number" || !Number.isFinite(value.minutes)) {
    return null;
  }
  return {
    method: value.method === "email" ? "email" : "display",
    minutes: value.minutes,
  };
}

function remindersOf(values: GoogleReminder[] | undefined): CalendarReminder[] {
  return (values ?? [])
    .map(reminderOf)
    .filter((item): item is CalendarReminder => item !== null);
}

function colorOf(value: string | undefined): string | null {
  const match = value && /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1]?.toLowerCase()}` : null;
}

/** カレンダー一覧の 1 件を RemoteCalendar にする。外すもの (削除済み、昔の誕生日) は null。 */
export function calendarFromGoogle(
  entry: GoogleCalendarListEntry,
): RemoteCalendar | null {
  if (entry.deleted) return null;
  if (LEGACY_CONTACTS_CALENDAR.test(entry.id)) return null;
  const role = entry.accessRole ?? "reader";
  return {
    remoteId: entry.id,
    name: entry.summaryOverride || entry.summary || entry.id,
    description: entry.description || null,
    color: colorOf(entry.backgroundColor),
    timeZone: entry.timeZone || null,
    readOnly: role !== "owner" && role !== "writer",
    url: null,
    defaultReminders: remindersOf(entry.defaultReminders),
    kind: "normal",
    providerState: { accessRole: role, primary: entry.primary === true },
  };
}

/** primary のカレンダーの誕生日 (eventType: birthday) をまとめる、読み取り専用のカレンダー。 */
export function birthdaysCalendar(
  primary: GoogleCalendarListEntry,
): RemoteCalendar {
  return {
    remoteId: BIRTHDAYS_REMOTE_ID,
    name: "誕生日",
    description: null,
    color: null,
    timeZone: primary.timeZone || null,
    readOnly: true,
    url: null,
    defaultReminders: null,
    kind: "birthdays",
    providerState: { sourceCalendarId: primary.id },
  };
}

/** "2026-12-08T10:00:00+09:00" を UTC の ISO 8601 (秒まで) にする。 */
function instantOf(value: string): string {
  return instantRecurrenceId(new Date(value).toISOString());
}

/** IANA 名なら返す ("+09:00" などのオフセットは Google のタイムゾーンにならない)。 */
function zoneName(value: string | null | undefined): string | null {
  return value && /^[A-Za-z]/.test(value) ? value : null;
}

/** iCalendar の日付と時刻の値 (YYYYMMDDTHHMMSSZ / YYYYMMDD)。 */
function icsValue(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll("-", "");
  return instantRecurrenceId(value).replaceAll(/[-:]/g, "");
}

/** recurrence の行 (RRULE、RDATE、EXDATE) を rrule / rdates / exdates に分ける。 */
function recurrenceOf(
  lines: string[] | undefined,
  start: GoogleDateTime | undefined,
  defaultTimeZone: string,
): { rrule: string | null; rdates: string[] | null; exdates: string[] | null } {
  if (!lines || lines.length === 0) {
    return { rrule: null, rdates: null, exdates: null };
  }
  // TZID 付きの RDATE / EXDATE をそろえるため、iCalendar の読み取りに通す。
  const dtstart = start?.date
    ? `DTSTART;VALUE=DATE:${icsValue(start.date)}`
    : `DTSTART:${icsValue(start?.dateTime ?? "1970-01-01T00:00:00Z")}`;
  const text = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:orbit-google-recurrence",
    dtstart,
    ...lines.filter((line) => /^(RRULE|RDATE|EXDATE)[;:]/i.test(line)),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  try {
    const [parsed] = parseICalendar(text, { defaultTimeZone }).events;
    return {
      rrule: parsed?.rrule ?? null,
      rdates: parsed?.rdates ?? null,
      exdates: parsed?.exdates ?? null,
    };
  } catch {
    return { rrule: null, rdates: null, exdates: null };
  }
}

function attendeeRole(attendee: GoogleAttendee) {
  if (attendee.organizer) return "chair" as const;
  if (attendee.resource) return "non_participant" as const;
  if (attendee.optional) return "optional" as const;
  return "required" as const;
}

function attendeeStatus(value: string | undefined) {
  switch (value) {
    case "accepted":
      return "accepted" as const;
    case "declined":
      return "declined" as const;
    case "tentative":
      return "tentative" as const;
    default:
      return "needs_action" as const;
  }
}

const GOOGLE_RESPONSE: Record<string, string> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  needs_action: "needsAction",
  delegated: "needsAction",
};

function conferenceUrlOf(item: GoogleEvent): string | null {
  if (typeof item.hangoutLink === "string" && item.hangoutLink) {
    return item.hangoutLink;
  }
  const video = item.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video" && entry.uri,
  );
  return video?.uri ?? null;
}

/** Google の予定 1 件を RemoteEvent にする。 */
export function eventFromGoogle(
  item: GoogleEvent,
  calendar: Pick<CalendarRow, "timeZone">,
): RemoteEvent {
  const defaultTimeZone = calendar.timeZone ?? "UTC";
  const isException = Boolean(item.recurringEventId);
  const original = item.originalStartTime;
  const recurrenceId =
    isException && original
      ? original.date
        ? original.date
        : original.dateTime
          ? normalizeRecurrenceId(instantOf(original.dateTime))
          : null
      : null;
  const status =
    item.status === "cancelled"
      ? "cancelled"
      : item.status === "tentative"
        ? "tentative"
        : "confirmed";
  // 取り消された回は id、recurringEventId、originalStartTime しか無いことがある。
  const start = item.start ?? original;
  const end = item.end ?? item.start ?? original;
  const allDay = Boolean(start?.date);
  const timing = allDay
    ? {
        allDay: true,
        startAt: null,
        endAt: null,
        startDate: start?.date ?? null,
        endDate: end?.date ?? start?.date ?? null,
        startTimeZone: null,
        endTimeZone: null,
      }
    : {
        allDay: false,
        startAt: start?.dateTime ? instantOf(start.dateTime) : null,
        endAt: end?.dateTime
          ? instantOf(end.dateTime)
          : start?.dateTime
            ? instantOf(start.dateTime)
            : null,
        startDate: null,
        endDate: null,
        startTimeZone: zoneName(start?.timeZone) ?? calendar.timeZone ?? null,
        endTimeZone:
          zoneName(end?.timeZone) ??
          zoneName(start?.timeZone) ??
          calendar.timeZone ??
          null,
      };
  const recurrence = isException
    ? { rrule: null, rdates: null, exdates: null }
    : recurrenceOf(
        item.recurrence,
        item.start,
        zoneName(item.start?.timeZone) ?? defaultTimeZone,
      );
  const uid = item.iCalUID ?? (isException ? null : item.id);
  return {
    remoteId: item.id,
    etag: item.etag ?? null,
    parentRemoteId: item.recurringEventId ?? null,
    ...(uid ? { uid } : {}),
    recurrenceId,
    summary: item.summary ?? null,
    location: item.location ?? null,
    description: item.description ?? null,
    status,
    busy: item.transparency !== "transparent",
    ...timing,
    ...recurrence,
    organizer: item.organizer?.email
      ? {
          email: item.organizer.email,
          ...(item.organizer.displayName
            ? { name: item.organizer.displayName }
            : {}),
          // Google は自分が主催者のときだけ self: true を付ける (副カレンダーでは主催者の
          // アドレスがカレンダーの ID になるので、アドレスの比較では決められない)。
          self: item.organizer.self === true,
        }
      : null,
    attendees: (item.attendees ?? [])
      .filter((attendee) => attendee.email)
      .map((attendee) => ({
        email: attendee.email as string,
        name: attendee.displayName ?? null,
        role: attendeeRole(attendee),
        status: attendeeStatus(attendee.responseStatus),
        self: attendee.self === true,
      })),
    sequence:
      typeof item.sequence === "number" && item.sequence >= 0
        ? item.sequence
        : 0,
    conferenceUrl: conferenceUrlOf(item),
    remoteUpdatedAt: item.updated ? new Date(item.updated).toISOString() : null,
    reminders:
      item.reminders === undefined || item.reminders.useDefault !== false
        ? null
        : remindersOf(item.reminders.overrides),
    raw: JSON.stringify(item),
  };
}

/** raw (Google の JSON) を読む。読めなければ null。 */
export function parseGoogleRaw(raw: string | null): GoogleEvent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as GoogleEvent;
    return value && typeof value === "object" && typeof value.id === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

/** 予定の開始と終了を Google の形にする。繰り返しにはタイムゾーンが要る。 */
export function timesToGoogle(
  event: EventSnapshot,
  calendar: Pick<CalendarRow, "timeZone">,
  recurring: boolean,
): {
  start: GoogleDateTime | Record<string, unknown>;
  end: Record<string, unknown>;
} {
  if (event.allDay && event.startDate) {
    return {
      start: { date: event.startDate, dateTime: null, timeZone: null },
      end: {
        date: event.endDate ?? event.startDate,
        dateTime: null,
        timeZone: null,
      },
    };
  }
  const fallback = recurring ? (calendar.timeZone ?? "UTC") : null;
  const startZone = zoneName(event.startTimeZone) ?? fallback;
  const endZone = zoneName(event.endTimeZone) ?? startZone;
  const startAt = event.startAt ?? new Date();
  const endAt = event.endAt ?? startAt;
  return {
    start: {
      date: null,
      dateTime: instantRecurrenceId(startAt.toISOString()),
      timeZone: startZone,
    },
    end: {
      date: null,
      dateTime: instantRecurrenceId(endAt.toISOString()),
      timeZone: endZone,
    },
  };
}

/** rrule / rdates / exdates を Google の recurrence の行にする。 */
export function recurrenceToGoogle(input: {
  rrule: string | null;
  rdates: readonly string[] | null;
  exdates: readonly string[] | null;
}): string[] {
  const lines: string[] = [];
  if (input.rrule) lines.push(`RRULE:${input.rrule.replace(/^RRULE:/i, "")}`);
  const dates = (name: string, values: readonly string[] | null) => {
    for (const value of values ?? []) {
      lines.push(
        /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? `${name};VALUE=DATE:${icsValue(value)}`
          : `${name}:${icsValue(value)}`,
      );
    }
  };
  dates("RDATE", input.rdates);
  dates("EXDATE", input.exdates);
  return lines;
}

/** 参加者を Google の形にする。前回の内容 (base) にある Orbit の知らない項目は残す。 */
export function attendeesToGoogle(
  event: EventSnapshot,
  base: GoogleEvent | null,
): GoogleAttendee[] {
  const previous = new Map(
    (base?.attendees ?? [])
      .filter((attendee) => attendee.email)
      .map((attendee) => [attendee.email?.toLowerCase(), attendee]),
  );
  return event.attendees.map((attendee) => {
    const before = previous.get(attendee.email.toLowerCase()) ?? {};
    const next: GoogleAttendee = {
      ...before,
      email: attendee.email,
      responseStatus: GOOGLE_RESPONSE[attendee.status] ?? "needsAction",
    };
    if (attendee.name) next.displayName = attendee.name;
    if (attendee.role === "optional") next.optional = true;
    else delete next.optional;
    return next;
  });
}

/** リマインダーを Google の形にする。 */
export function remindersToGoogle(event: EventSnapshot) {
  if (event.useDefaultReminders) return { useDefault: true };
  return {
    useDefault: false,
    overrides: event.reminders.slice(0, 5).map((reminder) => ({
      method: reminder.method === "email" ? "email" : "popup",
      minutes: reminder.minutes,
    })),
  };
}

/** 変えた項目だけの PATCH の本文。recurrence は呼び出し側が決める。 */
export function patchToGoogle(
  event: EventSnapshot,
  fields: readonly string[],
  calendar: Pick<CalendarRow, "timeZone">,
  base: GoogleEvent | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const recurring =
    event.recurrenceId === null &&
    Boolean(event.rrule || (event.rdates && event.rdates.length > 0));
  for (const field of new Set(fields)) {
    switch (field) {
      case "summary":
        body.summary = event.summary ?? "";
        break;
      case "location":
        body.location = event.location ?? "";
        break;
      case "description":
        body.description = event.description ?? "";
        break;
      case "status":
        // 予定ごとの取り消し (cancelled) は削除で行う。ここでは確定と仮だけを書く。
        if (event.status !== "cancelled") body.status = event.status;
        break;
      case "busy":
        body.transparency = event.busy ? "opaque" : "transparent";
        break;
      case "time":
        Object.assign(body, timesToGoogle(event, calendar, recurring));
        break;
      case "useDefaultReminders":
      case "reminders":
        body.reminders = remindersToGoogle(event);
        break;
      case "attendees":
        body.attendees = attendeesToGoogle(event, base);
        break;
      // conferenceUrl: Google の会議 (conferenceData) は URL だけでは作れないので書かない。
      // recurrence: 回の取り消しへの変換が要るので、呼び出し側で扱う。
      default:
        break;
    }
  }
  return body;
}

/** 新しく作る予定の本文 (events.insert)。 */
export function createToGoogle(
  id: string,
  event: EventSnapshot,
  calendar: Pick<CalendarRow, "timeZone">,
): Record<string, unknown> {
  const recurrence = recurrenceToGoogle(event);
  const body: Record<string, unknown> = {
    id,
    summary: event.summary ?? "",
    transparency: event.busy ? "opaque" : "transparent",
    reminders: remindersToGoogle(event),
    ...timesToGoogle(event, calendar, recurrence.length > 0),
  };
  if (event.location) body.location = event.location;
  if (event.description) body.description = event.description;
  if (event.status === "tentative") body.status = "tentative";
  if (recurrence.length > 0) body.recurrence = recurrence;
  if (event.attendees.length > 0)
    body.attendees = attendeesToGoogle(event, null);
  // insert では、時刻の null の鍵を送らない。
  for (const key of ["start", "end"] as const) {
    const value = body[key] as Record<string, unknown>;
    body[key] = Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== null),
    );
  }
  return body;
}

/** UUID を Google の予定 ID に使える base32hex (0-9、a-v) にする。同じ UUID は同じ ID になる。 */
export function googleEventIdFor(uuid: string): string {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error("予定の ID が UUID ではありません。");
  }
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = "";
  for (const char of hex)
    bits += Number.parseInt(char, 16).toString(2).padStart(4, "0");
  while (bits.length % 5 !== 0) bits += "0";
  let id = "";
  for (let index = 0; index < bits.length; index += 5) {
    id += alphabet[Number.parseInt(bits.slice(index, index + 5), 2)];
  }
  return id;
}
