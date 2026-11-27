import type { CalendarScheduling, InviteRole } from "@orbit/core/event-invite";
import { Temporal } from "temporal-polyfill";
import type { Address } from "@/lib/api";
import type {
  Attendee,
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
import { mergeAddresses, parseAddressList } from "@/lib/compose";

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
  /** 予定あり (true) / 空き (false)。 */
  busy: boolean;
  /** 参加者 (自分を除く)。メールの宛先の欄 (RecipientInput) と同じ形。 */
  attendees: { list: Address[]; text: string };
  /**
   * 開いたときの参加者 (自分を含む。画面では変えない)。送るときに自分の行と
   * 役割 (任意の参加者など) を引き継ぐのに使う。
   */
  attendeeBase: Pick<Attendee, "email" | "name" | "role" | "self">[];
};

/** 画面で足せる参加者の上限 (API は 500 人まで)。 */
export const MAX_FORM_ATTENDEES = 100;

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
    busy: true,
    attendees: { list: [], text: "" },
    attendeeBase: [],
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
    busy: event.busy,
    attendees: {
      list: event.attendees
        .filter((attendee) => !attendee.self)
        .map((attendee) => ({
          ...(attendee.name ? { name: attendee.name } : {}),
          address: attendee.email,
        })),
      text: "",
    },
    attendeeBase: event.attendees.map(({ email, name, role, self }) => ({
      email,
      name,
      role,
      self,
    })),
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
  if (before === null ? !form.busy : changed("busy")) fields.busy = form.busy;
  if (
    before === null
      ? formAttendees(form).length > 0
      : attendeesChanged(form, before)
  ) {
    fields.attendees = attendeesPayload(form);
  }
  return fields;
}

/** 入力の参加者 (確定した札と、欄に打ちかけのアドレス)。自分は含まない。 */
export function formAttendees(form: EventForm): Address[] {
  const typed = parseAddressList(form.attendees.text).addresses;
  return mergeAddresses(form.attendees.list, typed);
}

const addressKeys = (list: readonly Address[]) =>
  list
    .map((entry) => entry.address.trim().toLowerCase())
    .sort()
    .join("\n");

/** 参加者を足したか外したか (名前だけの違いは見ない)。 */
export function attendeesChanged(form: EventForm, before: EventForm): boolean {
  return (
    addressKeys(formAttendees(form)) !== addressKeys(formAttendees(before))
  );
}

/**
 * 送る参加者の一覧。自分の行は開いたときのまま先頭に残し、既にいた人は役割を引き継ぐ。
 * 新しい人は必須の参加者 (required)。出欠と self は送らない (サーバーが決める)。
 */
export function attendeesPayload(
  form: EventForm,
): NonNullable<EventFields["attendees"]> {
  const base = new Map(
    form.attendeeBase.map((entry) => [entry.email.toLowerCase(), entry]),
  );
  const result: NonNullable<EventFields["attendees"]> = form.attendeeBase
    .filter((entry) => entry.self)
    .map((entry) => ({
      email: entry.email,
      name: entry.name,
      role: entry.role,
    }));
  const seen = new Set(result.map((entry) => entry.email.toLowerCase()));
  for (const entry of formAttendees(form)) {
    const key = entry.address.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const known = base.get(key);
    result.push({
      email: entry.address.trim(),
      name: entry.name?.trim() || known?.name || null,
      role: known?.role ?? "required",
    });
  }
  return result;
}

/** 招待された予定 (主催者でない) で送ってよい項目だけを残す (10 章の 2: 推奨 A)。 */
export function attendeeEditableChanges(changes: EventFields): EventFields {
  const result: EventFields = {};
  if (changes.reminders !== undefined) result.reminders = changes.reminders;
  if (changes.useDefaultReminders !== undefined)
    result.useDefaultReminders = changes.useDefaultReminders;
  if (changes.busy !== undefined) result.busy = changes.busy;
  return result;
}

/** 編集画面の参加者の欄と保存ボタンの出し方 (7.2)。 */
export type InviteFormView = {
  /** 招待された予定: 通知と予定あり / 空き以外の欄を無効にする。 */
  locked: boolean;
  /** edit: 足せる・外せる。remove_only: 外すだけ。disabled: どちらもできない。 */
  attendees: "edit" | "remove_only" | "disabled";
  /** 欄の下の注記。 */
  note: string | null;
  /** 注記を警告の色で出すか (保存できない理由など)。 */
  warning: boolean;
  saveLabel: string;
  /** 保存できない理由 (無ければ null)。 */
  blocked: string | null;
};

export function inviteFormView(options: {
  form: EventForm;
  /** 開いたときの入力。新しい予定なら null。 */
  before: EventForm | null;
  /** 予定に対する自分の役割 (新しい予定は organizer)。 */
  role: InviteRole;
  /** 選んでいるカレンダーが招待を送れるか。 */
  scheduling: CalendarScheduling;
  timeZone: string;
  online: boolean;
}): InviteFormView {
  const { form, before, role, scheduling, online } = options;
  const view: InviteFormView = {
    locked: false,
    attendees: "edit",
    note: null,
    warning: false,
    saveLabel: "保存",
    blocked: null,
  };
  const list = formAttendees(form);
  if (role === "attendee") {
    return {
      ...view,
      locked: true,
      attendees: "disabled",
      note: "主催者の予定です。通知と「予定あり / 空き」だけ変えられます。",
    };
  }
  if (role === "none") {
    return {
      ...view,
      attendees: "disabled",
      note: "自分が主催する予定ではないので、参加者は変えられません",
    };
  }
  const changedList =
    before === null ? list.length > 0 : attendeesChanged(form, before);
  if (scheduling === "none") {
    const noneView: InviteFormView = {
      ...view,
      attendees: form.attendees.list.length > 0 ? "remove_only" : "disabled",
      note: "このカレンダーからは招待を送れません",
    };
    // 参加者を外すのは通す。足した (新しい予定でカレンダーを切り替えた) ときは止める。
    const added = before
      ? list.some(
          (entry) =>
            !formAttendees(before).some(
              (old) =>
                old.address.toLowerCase() === entry.address.toLowerCase(),
            ),
        )
      : list.length > 0;
    if (added) {
      noneView.blocked =
        "このカレンダーからは招待を送れません。参加者を外すか、招待を送れるカレンダーを選んでください。";
      noneView.note = noneView.blocked;
      noneView.warning = true;
    }
    return noneView;
  }
  if (list.length > MAX_FORM_ATTENDEES) {
    const reason = `参加者は ${MAX_FORM_ATTENDEES} 人までです。`;
    return { ...view, note: reason, warning: true, blocked: reason };
  }
  if (changedList) {
    return {
      ...view,
      note: online
        ? "保存すると参加者に招待が届きます"
        : "接続したときに参加者に招待が届きます",
      saveLabel: "保存して招待を送る",
    };
  }
  if (before && list.length > 0) {
    const changes = formChanges(form, options.timeZone, before);
    const others = Object.keys(changes ?? {}).filter(
      (key) =>
        key !== "attendees" &&
        key !== "reminders" &&
        key !== "useDefaultReminders" &&
        key !== "busy",
    );
    if (others.length > 0) {
      return {
        ...view,
        note: online
          ? "保存すると参加者に変更の連絡が届きます"
          : "接続したときに参加者に変更の連絡が届きます",
        saveLabel: "保存して連絡を送る",
      };
    }
  }
  return view;
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
