import { Temporal } from "temporal-polyfill";
import type { EventFieldName } from "./event-merge.js";
import { parseICalendar } from "./icalendar.js";
import { normalizeRecurrenceId } from "./recurrence.js";

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
  organizer: { email: string; name?: string } | null;
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

export const ICAL_PRODID = "-//Orbit//Orbit Calendar//JA";

// ---------------------------------------------------------------------------
// 読み取り (書き換えのための、行をそのまま保つ読み取り)

type Line = {
  name: string;
  params: Map<string, string>;
  value: string;
  raw: string;
};

type Component = {
  name: string;
  /** BEGIN と END を除くプロパティの行 (折り返しは戻してある)。 */
  props: Line[];
  children: Component[];
};

function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function parseLine(raw: string): Line | null {
  let quoted = false;
  let nameEnd = -1;
  let valueStart = -1;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ";" && nameEnd < 0) nameEnd = index;
    else if (!quoted && char === ":") {
      valueStart = index + 1;
      if (nameEnd < 0) nameEnd = index;
      break;
    }
  }
  if (valueStart < 0) return null;
  const params = new Map<string, string>();
  for (const match of raw
    .slice(nameEnd, valueStart - 1)
    .matchAll(/;([^=;:]+)=("[^"]*"|[^;:]*)/g)) {
    const key = match[1]?.toUpperCase();
    if (key) params.set(key, (match[2] ?? "").replace(/^"(.*)"$/, "$1"));
  }
  return {
    name: raw.slice(0, nameEnd).toUpperCase(),
    params,
    value: raw.slice(valueStart),
    raw,
  };
}

function parseComponents(text: string): Component {
  const root: Component = { name: "", props: [], children: [] };
  const stack: Component[] = [root];
  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    const current = stack[stack.length - 1] as Component;
    if (line.name === "BEGIN") {
      const component: Component = {
        name: line.value.trim().toUpperCase(),
        props: [],
        children: [],
      };
      current.children.push(component);
      stack.push(component);
    } else if (line.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      current.props.push(line);
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// 書き出しの部品

/** TEXT の値をエスケープする。 */
export function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n?|\n/g, "\\n");
}

