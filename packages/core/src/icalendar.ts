import { createHash } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { instantRecurrenceId } from "./recurrence.js";

/**
 * iCalendar (RFC 5545) の読み取り。ICS の購読と CalDAV で使う。
 * VEVENT だけを読み、VTODO などは読み飛ばす。
 */

export type ParsedAttendee = {
  email: string;
  name: string | null;
  role: "chair" | "required" | "optional" | "non_participant";
  status: "needs_action" | "accepted" | "declined" | "tentative" | "delegated";
  /**
   * SENT-BY (代理で返事・招待した人のアドレス)。無ければ null。parseICalendar は必ず入れる
   * (Google / Microsoft の読み取りには無いので省ける)。
   */
  sentBy?: string | null;
  /** RSVP=TRUE (返事を求められている)。parseICalendar は必ず入れる。 */
  rsvp?: boolean;
};

export type ParsedReminder = { method: "display" | "email"; minutes: number };

/** 読み取った予定。events テーブルの列に合わせてある。 */
export type ParsedEvent = {
  uid: string;
  /** 例外のとき元の回 (recurrence.ts の recurrenceId の書き方)。 */
  recurrenceId: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  busy: boolean;
  allDay: boolean;
  /** 時刻付きの予定の開始と終了 (UTC の ISO 8601)。 */
  startAt: string | null;
  endAt: string | null;
  /** 終日の予定の開始と終了 (YYYY-MM-DD、終了の日は含まない)。 */
  startDate: string | null;
  endDate: string | null;
  /** IANA 名か "+09:00" のようなオフセット。浮動時刻と終日は null。 */
  startTimeZone: string | null;
  endTimeZone: string | null;
  rrule: string | null;
  rdates: string[] | null;
  exdates: string[] | null;
  /** sentBy は SENT-BY (代理) のアドレス。無ければ鍵ごと無い。 */
  organizer: { email: string; name?: string; sentBy?: string } | null;
  attendees: ParsedAttendee[];
  sequence: number;
  conferenceUrl: string | null;
  /** LAST-MODIFIED (UTC の ISO 8601)。 */
  remoteUpdatedAt: string | null;
  /**
   * DTSTAMP (UTC の ISO 8601)。iTIP では、同じ SEQUENCE のメッセージの新旧の比較に使う。
   * parseICalendar は必ず入れる (無ければ null)。Google / Microsoft の読み取りには無い。
   */
  dtstamp?: string | null;
  /** COMMENT (iTIP の REPLY の返事のコメントなど)。複数あれば改行でつなぐ。parseICalendar は必ず入れる。 */
  comment?: string | null;
  /** VALARM から読んだリマインダー。VALARM が無ければ null (カレンダーの既定を使う)。 */
  reminders: ParsedReminder[] | null;
  /** VEVENT の元の文字列 (折り返しは戻してある)。 */
  raw: string;
};

export type ParsedCalendar = {
  /** X-WR-CALNAME。 */
  name: string | null;
  /** X-WR-CALDESC。 */
  description: string | null;
  /** X-APPLE-CALENDAR-COLOR などの色 ("#rrggbb")。 */
  color: string | null;
  /** X-WR-TIMEZONE。 */
  timeZone: string | null;
  /** METHOD (iTIP、RFC 5546。"REQUEST" / "CANCEL" / "REPLY" など、大文字)。無ければ null。 */
  method: string | null;
  events: ParsedEvent[];
};

export type ParseOptions = {
  /** 浮動時刻 (タイムゾーン無し) を UTC にするときのタイムゾーン。 */
  defaultTimeZone: string;
  /** 読む VEVENT の上限 (同じ UID と回の重なりも数える)。既定 20000。 */
  maxEvents?: number;
  /** 行数 (折り返しを戻す前の物理行) の上限。超えたら ICalendarError。既定は無制限。 */
  maxLines?: number;
};

