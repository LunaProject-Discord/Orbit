import { Temporal } from "temporal-polyfill";
import type {
  CalendarEvent,
  EventFields,
  EventTimeInput,
  Reminder,
} from "@/lib/calendar/api";
import type { LocalOccurrence } from "@/lib/calendar/dates";
import {
  buildRule,
  presetOf,
  type RepeatPreset,
} from "@/lib/calendar/recurrence-label";

/** 作成・編集の画面の入力。日付は YYYY-MM-DD、時刻は HH:MM (表示するタイムゾーン)。 */
export type EventForm = {
  summary: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** 終わりの日 (終日でもその日を含む)。 */
  endDate: string;
  endTime: string;
  preset: RepeatPreset | "custom";
  /** カスタムの規則 (プロバイダで作ったもの)。そのまま残す。 */
  customRule: string | null;
  /** 繰り返しの最後の日 (含む)。無ければ "" 。 */
  until: string;
  location: string;
  description: string;
  calendarId: string;
  useDefaultReminders: boolean;
  reminders: Reminder[];
};

const pad = (value: number) => String(value).padStart(2, "0");
const timeOf = (value: Temporal.ZonedDateTime) =>
  `${pad(value.hour)}:${pad(value.minute)}`;

/** 新しい予定の入力 (開始の日時と長さ)。 */
export function newEventForm(options: {
  calendarId: string;
  date: Temporal.PlainDate;
  /** 開始 (0 時からの分)。null なら終日。 */
  minutes: number | null;
  timeZone: string;
}): EventForm {
  const { date, minutes } = options;
  const allDay = minutes === null;
  const start = date
    .toPlainDateTime({ hour: 0 })
    .add({ minutes: minutes ?? 9 * 60 })
    .toZonedDateTime(options.timeZone);
  const end = start.add({ hours: 1 });
  return {
    summary: "",
    allDay,
    startDate: start.toPlainDate().toString(),
    startTime: timeOf(start),
    endDate: allDay ? date.toString() : end.toPlainDate().toString(),
    endTime: timeOf(end),
    preset: "none",
    customRule: null,
    until: "",
    location: "",
    description: "",
    calendarId: options.calendarId,
    useDefaultReminders: true,
    reminders: [],
  };
}

/** 既存の予定 (表示している回) の入力。 */
export function eventFormOf(
  event: CalendarEvent,
  local: LocalOccurrence,
): EventForm {
  const rule = event.parentId ? null : event.rrule;
  const preset = presetOf(rule);
  return {
    summary: event.summary ?? "",
    allDay: local.allDay,
    startDate: local.firstDay.toString(),
    startTime: local.allDay ? "09:00" : timeOf(local.start),
    endDate: local.allDay
      ? local.lastDay.toString()
      : local.end.toPlainDate().toString(),
    endTime: local.allDay ? "10:00" : timeOf(local.end),
    preset: preset ? preset.preset : "custom",
    customRule: preset ? null : rule,
    until: preset?.until ?? "",
    location: event.location ?? "",
    description: event.description ?? "",
    calendarId: event.calendarId,
    useDefaultReminders: event.useDefaultReminders,
    reminders: event.reminders,
  };
}

/** 入力の時刻を送る形にする。終わりが始まりより前なら null。 */
export function formTime(
  form: EventForm,
  timeZone: string,
): EventTimeInput | null {
  try {
    if (form.allDay) {
      const start = Temporal.PlainDate.from(form.startDate);
      const last = Temporal.PlainDate.from(form.endDate);
      if (Temporal.PlainDate.compare(last, start) < 0) return null;
      return {
        allDay: true,
        startDate: start.toString(),
        endDate: last.add({ days: 1 }).toString(),
      };
    }
    const start = Temporal.PlainDateTime.from(
      `${form.startDate}T${form.startTime}`,
    ).toZonedDateTime(timeZone);
    const end = Temporal.PlainDateTime.from(
      `${form.endDate}T${form.endTime}`,
    ).toZonedDateTime(timeZone);
    if (Temporal.ZonedDateTime.compare(end, start) < 0) return null;
    return {
      allDay: false,
      startAt: start.toInstant().toString(),
      endAt: end.toInstant().toString(),
      startTimeZone: timeZone,
      endTimeZone: timeZone,
    };
  } catch {
    return null;
  }
}