/** パラメータの値。区切り文字を含むなら引用符で囲む (引用符そのものは使えないので外す)。 */
function paramValue(value: string): string {
  const cleaned = value.replace(/["\r\n]/g, "");
  return /[;:,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function line(
  name: string,
  value: string,
  params: [string, string][] = [],
): Line {
  const paramText = params
    .map(([key, param]) => `;${key}=${paramValue(param)}`)
    .join("");
  const raw = `${name}${paramText}:${value}`;
  return parseLine(raw) ?? { name, params: new Map(params), value, raw };
}

/** 75 オクテットで折り返す (UTF-8 の文字の途中では切らない)。 */
function fold(raw: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of raw) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) {
      out.push(current);
      current = " ";
      bytes = 1;
      limit = 75;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n");
}

function serialize(component: Component, out: string[]) {
  out.push(fold(`BEGIN:${component.name}`));
  for (const prop of component.props) out.push(fold(prop.raw));
  for (const childComponent of component.children)
    serialize(childComponent, out);
  out.push(fold(`END:${component.name}`));
}

function isIanaZone(zone: string | null): zone is string {
  if (!zone) return false;
  if (/^[+-]\d{2}:?\d{2}$/.test(zone)) return false;
  if (/^(UTC|Etc\/UTC|GMT|Etc\/GMT|Z)$/i.test(zone)) return false;
  try {
    Temporal.Now.zonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}

function toInstant(value: Date | string): Temporal.Instant {
  return Temporal.Instant.from(
    typeof value === "string" ? value : value.toISOString(),
  );
}

function basicDate(date: string): string {
  return date.replace(/-/g, "");
}

function utcStamp(instant: Temporal.Instant): string {
  const value = instant.toString({ smallestUnit: "second" });
  return value.replace(/[-:]/g, "");
}

function localStamp(value: Temporal.PlainDateTime): string {
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return `${pad(value.year, 4)}${pad(value.month)}${pad(value.day)}T${pad(value.hour)}${pad(value.minute)}${pad(value.second)}`;
}

/** 時刻のプロパティ (DTSTART / DTEND)。IANA のタイムゾーンなら TZID 付きの現地時刻、ほかは UTC。 */
function timeLine(
  name: string,
  instant: Temporal.Instant,
  zone: string | null,
  zones: Set<string>,
): Line {
  if (isIanaZone(zone)) {
    zones.add(zone);
    return line(
      name,
      localStamp(instant.toZonedDateTimeISO(zone).toPlainDateTime()),
      [["TZID", zone]],
    );
  }
  return line(name, utcStamp(instant));
}

/**
 * 原本の DTSTART の書き方。RDATE / EXDATE / RECURRENCE-ID はこれに合わせる
 * (RFC 5545 の 3.8.4.4 と 3.8.5.1。違う形だと回を突き合わせられないサーバーがある)。
 */
type TimeForm =
  | { kind: "date" }
  | { kind: "utc" }
  | { kind: "zone"; zone: string }
  | { kind: "floating" };

function timeFormOf(dtstart: Line | undefined): TimeForm {
  if (!dtstart) return { kind: "utc" };
  const value = dtstart.value.trim();
  if (
    dtstart.params.get("VALUE")?.toUpperCase() === "DATE" ||
    /^\d{8}$/.test(value)
  ) {
    return { kind: "date" };
  }
  if (/Z$/i.test(value)) return { kind: "utc" };
  const tzid = dtstart.params.get("TZID");
  if (tzid !== undefined) {
    // IANA で無い TZID (Windows の名前など) は現地時刻を求められないので UTC で書く。
    return isIanaZone(tzid) ? { kind: "zone", zone: tzid } : { kind: "utc" };
  }
  return { kind: "floating" };
}

/** RDATE / EXDATE / RECURRENCE-ID の値。form (原本の DTSTART の形) に合わせる。日付だけの回は日付で書く。 */
function recurrenceValue(
  recurrenceId: string,
  form: TimeForm,
  defaultTimeZone: string,
  zones: Set<string>,
): {
  value: string;
  params: [string, string][];
} {
  const normalized = normalizeRecurrenceId(recurrenceId);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { value: basicDate(normalized), params: [["VALUE", "DATE"]] };
  }
  const instant = Temporal.Instant.from(normalized);
  switch (form.kind) {
    case "date":
      return {
        value: basicDate(
          instant.toZonedDateTimeISO(defaultTimeZone).toPlainDate().toString(),
        ),
        params: [["VALUE", "DATE"]],
      };
    case "zone":
      zones.add(form.zone);
      return {
        value: localStamp(
          instant.toZonedDateTimeISO(form.zone).toPlainDateTime(),
        ),
        params: [["TZID", form.zone]],
      };
    case "floating":
      // 浮動時刻は defaultTimeZone で読まれる (parseICalendar と同じ)。
      return {
        value: localStamp(
          instant.toZonedDateTimeISO(defaultTimeZone).toPlainDateTime(),
        ),
        params: [],
      };
    case "utc":
      return { value: utcStamp(instant), params: [] };
  }
}

function offsetText(offset: string): string {
  const match = /^([+-])(\d{2}):(\d{2})/.exec(offset);
  return match ? `${match[1]}${match[2]}${match[3]}` : "+0000";
}

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

function vtimezoneComponent(zone: string, around: Date): Component {
  const year = toInstant(around).toZonedDateTimeISO(zone).year;
  const startOfYear = Temporal.ZonedDateTime.from({
    timeZone: zone,
    year,
    month: 1,
    day: 1,
  });
  const transitions: Temporal.ZonedDateTime[] = [];
  let cursor: Temporal.ZonedDateTime | null = startOfYear;
  while (transitions.length < 3) {
    cursor = cursor.getTimeZoneTransition("next");
    if (!cursor || cursor.year !== year) break;
    transitions.push(cursor);
  }
  const observances: Component[] = [];
  const observance = (
    kind: "STANDARD" | "DAYLIGHT",
    start: string,
    from: string,
    to: string,
    rrule: string | null,
  ): Component => ({
    name: kind,
    props: [
      line("DTSTART", start),
      line("TZOFFSETFROM", offsetText(from)),
      line("TZOFFSETTO", offsetText(to)),
      ...(rrule ? [line("RRULE", rrule)] : []),
    ],
    children: [],
  });
  if (transitions.length === 0) {
    observances.push(
      observance(
        "STANDARD",
        "19700101T000000",
        startOfYear.offset,
        startOfYear.offset,
        null,
      ),
    );
  } else {
    const yearly = transitions.length === 2;
    if (!yearly) {
      observances.push(
        observance(
          "STANDARD",
          "19700101T000000",
          startOfYear.offset,
          startOfYear.offset,
          null,
        ),
      );
    }
    for (const transition of transitions) {
      const before = transition.subtract({ nanoseconds: 1 });
      const fromOffset = before.offset;
      const toOffset = transition.offset;
      const wall = transition
        .toInstant()
        .toZonedDateTimeISO(fromOffset)
        .toPlainDateTime();
      const daylight = transition.offsetNanoseconds > before.offsetNanoseconds;
      let rrule: string | null = null;
      if (yearly) {
        const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
        const ordinal =
          wall.day + 7 > wall.daysInMonth ? -1 : Math.ceil(wall.day / 7);
        rrule = `FREQ=YEARLY;BYMONTH=${wall.month};BYDAY=${ordinal}${days[wall.dayOfWeek - 1]}`;
      }
      observances.push(
        observance(
          daylight ? "DAYLIGHT" : "STANDARD",
          localStamp(wall),
          fromOffset,
          toOffset,
          rrule,
        ),
      );
    }
  }
  return {
    name: "VTIMEZONE",
    props: [line("TZID", zone)],
    children: observances,
  };
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

const ROLE_VALUES: Record<ICalEventData["attendees"][number]["role"], string> =
  {
    chair: "CHAIR",
    required: "REQ-PARTICIPANT",
    optional: "OPT-PARTICIPANT",
    non_participant: "NON-PARTICIPANT",
  };

const PARTSTAT_VALUES: Record<
  ICalEventData["attendees"][number]["status"],
  string
> = {
  needs_action: "NEEDS-ACTION",
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
  delegated: "DELEGATED",
};

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

/** parseICalendar がリマインダーとして読む VALARM か (開始からの相対時刻)。 */
function isManagedAlarm(alarm: Component): boolean {
  const trigger = alarm.props.find((entry) => entry.name === "TRIGGER");
  if (!trigger) return false;
  if (trigger.params.get("VALUE")?.toUpperCase() === "DATE-TIME") return false;
  if (trigger.params.get("RELATED")?.toUpperCase() === "END") return false;
  return true;
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
    const minutes = Math.max(0, Math.round(reminder.minutes));
    const email = reminder.method === "email" && alarmEmail;
    const key = `${email ? "email" : "display"}:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const description = escapeICalText(event.summary ?? "リマインダー");
    alarms.push({
      name: "VALARM",
      props: email
        ? [
            line("ACTION", "EMAIL"),
            line("TRIGGER", `-PT${minutes}M`),
            line("SUMMARY", description),
            line("DESCRIPTION", description),
            line("ATTENDEE", `mailto:${alarmEmail}`),
          ]
        : [
            line("ACTION", "DISPLAY"),
            line("TRIGGER", `-PT${minutes}M`),
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
  const significant =
    base !== null && (fields.includes("time") || fields.includes("recurrence"));
  const sequence =
    Math.max(Number.isFinite(baseSequence) ? baseSequence : 0, event.sequence) +
    (significant ? 1 : 0);
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
    children = [
      ...children.filter(
        (childComponent) =>
          childComponent.name !== "VALARM" || !isManagedAlarm(childComponent),
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