/**
 * コンポーネントの入れ子の深さの上限 (VCALENDAR > VEVENT > VALARM、VCALENDAR > VTIMEZONE >
 * STANDARD で 3。余裕を見て 4)。超えたら ICalendarError (閉じない BEGIN を並べた入力対策)。
 */
export const MAX_COMPONENT_DEPTH = 4;

/** 行 (raw) を控えるコンポーネント。それ以外は lines を持たない。 */
const RECORDED_COMPONENTS = new Set(["VEVENT", "VTIMEZONE"]);

export class ICalendarError extends Error {}

type Property = {
  name: string;
  params: Map<string, string>;
  value: string;
};

type Component = {
  name: string;
  properties: Property[];
  children: Component[];
  lines: string[];
};

/** Windows のタイムゾーン名 (Outlook / Exchange が書く TZID) と IANA 名の対応 (CLDR の windowsZones から主なもの)。 */
const WINDOWS_ZONES: Record<string, string> = {
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei",
  "Singapore Standard Time": "Asia/Singapore",
  "SE Asia Standard Time": "Asia/Bangkok",
  "India Standard Time": "Asia/Kolkata",
  "Arabian Standard Time": "Asia/Dubai",
  "Israel Standard Time": "Asia/Jerusalem",
  "Russian Standard Time": "Europe/Moscow",
  UTC: "Etc/UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "E. South America Standard Time": "America/Sao_Paulo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "W. Australia Standard Time": "Australia/Perth",
  "New Zealand Standard Time": "Pacific/Auckland",
};

/** 折り返した行を戻す (CRLF / LF のどちらでもよい)。 */
function unfold(text: string, maxLines?: number): string[] {
  const lines: string[] = [];
  const physical = text.replace(/^﻿/, "").split(/\r?\n/);
  if (maxLines !== undefined && physical.length > maxLines) {
    throw new ICalendarError("行が多すぎます。");
  }
  for (const line of physical) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function parseLine(line: string): Property | null {
  let index = 0;
  let quoted = false;
  let nameEnd = -1;
  let valueStart = -1;
  for (; index < line.length; index++) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ";" && nameEnd < 0) nameEnd = index;
    else if (!quoted && char === ":") {
      valueStart = index + 1;
      if (nameEnd < 0) nameEnd = index;
      break;
    }
  }
  if (valueStart < 0) return null;
  const name = line.slice(0, nameEnd).toUpperCase();
  const params = new Map<string, string>();
  const paramText = line.slice(nameEnd, valueStart - 1);
  for (const match of paramText.matchAll(/;([^=;:]+)=("[^"]*"|[^;:]*)/g)) {
    const key = match[1]?.toUpperCase();
    const raw = match[2] ?? "";
    if (key) params.set(key, raw.replace(/^"(.*)"$/, "$1"));
  }
  return { name, params, value: line.slice(valueStart) };
}

function parseComponents(lines: string[]): Component {
  const root: Component = { name: "", properties: [], children: [], lines };
  const stack: Component[] = [root];
  // 行を控える先は、開いているうちで直近の VEVENT / VTIMEZONE だけ (1 行あたり O(1))。
  const recorders: (Component | null)[] = [null];
  for (const line of lines) {
    const property = parseLine(line);
    if (!property) continue;
    const current = stack[stack.length - 1] as Component;
    const recorder = recorders[recorders.length - 1] ?? null;
    if (property.name === "BEGIN") {
      if (stack.length > MAX_COMPONENT_DEPTH) {
        throw new ICalendarError("コンポーネントの入れ子が深すぎます。");
      }
      const name = property.value.trim().toUpperCase();
      const child: Component = {
        name,
        properties: [],
        children: [],
        lines: [],
      };
      const next = RECORDED_COMPONENTS.has(name) ? child : recorder;
      next?.lines.push(line);
      current.children.push(child);
      stack.push(child);
      recorders.push(next);
      continue;
    }
    recorder?.lines.push(line);
    if (property.name === "END") {
      if (stack.length > 1) {
        stack.pop();
        recorders.pop();
      }
      continue;
    }
    current.properties.push(property);
  }
  return root;
}