/** 入力の繰り返しを規則にする。カスタムはそのまま。 */
export function formRule(form: EventForm, timeZone: string): string | null {
  if (form.preset === "custom") return form.customRule;
  if (form.preset === "none") return null;
  let until: { date: string; untilEnd: string | null } | null = null;
  if (form.until) {
    try {
      const date = Temporal.PlainDate.from(form.until);
      until = {
        date: date.toString(),
        untilEnd: form.allDay
          ? null
          : date
              .add({ days: 1 })
              .toZonedDateTime(timeZone)
              .toInstant()
              .subtract({ seconds: 1 })
              .toString(),
      };
    } catch {
      until = null;
    }
  }
  return buildRule(form.preset, until);
}

/** 入力のうち、送る項目 (新しい予定ならすべて、既存なら変わった項目だけ)。 */
export function formChanges(
  form: EventForm,
  timeZone: string,
  before: EventForm | null,
): EventFields | null {
  const time = formTime(form, timeZone);
  if (!time) return null;
  const fields: EventFields = {};
  const changed = (key: keyof EventForm) =>
    before === null ||
    JSON.stringify(before[key]) !== JSON.stringify(form[key]);
  if (changed("summary")) fields.summary = form.summary.trim() || null;
  if (changed("location")) fields.location = form.location.trim() || null;
  if (changed("description"))
    fields.description = form.description.trim() || null;
  if (
    ["allDay", "startDate", "startTime", "endDate", "endTime"].some((key) =>
      changed(key as keyof EventForm),
    )
  ) {
    fields.time = time;
  }
  if (changed("preset") || changed("until") || changed("customRule")) {
    fields.recurrence = { rrule: formRule(form, timeZone) };
  }
  if (changed("useDefaultReminders"))
    fields.useDefaultReminders = form.useDefaultReminders;
  if (changed("reminders")) fields.reminders = form.reminders;
  return fields;
}

/**
 * 繰り返しの「すべての予定」を変えるとき、表示していた回で動かした分だけ原本の時刻を動かす。
 * 長さは入力のとおりにする。
 */
export function shiftMasterTime(
  master: CalendarEvent,
  occurrence: LocalOccurrence,
  next: EventTimeInput,
): EventTimeInput {
  if (next.allDay) {
    const days = Temporal.PlainDate.from(next.startDate).until(
      Temporal.PlainDate.from(next.endDate),
    ).days;
    const shift = occurrence.firstDay.until(
      Temporal.PlainDate.from(next.startDate),
    ).days;
    const masterStart =
      master.allDay && master.startDate
        ? Temporal.PlainDate.from(master.startDate)
        : occurrence.firstDay;
    const start = masterStart.add({ days: shift });
    return {
      allDay: true,
      startDate: start.toString(),
      endDate: start.add({ days }).toString(),
    };
  }
  const nextStart = Temporal.Instant.from(next.startAt);
  const nextEnd = Temporal.Instant.from(next.endAt);
  const masterStart =
    !master.allDay && master.startAt
      ? Temporal.Instant.from(master.startAt)
      : occurrence.start.toInstant();
  // 壁時計の時刻のずれ (夏時間をまたいでも、時刻を同じだけ動かす)。
  const zone = next.startTimeZone ?? occurrence.start.timeZoneId;
  const before = occurrence.start.withTimeZone(zone);
  const after = nextStart.toZonedDateTimeISO(zone);
  const shift = before.toPlainDateTime().until(after.toPlainDateTime());
  const start = masterStart.toZonedDateTimeISO(zone).add(shift);
  return {
    ...next,
    startAt: start.toInstant().toString(),
    endAt: start.toInstant().add(nextStart.until(nextEnd)).toString(),
  };
}
