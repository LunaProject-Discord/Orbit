import { Temporal } from "temporal-polyfill";
import type { EventFieldName } from "./event-merge.js";
import { parseICalendar, triggerReminderMinutes } from "./icalendar.js";
import {
  basicDate,
  type Component,
  escapeICalText,
  ICAL_PRODID,
  type Line,
  line,
  PARTSTAT_VALUES,
  parseComponents,
  ROLE_VALUES,
  recurrenceValue,
  serialize,
  type TimeForm,
  timeFormOf,
  timeLine,
  toInstant,
  utcStamp,
  vtimezoneComponent,
} from "./icalendar-lines.js";
import { normalizeRecurrenceId } from "./recurrence.js";
import { clampReminderMinutes } from "./reminders.js";

/**
 * iCalendar (RFC 5545) の書き出し。CalDAV への書き戻しで使う。
 * 既存のリソース (前回同期した相手側の内容) を基にして、Orbit が扱う項目のプロパティだけを差し替え、
 * Orbit が知らないプロパティ (X-APPLE-*、ATTACH、CATEGORIES など) とコンポーネントは残す。
 * 読み取りは icalendar.ts の parseICalendar。
 */

/** 書き出す予定 1 つ分。DB の行 (EventWithExtras) と、parseICalendar の結果のどちらも渡せる。 */
export type ICalEventData = {
  uid: string;
  /** 例外のとき元の回 (normalizeRecurrenceId の書き方)。 */
  recurrenceId: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  busy: boolean;
  allDay: boolean;
  startAt: Date | string | null;
  endAt: Date | string | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  endTimeZone: string | null;
  rrule: string | null;
  rdates: readonly string[] | null;
  exdates: readonly string[] | null;
  /** self: false は他人が主催する予定 (メールの招待から取り込んだものなど)。 */
  organizer: { email: string; name?: string; self?: boolean } | null;
  attendees: readonly {
    email: string;
    name?: string | null;
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
  /** 省けば reminders が null かどうかで決める。true なら VALARM を書かない (カレンダーの既定)。 */
  useDefaultReminders?: boolean;
  reminders: readonly { method: "display" | "email"; minutes: number }[] | null;
};

export type ICalWriteEntry = {
  event: ICalEventData;
  /**
   * 差し替える項目。"all" ならすべて。基にする VEVENT が無い (新しく足す) ときは、
   * 指定によらずすべてを書く。
   */
  fields: readonly EventFieldName[] | "all";
};

export type ICalWriteOptions = {
  /** 基にするリソース (VCALENDAR の文字列)。null なら新しく作る。 */
  base: string | null;
  /** 書き換える、または足す VEVENT。UID と回 (recurrenceId) で、基の VEVENT と突き合わせる。 */
  entries: readonly ICalWriteEntry[];
  /** 基から取り除く回 (null は原本)。EXDATE に入った回の例外を消すときなどに使う。 */
  remove?: readonly (string | null)[];
  /** 浮動時刻を読むときのタイムゾーン (基の VEVENT の回を求めるのに使う)。 */
  defaultTimeZone: string;
  /** メールのリマインダー (ACTION:EMAIL) の宛先。無ければ表示のリマインダーとして書く。 */
  alarmEmail?: string | null;
  /** DTSTAMP と LAST-MODIFIED に使う時刻。 */
  now?: Date;
  /**
   * 参加者のいる予定に ORGANIZER が無いときに書く主催者 (アカウントのアドレス)。
   * 省けば event.organizer を使う。新しい例外は原本の ORGANIZER を写す。
   */
  organizer?: { email: string; name?: string | null } | null;
};

export { escapeICalText, ICAL_PRODID } from "./icalendar-lines.js";

/**
 * IANA のタイムゾーンの VTIMEZONE を作る。around の年の切り替わりから、毎年の規則 (第 n 何曜日) を求める。
 * 規則が曜日で表せない地域 (イランなど) では、その年の切り替わりだけを書く (近似)。
 */
export function buildVTimezone(
  zone: string,
  around: Date = new Date(),
): string {
  const component = vtimezoneComponent(zone, around);
  const out: string[] = [];
  serialize(component, out);
  return out.join("\r\n");
}

// ---------------------------------------------------------------------------
// VEVENT の項目

/** 項目ごとに、Orbit が書くプロパティの名前。 */
const FIELD_PROPERTIES: Record<EventFieldName, readonly string[]> = {
  summary: ["SUMMARY"],
  location: ["LOCATION"],
  description: ["DESCRIPTION"],
  status: ["STATUS"],
  busy: ["TRANSP"],
  time: ["DTSTART", "DTEND", "DURATION"],
  recurrence: ["RRULE", "RDATE", "EXDATE", "EXRULE"],
  conferenceUrl: [
    "X-GOOGLE-CONFERENCE",
    "X-MICROSOFT-SKYPETEAMSMEETINGURL",
    "X-MICROSOFT-ONLINEMEETINGCONFLINK",
  ],
  useDefaultReminders: [],
  reminders: [],
  attendees: ["ATTENDEE"],
};

const ALL_FIELDS = Object.keys(FIELD_PROPERTIES) as EventFieldName[];

type FieldContext = {
  zones: Set<string>;
  /** この VEVENT の (書いたあとの) DTSTART の形。 */
  form: TimeForm;
  defaultTimeZone: string;
  /** 既存の EXDATE の 1 つの値を回 (normalizeRecurrenceId の書き方) にする。読めなければ null。 */
  recurrenceIdOfValue: (prop: Line, value: string) => string | null;
  /** 主催者のアドレス (小文字)。新しい参加者に RSVP を付けるかの判断に使う。 */
  organizerEmail: string | null;
};

function fieldLines(
  field: EventFieldName,
  event: ICalEventData,
  existing: readonly Line[],
  context: FieldContext,
): Line[] {
  const { zones } = context;
  const optionalText = (name: string, value: string | null) =>
    value && value.length > 0 ? [line(name, escapeICalText(value))] : [];
  switch (field) {
    case "summary":
      return optionalText("SUMMARY", event.summary);
    case "location":
      return optionalText("LOCATION", event.location);
    case "description":
      return optionalText("DESCRIPTION", event.description);
    case "status":
      return [line("STATUS", event.status.toUpperCase())];
    case "busy":
      return [line("TRANSP", event.busy ? "OPAQUE" : "TRANSPARENT")];
    case "time": {
      if (event.allDay) {
        if (!event.startDate) return [];
        const end =
          event.endDate && event.endDate > event.startDate
            ? event.endDate
            : Temporal.PlainDate.from(event.startDate)
                .add({ days: 1 })
                .toString();
        return [
          line("DTSTART", basicDate(event.startDate), [["VALUE", "DATE"]]),
          line("DTEND", basicDate(end), [["VALUE", "DATE"]]),
        ];
      }
      if (event.startAt === null) return [];
      const start = toInstant(event.startAt);
      let end = event.endAt === null ? start : toInstant(event.endAt);
      if (Temporal.Instant.compare(end, start) < 0) end = start;
      return [
        timeLine("DTSTART", start, event.startTimeZone, zones),
        timeLine("DTEND", end, event.endTimeZone ?? event.startTimeZone, zones),
      ];
    }
    case "recurrence": {
      // 例外は繰り返しの規則を持たない。
      if (event.recurrenceId !== null) return [];
      const lines: Line[] = [];
      const rule = event.rrule?.trim().replace(/^RRULE:/i, "");
      if (rule) lines.push(line("RRULE", rule));
      const write = (name: string, value: string) => {
        const written = recurrenceValue(
          value,
          context.form,
          context.defaultTimeZone,
          zones,
        );
        lines.push(line(name, written.value, written.params));
      };
      for (const value of new Set(
        (event.rdates ?? []).map(normalizeRecurrenceId),
      )) {
        write("RDATE", value);
      }
      // 既存の EXDATE は、残る回の値を元の形 (TZID、VALUE=DATE など) のまま残す。
      const remaining = new Set(
        (event.exdates ?? []).map(normalizeRecurrenceId),
      );
      for (const prop of existing) {
        if (prop.name !== "EXDATE") continue;
        const keptValues = prop.value.split(",").filter((value) => {
          const id = context.recurrenceIdOfValue(prop, value);
          if (id === null || !remaining.has(id)) return false;
          remaining.delete(id);
          return true;
        });
        if (keptValues.length > 0) {
          lines.push(line("EXDATE", keptValues.join(","), [...prop.params]));
        }
      }
      for (const value of remaining) write("EXDATE", value);
      return lines;
    }
    case "conferenceUrl": {
      if (!event.conferenceUrl) return [];
      // いまの書き方 (Google か Microsoft の名前) があればそれに合わせる。
      const name =
        existing.find((entry) =>
          FIELD_PROPERTIES.conferenceUrl.includes(entry.name),
        )?.name ?? "X-GOOGLE-CONFERENCE";
      return [line(name, event.conferenceUrl)];
    }
    case "attendees": {
      const previous = new Map<string, Line>();
      for (const entry of existing) {
        if (entry.name !== "ATTENDEE") continue;
        const email = entry.value
          .trim()
          .replace(/^mailto:/i, "")
          .toLowerCase();
        previous.set(email, entry);
      }
      return event.attendees.map((attendee) => {
        const old = previous.get(attendee.email.toLowerCase());
        // 知らないパラメータ (RSVP、SCHEDULE-STATUS、CUTYPE など) は残す。
        const params: [string, string][] = [];
        for (const [key, value] of old?.params ?? []) {
          if (!["CN", "ROLE", "PARTSTAT"].includes(key))
            params.push([key, value]);
        }
        if (attendee.name) params.unshift(["CN", attendee.name]);
        params.push(["ROLE", ROLE_VALUES[attendee.role]]);
        params.push(["PARTSTAT", PARTSTAT_VALUES[attendee.status]]);
        // 新しく足した参加者には返事を求める (主催者自身を除く)。
        if (
          !old &&
          attendee.email.toLowerCase() !== context.organizerEmail &&
          !params.some(([key]) => key === "RSVP")
        ) {
          params.push(["RSVP", "TRUE"]);
        }
        return line(
          "ATTENDEE",
          old?.value ?? `mailto:${attendee.email}`,
          params,
        );
      });
    }
    default:
      return [];
  }
}

/**
 * parseICalendar がリマインダーとして読む VALARM か (triggerReminderMinutes が値を返すもの)。
 * allDay は基にした VEVENT が終日か。読まない VALARM (RELATED=END、絶対時刻、開始より後の
 * 時刻など) は、書き戻しでもそのまま残す。
 */
function isManagedAlarm(alarm: Component, allDay: boolean): boolean {
  const trigger = alarm.props.find((entry) => entry.name === "TRIGGER");
  return triggerReminderMinutes(trigger, allDay) !== null;
}

/** VEVENT の DTSTART が日付 (終日) か。 */
function isAllDayComponent(component: Component): boolean {
  const dtstart = component.props.find((entry) => entry.name === "DTSTART");
  if (!dtstart) return false;
  return (
    dtstart.params.get("VALUE")?.toUpperCase() === "DATE" ||
    /^\d{8}$/.test(dtstart.value.trim())
  );
}

/**
 * リマインダーの分を TRIGGER の値にする。開始より前は -PT15M の形 (今までと同じ)。
 * 終日の予定の負の分 (当日 0:00 より後) は、開始からの正の相対時刻 (-540 → PT9H) にする。
 */
function triggerValue(minutes: number): string {
  if (minutes >= 0) return `-PT${minutes}M`;
  const after = -minutes;
  const hours = Math.floor(after / 60);
  const rest = after % 60;
  return `PT${hours > 0 ? `${hours}H` : ""}${rest > 0 || hours === 0 ? `${rest}M` : ""}`;
}

function alarmComponents(
  event: ICalEventData,
  alarmEmail: string | null,
): Component[] {
  const useDefault = event.useDefaultReminders ?? event.reminders === null;
  if (useDefault || !event.reminders) return [];
  const seen = new Set<string>();
  const alarms: Component[] = [];
  for (const reminder of event.reminders) {
    // 終日は -1439 まで (当日 23:59)、時刻のある予定は 0 (開始) まで。
    const minutes = clampReminderMinutes(reminder.minutes, event.allDay);
    if (minutes === null) continue;
    const email = reminder.method === "email" && alarmEmail;
    const key = `${email ? "email" : "display"}:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const description = escapeICalText(event.summary ?? "リマインダー");
    const trigger = line("TRIGGER", triggerValue(minutes));
    alarms.push({
      name: "VALARM",
      props: email
        ? [
            line("ACTION", "EMAIL"),
            trigger,
            line("SUMMARY", description),
            line("DESCRIPTION", description),
            line("ATTENDEE", `mailto:${alarmEmail}`),
          ]
        : [
            line("ACTION", "DISPLAY"),
            trigger,
            line("DESCRIPTION", description),
          ],
      children: [],
    });
  }
  return alarms;
}

type VEventOptions = {
  zones: Set<string>;
  alarmEmail: string | null;
  now: Date;
  defaultTimeZone: string;
  timezones: readonly Component[];
  /** 新しい VEVENT の RECURRENCE-ID の形 (原本の DTSTART の形)。 */
  recurrenceForm: TimeForm;
  /** 参加者がいて ORGANIZER が無いときに書く ORGANIZER の行。 */
  organizer: Line | null;
};

function unescapeICalText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

function mailtoAddress(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
}

/** VEVENT を書き換える (base が null なら新しく作る)。 */
function writeVEvent(
  base: Component | null,
  entry: ICalWriteEntry,
  options: VEventOptions,
): Component {
  const { event } = entry;
  const fields =
    base === null || entry.fields === "all" ? ALL_FIELDS : entry.fields;
  const existing = base?.props ?? [];
  const removeNames = new Set<string>(["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"]);
  for (const field of fields) {
    for (const name of FIELD_PROPERTIES[field]) removeNames.add(name);
  }
  // 説明を変えたら、HTML の説明 (X-ALT-DESC) は古い内容のままになるので消す。
  if (base !== null && fields.includes("description")) {
    const previous = existing.find((prop) => prop.name === "DESCRIPTION");
    const before = previous ? unescapeICalText(previous.value) : "";
    if (before !== (event.description ?? "")) removeNames.add("X-ALT-DESC");
  }
  const head: Line[] = [];
  if (!base) {
    head.push(line("UID", event.uid));
    if (event.recurrenceId !== null) {
      const written = recurrenceValue(
        event.recurrenceId,
        options.recurrenceForm,
        options.defaultTimeZone,
        options.zones,
      );
      head.push(line("RECURRENCE-ID", written.value, written.params));
    }
    head.push(line("CREATED", utcStamp(toInstant(options.now))));
  }
  const kept = existing.filter((prop) => !removeNames.has(prop.name));
  const existingOrganizer = kept.find((prop) => prop.name === "ORGANIZER");
  const organizerEmail = existingOrganizer
    ? mailtoAddress(existingOrganizer.value)
    : options.organizer
      ? mailtoAddress(options.organizer.value)
      : null;
  const context: Omit<FieldContext, "form"> = {
    zones: options.zones,
    defaultTimeZone: options.defaultTimeZone,
    organizerEmail,
    recurrenceIdOfValue: (prop, value) => {
      const parsed = probeEvent(
        [line("EXDATE", value, [...prop.params])],
        options.timezones,
        options.defaultTimeZone,
      );
      const id = parsed?.exdates?.[0];
      return id ? normalizeRecurrenceId(id) : null;
    },
  };
  // 繰り返しの値は DTSTART の形に合わせるので、時刻を先に決める。
  const added: Line[] = [];
  for (const field of fields) {
    if (field === "recurrence") continue;
    added.push(
      ...fieldLines(field, event, existing, {
        ...context,
        form: { kind: "utc" },
      }),
    );
  }
  if (fields.includes("recurrence")) {
    const dtstart =
      added.find((prop) => prop.name === "DTSTART") ??
      kept.find((prop) => prop.name === "DTSTART");
    added.push(
      ...fieldLines("recurrence", event, existing, {
        ...context,
        form: timeFormOf(dtstart),
      }),
    );
  }
  // 参加者がいるのに主催者が無ければ、主催者を書く (RFC 5545 の 3.8.4.3)。
  const organizer: Line[] =
    !existingOrganizer &&
    options.organizer &&
    [...kept, ...added].some((prop) => prop.name === "ATTENDEE")
      ? [options.organizer]
      : [];
  const baseSequence = Number.parseInt(
    existing.find((prop) => prop.name === "SEQUENCE")?.value ?? "0",
    10,
  );
  // 時刻と繰り返しを変えたら SEQUENCE を上げる (RFC 5545 の 3.8.7.4)。
  // 行の sequence が基の値より大きければ、API が既に上げている (もう 1 回上げると、招待メールに
  // 書いた SEQUENCE とリソースの SEQUENCE がずれる。imip-design 5.1)。
  const significant =
    base !== null && (fields.includes("time") || fields.includes("recurrence"));
  const known = Number.isFinite(baseSequence) ? baseSequence : 0;
  // 他人が主催する予定 (取り込んだ招待など) では上げない。SEQUENCE を決めるのは主催者で、
  // 上げると主催者の次の更新が古く見え、こちらの返事の SEQUENCE もずれる (レビュー 8b 指摘 15)。
  const bump = significant && event.organizer?.self !== false;
  const sequence =
    event.sequence > known ? event.sequence : known + (bump ? 1 : 0);
  const stamp = utcStamp(toInstant(options.now));
  const props = [
    ...head,
    ...kept,
    line("DTSTAMP", stamp),
    line("LAST-MODIFIED", stamp),
    line("SEQUENCE", String(sequence)),
    ...organizer,
    ...added,
  ];
  let children = base?.children ?? [];
  if (fields.includes("reminders") || fields.includes("useDefaultReminders")) {
    // 消すのは、基にした VEVENT を読んだときにリマインダーになった VALARM だけ。
    const baseAllDay = base ? isAllDayComponent(base) : event.allDay;
    children = [
      ...children.filter(
        (childComponent) =>
          childComponent.name !== "VALARM" ||
          !isManagedAlarm(childComponent, baseAllDay),
      ),
      ...alarmComponents(event, options.alarmEmail),
    ];
  }
  return { name: "VEVENT", props, children };
}

/**
 * プロパティの行だけの VEVENT を parseICalendar で読む (回や EXDATE を、読み取りと同じ読み方で求める)。
 * UID と DTSTART が無ければ、読むためだけに補う。読めなければ null。
 */
function probeEvent(
  props: readonly Line[],
  timezones: readonly Component[],
  defaultTimeZone: string,
) {
  const out: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (const timezone of timezones) serialize(timezone, out);
  const probe: Component = {
    name: "VEVENT",
    props: [
      ...(props.some((prop) => prop.name === "UID")
        ? []
        : [line("UID", "probe")]),
      ...(props.some((prop) => prop.name === "DTSTART")
        ? []
        : [line("DTSTART", "20000101T000000Z")]),
      ...props,
    ],
    children: [],
  };
  serialize(probe, out);
  out.push("END:VCALENDAR");
  try {
    return (
      parseICalendar(out.join("\r\n"), { defaultTimeZone }).events[0] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * 基の VEVENT の回 (recurrenceId) を、parseICalendar と同じ読み方で求める。
 * RECURRENCE-ID があるのに読めなければ readable: false (原本と取り違えないため)。
 */
function recurrenceIdOf(
  component: Component,
  timezones: readonly Component[],
  defaultTimeZone: string,
): { recurrenceId: string | null; readable: boolean } {
  if (!component.props.some((prop) => prop.name === "RECURRENCE-ID")) {
    return { recurrenceId: null, readable: true };
  }
  const recurrenceId =
    probeEvent(component.props, timezones, defaultTimeZone)?.recurrenceId ??
    null;
  return { recurrenceId, readable: recurrenceId !== null };
}

/**
 * VCALENDAR のリソースを書き出す。原本と例外をまとめて 1 つのリソースにする。
 * - base の VEVENT のうち、entries と同じ回のものは、指定した項目だけを差し替える。
 * - entries のうち base に無い回は、新しい VEVENT として足す。
 * - remove の回の VEVENT は取り除く。
 * - それ以外のコンポーネントとプロパティは、そのまま残す (RECURRENCE-ID を読めない VEVENT も
 *   突き合わせに使わず、そのまま残す)。
 * - RDATE / EXDATE / 新しい RECURRENCE-ID は、原本の DTSTART の形 (TZID 付きの現地時刻、浮動、UTC、日付) で書く。
 * - 参加者がいて ORGANIZER が無い VEVENT には ORGANIZER を書く (新しい例外は原本のものを写す)。
 * - 書いた TZID の VTIMEZONE が無ければ足す。
 */
export function writeICalendar(options: ICalWriteOptions): string {
  const now = options.now ?? new Date();
  const parsedBase = options.base ? parseComponents(options.base) : null;
  const baseCalendar =
    parsedBase?.children.find((component) => component.name === "VCALENDAR") ??
    null;
  const calendar: Component = baseCalendar
    ? { ...baseCalendar, children: [...baseCalendar.children] }
    : {
        name: "VCALENDAR",
        props: [
          line("VERSION", "2.0"),
          line("PRODID", ICAL_PRODID),
          line("CALSCALE", "GREGORIAN"),
        ],
        children: [],
      };
  const timezones = calendar.children.filter(
    (component) => component.name === "VTIMEZONE",
  );
  const keyOf = (recurrenceId: string | null) =>
    recurrenceId === null ? "" : normalizeRecurrenceId(recurrenceId);
  const located = new Map<Component, string>();
  for (const component of calendar.children) {
    if (component.name !== "VEVENT") continue;
    const { recurrenceId, readable } = recurrenceIdOf(
      component,
      timezones,
      options.defaultTimeZone,
    );
    if (readable) located.set(component, keyOf(recurrenceId));
  }
  const removeKeys = new Set((options.remove ?? []).map(keyOf));
  const zones = new Set<string>();
  const written = new Set<string>();
  const children: Component[] = [];
  const pending = new Map(
    options.entries.map((entry) => [keyOf(entry.event.recurrenceId), entry]),
  );
  /** 原本の VEVENT (書いたあとのもの)。新しい例外の RECURRENCE-ID と ORGANIZER に使う。 */
  let master: Component | null = null;
  const organizerFor = (entry: ICalWriteEntry, isNew: boolean): Line | null => {
    if (isNew && entry.event.recurrenceId !== null) {
      const copied = master?.props.find((prop) => prop.name === "ORGANIZER");
      if (copied) return copied;
    }
    const who = options.organizer ?? entry.event.organizer;
    if (!who?.email) return null;
    return line(
      "ORGANIZER",
      `mailto:${who.email}`,
      who.name ? [["CN", who.name]] : [],
    );
  };
  const vEventOptions = (entry: ICalWriteEntry, isNew: boolean) => ({
    zones,
    alarmEmail: options.alarmEmail ?? null,
    now,
    defaultTimeZone: options.defaultTimeZone,
    timezones,
    recurrenceForm: timeFormOf(
      master?.props.find((prop) => prop.name === "DTSTART"),
    ),
    organizer: organizerFor(entry, isNew),
  });
  for (const component of calendar.children) {
    const key = located.get(component);
    if (key === undefined) {
      children.push(component);
      continue;
    }
    if (removeKeys.has(key) || written.has(key)) continue;
    const entry = pending.get(key);
    let result = component;
    if (entry) {
      result = writeVEvent(component, entry, vEventOptions(entry, false));
      written.add(key);
    }
    children.push(result);
    if (key === "") master = result;
  }
  // 新しく足す VEVENT は、原本を先に書く (例外が原本の DTSTART の形と ORGANIZER を使うため)。
  const additions = [...pending].filter(
    ([key]) => !written.has(key) && !removeKeys.has(key),
  );
  additions.sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));
  for (const [key, entry] of additions) {
    const result = writeVEvent(null, entry, vEventOptions(entry, true));
    children.push(result);
    if (key === "") master = result;
  }
  // 足りない VTIMEZONE を、最初の VEVENT の前に足す。
  const known = new Set(
    timezones.map((component) =>
      component.props.find((prop) => prop.name === "TZID")?.value.trim(),
    ),
  );
  const missing = [...zones].filter((zone) => !known.has(zone)).sort();
  const firstEvent = children.findIndex(
    (component) => component.name === "VEVENT",
  );
  const reference = options.entries[0]?.event.startAt ?? now;
  children.splice(
    firstEvent < 0 ? children.length : firstEvent,
    0,
    ...missing.map((zone) =>
      vtimezoneComponent(
        zone,
        new Date(toInstant(reference).epochMilliseconds),
      ),
    ),
  );
  calendar.children = children;
  const out: string[] = [];
  serialize(calendar, out);
  return `${out.join("\r\n")}\r\n`;
}
