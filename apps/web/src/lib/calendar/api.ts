import { apiFetch } from "@/lib/api";

/**
 * 予定の API (/v1/calendars) の型と呼び出し。
 * 時刻付きの予定は UTC の ISO 8601、終日の予定は YYYY-MM-DD (終わりの日は含まない)。
 */

export type CalendarSource =
  | "google"
  | "microsoft"
  | "caldav"
  | "ics"
  | "local"
  | "holidays"
  | "birthdays";

export type ReminderMethod = "display" | "email";
export type Reminder = { method: ReminderMethod; minutes: number };

export type Calendar = {
  id: string;
  accountId: string | null;
  source: CalendarSource;
  name: string;
  description: string | null;
  color: string | null;
  timeZone: string | null;
  readOnly: boolean;
  visible: boolean;
  sortOrder: number | null;
  url: string | null;
  pollIntervalSeconds: number | null;
  defaultReminders: Reminder[];
  lastSyncedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type AttendeeStatus =
  | "needs_action"
  | "accepted"
  | "declined"
  | "tentative"
  | "delegated";

export type Attendee = {
  email: string;
  name: string | null;
  role: "chair" | "required" | "optional" | "non_participant";
  status: AttendeeStatus;
  self: boolean;
};

export type CalendarEvent = {
  id: string;
  calendarId: string;
  uid: string;
  recurrenceId: string | null;
  parentId: string | null;
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
  rdates: string[];
  exdates: string[];
  organizer: { email: string; name?: string } | null;
  sequence: number;
  conferenceUrl: string | null;
  useDefaultReminders: boolean;
  reminders: Reminder[];
  attendees: Attendee[];
  fieldUpdatedAt: Record<string, string>;
  updatedAt: string;
};

/** 期間内の 1 回。eventId で予定 (原本か例外) を引く。 */
export type Occurrence = {
  eventId: string;
  masterId: string;
  recurrenceId: string | null;
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type EventTimeInput =
  | { allDay: true; startDate: string; endDate: string }
  | {
      allDay: false;
      startAt: string;
      endAt: string;
      startTimeZone: string | null;
      endTimeZone?: string | null;
    };

/** 項目ごとに変えられる内容。 */
export type EventFields = {
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  status?: CalendarEvent["status"];
  busy?: boolean;
  time?: EventTimeInput;
  recurrence?: {
    rrule: string | null;
    rdates?: string[] | null;
    exdates?: string[] | null;
  };
  conferenceUrl?: string | null;
  useDefaultReminders?: boolean;
  reminders?: Reminder[];
  attendees?: {
    email: string;
    name?: string | null;
    role?: Attendee["role"];
  }[];
};

export async function listCalendars(signal?: AbortSignal): Promise<Calendar[]> {
  const response = await apiFetch("/v1/calendars", { signal });
  return ((await response.json()) as { calendars: Calendar[] }).calendars;
}

export async function createCalendar(input: {
  name: string;
  color?: string | null;
  timeZone?: string | null;
}): Promise<Calendar> {
  const response = await apiFetch("/v1/calendars", {
    method: "POST",
    body: input,
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

export async function updateCalendar(
  id: string,
  input: Partial<
    Pick<
      Calendar,
      | "name"
      | "description"
      | "color"
      | "timeZone"
      | "visible"
      | "sortOrder"
      | "pollIntervalSeconds"
    >
  >,
): Promise<Calendar> {
  const response = await apiFetch(`/v1/calendars/${id}`, {
    method: "PATCH",
    body: input,
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

/** ICS の URL を購読する。取得できなければ ApiError (body.message に理由)。 */
export async function subscribeCalendar(input: {
  url: string;
  name?: string;
  color?: string | null;
  timeZone: string;
}): Promise<Calendar> {
  const response = await apiFetch("/v1/calendars/subscriptions", {
    method: "POST",
    body: input,
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

/** 購読を今すぐ取得し直す。 */
export async function refreshCalendar(id: string): Promise<Calendar> {
  const response = await apiFetch(`/v1/calendars/${id}/refresh`, {
    method: "POST",
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

export async function deleteCalendar(id: string): Promise<void> {
  await apiFetch(`/v1/calendars/${id}`, { method: "DELETE" });
}

export type EventRange = { events: CalendarEvent[]; occurrences: Occurrence[] };

/** from の日から to の日の前日まで (timeZone での日付) の回。 */
export async function listEvents(
  range: { from: string; to: string; timeZone: string },
  signal?: AbortSignal,
): Promise<EventRange> {
  const query = new URLSearchParams(range).toString();
  const response = await apiFetch(`/v1/calendars/events?${query}`, { signal });
  return (await response.json()) as EventRange;
}

export async function searchEvents(
  q: string,
  signal?: AbortSignal,
): Promise<CalendarEvent[]> {
  const response = await apiFetch(
    `/v1/calendars/events/search?q=${encodeURIComponent(q)}`,
    { signal },
  );
  return ((await response.json()) as { events: CalendarEvent[] }).events;
}

export async function createEvent(
  input: EventFields & {
    id?: string;
    calendarId: string;
    time: EventTimeInput;
  },
): Promise<CalendarEvent> {
  const response = await apiFetch("/v1/calendars/events", {
    method: "POST",
    body: input,
  });
  return ((await response.json()) as { event: CalendarEvent }).event;
}

export type EventUpdateResult = {
  event: CalendarEvent;
  /** ほかの端末が後から変えていたので、変えなかった項目。 */
  rejected: (keyof EventFields)[];
};

function changedAtFor(changes: EventFields, at: Date) {
  const iso = at.toISOString();
  return Object.fromEntries(Object.keys(changes).map((key) => [key, iso]));
}

/** 予定を変える。changedAt は端末で変えた時刻 (既定は今)。 */
export async function updateEvent(
  id: string,
  changes: EventFields,
  changedAt: Date = new Date(),
): Promise<EventUpdateResult> {
  const response = await apiFetch(`/v1/calendars/events/${id}`, {
    method: "PATCH",
    body: { changes, changedAt: changedAtFor(changes, changedAt) },
  });
  return (await response.json()) as EventUpdateResult;
}

/** 繰り返しのうち 1 回だけを変える。 */
export async function updateOccurrence(
  masterId: string,
  recurrenceId: string,
  changes: EventFields,
  changedAt: Date = new Date(),
): Promise<EventUpdateResult> {
  const response = await apiFetch(
    `/v1/calendars/events/${masterId}/occurrences/${encodeURIComponent(recurrenceId)}`,
    {
      method: "PATCH",
      body: { changes, changedAt: changedAtFor(changes, changedAt) },
    },
  );
  return (await response.json()) as EventUpdateResult;
}

export async function deleteEvent(id: string): Promise<void> {
  await apiFetch(`/v1/calendars/events/${id}`, { method: "DELETE" });
}

export async function deleteOccurrence(
  masterId: string,
  recurrenceId: string,
): Promise<void> {
  await apiFetch(
    `/v1/calendars/events/${masterId}/occurrences/${encodeURIComponent(recurrenceId)}`,
    { method: "DELETE" },
  );
}