/** TEXT の値のエスケープを戻す。 */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

function first(component: Component, name: string): Property | undefined {
  return component.properties.find((property) => property.name === name);
}

function text(component: Component, name: string): string | null {
  const property = first(component, name);
  if (!property) return null;
  const value = unescapeText(property.value).trim();
  return value.length > 0 ? value : null;
}

function isTimeZone(id: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(id);
    return true;
  } catch {
    return false;
  }
}

type ZoneResolver = (tzid: string) => string | null;

/** TZID を、展開に使えるタイムゾーン (IANA 名かオフセット) にする。 */
function zoneResolver(calendar: Component): ZoneResolver {
  const definitions = new Map<string, Component>();
  for (const child of calendar.children) {
    if (child.name !== "VTIMEZONE") continue;
    const id = first(child, "TZID")?.value.trim();
    if (id) definitions.set(id, child);
  }
  const cache = new Map<string, string | null>();
  return (tzid) => {
    const cached = cache.get(tzid);
    if (cached !== undefined) return cached;
    const resolved = resolveZone(tzid, definitions.get(tzid));
    cache.set(tzid, resolved);
    return resolved;
  };
}

function resolveZone(tzid: string, definition?: Component): string | null {
  // "/mozilla.org/20050126_1/Asia/Tokyo" のような書き方もある。
  const candidates = [
    tzid.trim(),
    tzid.trim().replace(/^\/[^/]+\/[^/]+\//, ""),
  ];
  for (const candidate of candidates) {
    const windows = WINDOWS_ZONES[candidate];
    if (windows) return windows;
    if (isTimeZone(candidate)) return candidate;
  }
  if (definition) {
    const location = first(definition, "X-LIC-LOCATION")?.value.trim();
    if (location && isTimeZone(location)) return location;
    // 名前が分からなければ、標準時のオフセットで代える (夏時間は無視される)。
    const standard =
      definition.children.find((child) => child.name === "STANDARD") ??
      definition.children[0];
    const offset = standard && first(standard, "TZOFFSETTO")?.value.trim();
    const match = offset && /^([+-])(\d{2})(\d{2})/.exec(offset);
    if (match) return `${match[1]}${match[2]}:${match[3]}`;
  }
  return null;
}

type DateValue =
  | { kind: "date"; date: string }
  | { kind: "time"; instant: string; timeZone: string | null };

function parseDateValue(
  value: string,
  params: Map<string, string>,
  resolve: ZoneResolver,
  defaultTimeZone: string,
): DateValue | null {
  const trimmed = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (date || params.get("VALUE")?.toUpperCase() === "DATE") {
    if (!date) return null;
    return { kind: "date", date: `${date[1]}-${date[2]}-${date[3]}` };
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(
    trimmed,
  );
  if (!time) return null;
  const local = Temporal.PlainDateTime.from({
    year: Number(time[1]),
    month: Number(time[2]),
    day: Number(time[3]),
    hour: Number(time[4]),
    minute: Number(time[5]),
    // 60 秒 (うるう秒) は 59 秒として読む。
    second: Math.min(59, Number(time[6])),
  });
  if (time[7] === "Z") {
    return {
      kind: "time",
      instant: local.toZonedDateTime("UTC").toInstant().toString(),
      timeZone: "UTC",
    };
  }
  const tzid = params.get("TZID");
  const zone = tzid ? resolve(tzid) : null;
  return {
    kind: "time",
    instant: local
      .toZonedDateTime(zone ?? defaultTimeZone)
      .toInstant()
      .toString(),
    timeZone: zone,
  };
}

/** RDATE / EXDATE (複数行・カンマ区切り) を recurrenceId の書き方にする。 */
function dateList(
  component: Component,
  name: string,
  resolve: ZoneResolver,
  defaultTimeZone: string,
): string[] | null {
  const result: string[] = [];
  for (const property of component.properties) {
    if (property.name !== name) continue;
    if (property.params.get("VALUE")?.toUpperCase() === "PERIOD") {
      // 期間の RDATE は開始だけを使う。
      for (const part of property.value.split(",")) {
        const start = part.split("/")[0] ?? "";
        const parsed = parseDateValue(
          start,
          property.params,
          resolve,
          defaultTimeZone,
        );
        if (parsed) result.push(recurrenceIdOf(parsed));
      }
      continue;
    }
    for (const part of property.value.split(",")) {
      const parsed = parseDateValue(
        part,
        property.params,
        resolve,
        defaultTimeZone,
      );
      if (parsed) result.push(recurrenceIdOf(parsed));
    }
  }
  return result.length > 0 ? [...new Set(result)] : null;
}

function recurrenceIdOf(value: DateValue): string {
  return value.kind === "date"
    ? value.date
    : instantRecurrenceId(value.instant);
}

function parseDuration(value: string): Temporal.Duration | null {
  try {
    return Temporal.Duration.from(value.trim());
  } catch {
    return null;
  }
}

function mailAddress(value: string): string | null {
  const address = value.trim().replace(/^mailto:/i, "");
  return address.includes("@") ? address : null;
}

/** SENT-BY のアドレス ("mailto:…" を外す)。無いか、アドレスでなければ null。 */
function sentByOf(property: Property): string | null {
  const value = property.params.get("SENT-BY");
  return value ? mailAddress(value) : null;
}

const ROLES: Record<string, ParsedAttendee["role"]> = {
  CHAIR: "chair",
  "REQ-PARTICIPANT": "required",
  "OPT-PARTICIPANT": "optional",
  "NON-PARTICIPANT": "non_participant",
};

const PARTSTATS: Record<string, ParsedAttendee["status"]> = {
  "NEEDS-ACTION": "needs_action",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  DELEGATED: "delegated",
};

function attendees(component: Component): ParsedAttendee[] {
  const seen = new Set<string>();
  const result: ParsedAttendee[] = [];
  for (const property of component.properties) {
    if (property.name !== "ATTENDEE") continue;
    const email = mailAddress(property.value);
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    result.push({
      email,
      name: property.params.get("CN")?.trim() || null,
      role:
        ROLES[property.params.get("ROLE")?.toUpperCase() ?? ""] ?? "required",
      status:
        PARTSTATS[property.params.get("PARTSTAT")?.toUpperCase() ?? ""] ??
        "needs_action",
      sentBy: sentByOf(property),
      rsvp: property.params.get("RSVP")?.trim().toUpperCase() === "TRUE",
    });
  }
  return result;
}

/** VALARM のうち、開始からの相対時刻のものをリマインダーにする。 */
function reminders(component: Component): ParsedReminder[] | null {
  const alarms = component.children.filter((child) => child.name === "VALARM");
  if (alarms.length === 0) return null;
  const result: ParsedReminder[] = [];
  for (const alarm of alarms) {
    const trigger = first(alarm, "TRIGGER");
    if (
      !trigger ||
      trigger.params.get("VALUE")?.toUpperCase() === "DATE-TIME"
    ) {
      continue;
    }
    if (trigger.params.get("RELATED")?.toUpperCase() === "END") continue;
    const duration = parseDuration(trigger.value);
    if (!duration) continue;
    const minutes = Math.round(
      -duration.total({
        unit: "minutes",
        relativeTo: "2000-01-01T00:00:00[UTC]",
      }),
    );
    if (minutes < 0) continue;
    const action = first(alarm, "ACTION")?.value.trim().toUpperCase();
    result.push({ method: action === "EMAIL" ? "email" : "display", minutes });
  }
  return result;
}

function conferenceUrl(component: Component): string | null {
  for (const name of [
    "X-GOOGLE-CONFERENCE",
    "X-MICROSOFT-SKYPETEAMSMEETINGURL",
    "X-MICROSOFT-ONLINEMEETINGCONFLINK",
  ]) {
    const value = first(component, name)?.value.trim();
    if (value && /^https:\/\//i.test(value)) return value;
  }
  return null;
}

function colorOf(calendar: Component): string | null {
  for (const name of ["X-APPLE-CALENDAR-COLOR", "COLOR", "X-OUTLOOK-COLOR"]) {
    const value = first(calendar, name)?.value.trim();
    const match = value && /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
    if (match) return `#${match[1]?.toLowerCase()}`;
  }
  return null;
}

function parseEvent(
  component: Component,
  resolve: ZoneResolver,
  defaultTimeZone: string,
): ParsedEvent | null {
  const dtstart = first(component, "DTSTART");
  if (!dtstart) return null;
  const start = parseDateValue(
    dtstart.value,
    dtstart.params,
    resolve,
    defaultTimeZone,
  );
  if (!start) return null;
  const raw = component.lines.join("\r\n");
  const uid =
    first(component, "UID")?.value.trim() ||
    `orbit-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;

  const dtend = first(component, "DTEND");
  const end = dtend
    ? parseDateValue(dtend.value, dtend.params, resolve, defaultTimeZone)
    : null;
  const durationProperty = first(component, "DURATION");
  const duration = durationProperty
    ? parseDuration(durationProperty.value)
    : null;

  let timing: Pick<
    ParsedEvent,
    | "allDay"
    | "startAt"
    | "endAt"
    | "startDate"
    | "endDate"
    | "startTimeZone"
    | "endTimeZone"
  >;
  if (start.kind === "date") {
    const durationDays = duration ? duration.weeks * 7 + duration.days : 0;
    let endDate =
      end?.kind === "date"
        ? end.date
        : Temporal.PlainDate.from(start.date)
            .add({ days: durationDays > 0 ? durationDays : 1 })
            .toString();
    if (Temporal.PlainDate.compare(endDate, start.date) <= 0) {
      endDate = Temporal.PlainDate.from(start.date).add({ days: 1 }).toString();
    }
    timing = {
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: start.date,
      endDate,
      startTimeZone: null,
      endTimeZone: null,
    };
  } else {
    let endAt = start.instant;
    let endTimeZone = start.timeZone;
    if (end?.kind === "time") {
      endAt = end.instant;
      endTimeZone = end.timeZone;
    } else if (duration) {
      endAt = Temporal.Instant.from(start.instant)
        .toZonedDateTimeISO(start.timeZone ?? defaultTimeZone)
        .add(duration)
        .toInstant()
        .toString();
    }
    if (Temporal.Instant.compare(endAt, start.instant) < 0)
      endAt = start.instant;
    timing = {
      allDay: false,
      startAt: start.instant,
      endAt,
      startDate: null,
      endDate: null,
      startTimeZone: start.timeZone,
      endTimeZone,
    };
  }

  const recurrence = first(component, "RECURRENCE-ID");
  const recurrenceValue = recurrence
    ? parseDateValue(
        recurrence.value,
        recurrence.params,
        resolve,
        defaultTimeZone,
      )
    : null;
  const organizerProperty = first(component, "ORGANIZER");
  const organizerEmail = organizerProperty
    ? mailAddress(organizerProperty.value)
    : null;
  const organizerName = organizerProperty?.params.get("CN")?.trim();
  const organizerSentBy = organizerProperty
    ? sentByOf(organizerProperty)
    : null;
  const statusValue = first(component, "STATUS")?.value.trim().toUpperCase();
  const lastModified = first(component, "LAST-MODIFIED");
  const modified = lastModified
    ? parseDateValue(lastModified.value, lastModified.params, resolve, "UTC")
    : null;
  const sequence = Number.parseInt(
    first(component, "SEQUENCE")?.value ?? "0",
    10,
  );
  const dtstampProperty = first(component, "DTSTAMP");
  const dtstamp = dtstampProperty
    ? parseDateValue(
        dtstampProperty.value,
        dtstampProperty.params,
        resolve,
        "UTC",
      )
    : null;
  const comments = component.properties
    .filter((property) => property.name === "COMMENT")
    .map((property) => unescapeText(property.value).trim())
    .filter((value) => value.length > 0);

  return {
    uid,
    recurrenceId: recurrenceValue ? recurrenceIdOf(recurrenceValue) : null,
    summary: text(component, "SUMMARY"),
    location: text(component, "LOCATION"),
    description: text(component, "DESCRIPTION"),
    status:
      statusValue === "CANCELLED"
        ? "cancelled"
        : statusValue === "TENTATIVE"
          ? "tentative"
          : "confirmed",
    busy:
      first(component, "TRANSP")?.value.trim().toUpperCase() !== "TRANSPARENT",
    ...timing,
    rrule: first(component, "RRULE")?.value.trim() || null,
    rdates: dateList(component, "RDATE", resolve, defaultTimeZone),
    exdates: dateList(component, "EXDATE", resolve, defaultTimeZone),
    organizer: organizerEmail
      ? {
          email: organizerEmail,
          ...(organizerName ? { name: organizerName } : {}),
          ...(organizerSentBy ? { sentBy: organizerSentBy } : {}),
        }
      : null,
    attendees: attendees(component),
    sequence: Number.isFinite(sequence) && sequence >= 0 ? sequence : 0,
    conferenceUrl: conferenceUrl(component),
    remoteUpdatedAt: modified?.kind === "time" ? modified.instant : null,
    dtstamp: dtstamp?.kind === "time" ? dtstamp.instant : null,
    comment: comments.length > 0 ? comments.join("\n") : null,
    reminders: reminders(component),
    raw,
  };
}

/** iCalendar の文字列を読む。VCALENDAR が無ければ ICalendarError。 */
export function parseICalendar(
  input: string,
  options: ParseOptions,
): ParsedCalendar {
  const root = parseComponents(unfold(input, options.maxLines));
  const calendar = root.children.find((child) => child.name === "VCALENDAR");
  if (!calendar) throw new ICalendarError("VCALENDAR がありません。");
  const resolve = zoneResolver(calendar);
  const declared = first(calendar, "X-WR-TIMEZONE")?.value.trim();
  const calendarZone = declared ? resolveZone(declared) : null;
  const defaultTimeZone = calendarZone ?? options.defaultTimeZone;
  const limit = options.maxEvents ?? 20_000;
  const events: ParsedEvent[] = [];
  // UID と回 → events の位置 (重なりの置き換えを O(1) にする)。
  const seen = new Map<string, number>();
  // 重なり (同じ UID と回) も数える。同じ UID を並べた入力で上限が効かなくならないように。
  let read = 0;
  for (const child of calendar.children) {
    if (child.name !== "VEVENT") continue;
    if (read >= limit) break;
    read++;
    const event = parseEvent(child, resolve, defaultTimeZone);
    if (!event) continue;
    // 同じ UID と回が重なっていれば、SEQUENCE の大きい方 (同じなら後ろ) を使う。
    const key = `${event.uid}\u0000${event.recurrenceId ?? ""}`;
    const index = seen.get(key);
    if (index !== undefined) {
      const existing = events[index];
      if (existing && event.sequence >= existing.sequence)
        events[index] = event;
      continue;
    }
    seen.set(key, events.length);
    events.push(event);
    if (events.length >= limit) break;
  }
  return {
    name: text(calendar, "X-WR-CALNAME"),
    description: text(calendar, "X-WR-CALDESC"),
    color: colorOf(calendar),
    timeZone: calendarZone,
    method: first(calendar, "METHOD")?.value.trim().toUpperCase() || null,
    events,
  };
}
