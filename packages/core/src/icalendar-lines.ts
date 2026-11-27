import { Temporal } from "temporal-polyfill";
import { normalizeRecurrenceId } from "./recurrence.js";

/**
 * iCalendar (RFC 5545) の行の組み立ての内部モジュール。CalDAV の書き戻し (icalendar-write.ts) と
 * iTIP の書き出し (itip.ts) の両方から使う。web からも読まれうるので Node 専用の API を使わない。
 */

export const ICAL_PRODID = "-//Orbit//Orbit Calendar//JA";

type AttendeeRole = "chair" | "required" | "optional" | "non_participant";
type AttendeeStatus =
  | "needs_action"
  | "accepted"
  | "declined"
  | "tentative"
  | "delegated";

/** ROLE の値 (events の参加者の role → iCalendar)。 */
export const ROLE_VALUES: Record<AttendeeRole, string> = {
  chair: "CHAIR",
  required: "REQ-PARTICIPANT",
  optional: "OPT-PARTICIPANT",
  non_participant: "NON-PARTICIPANT",
};

/** PARTSTAT の値 (events の参加者の status → iCalendar)。 */
export const PARTSTAT_VALUES: Record<AttendeeStatus, string> = {
  needs_action: "NEEDS-ACTION",
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
  delegated: "DELEGATED",
};

// ---------------------------------------------------------------------------
// 読み取り (書き換えのための、行をそのまま保つ読み取り)

export type Line = {
  name: string;
  params: Map<string, string>;
  value: string;
  raw: string;
};

export type Component = {
  name: string;
  /** BEGIN と END を除くプロパティの行 (折り返しは戻してある)。 */
  props: Line[];
  children: Component[];
};

export function unfold(text: string): string[] {
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

export function parseLine(raw: string): Line | null {
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

export function parseComponents(text: string): Component {
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

/**
 * 行に書けない制御文字 (CR・LF を含む U+0000〜U+001F と U+007F。HTAB だけは残す)。
 * 値に CR / LF が残ると、続きが別の行 (別のプロパティや VEVENT) として読まれるので、
 * 書き出す値はすべてここを通して取り除く (TEXT の改行は先に escapeICalText で \n にしておく)。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くための正規表現
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

export function stripControl(value: string): string {
  return value.replace(CONTROL, "");
}

/** パラメータの値。区切り文字を含むなら引用符で囲む (引用符そのものは使えないので外す)。 */
export function paramValue(value: string): string {
  const cleaned = stripControl(value).replace(/"/g, "");
  return /[;:,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

export function line(
  name: string,
  value: string,
  params: [string, string][] = [],
): Line {
  const safeName = stripControl(name);
  const safeValue = stripControl(value);
  const paramText = params
    .map(([key, param]) => `;${stripControl(key)}=${paramValue(param)}`)
    .join("");
  const raw = `${safeName}${paramText}:${safeValue}`;
  return (
    parseLine(raw) ?? {
      name: safeName,
      params: new Map(params),
      value: safeValue,
      raw,
    }
  );
}

/** 1 文字 (コードポイント) の UTF-8 のバイト数。 */
function utf8Size(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/** 75 オクテットで折り返す (UTF-8 の文字の途中では切らない)。 */
export function fold(unsafe: string): string {
  // 読み込んだ行をそのまま書き戻す場合も含め、出口でもう一度制御文字を除く。
  const raw = stripControl(unsafe);
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of raw) {
    const size = utf8Size(char);
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

export function serialize(component: Component, out: string[]) {
  out.push(fold(`BEGIN:${component.name}`));
  for (const prop of component.props) out.push(fold(prop.raw));
  for (const childComponent of component.children)
    serialize(childComponent, out);
  out.push(fold(`END:${component.name}`));
}

export function isIanaZone(zone: string | null): zone is string {
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

export function toInstant(value: Date | string): Temporal.Instant {
  return Temporal.Instant.from(
    typeof value === "string" ? value : value.toISOString(),
  );
}

export function basicDate(date: string): string {
  return date.replace(/-/g, "");
}

export function utcStamp(instant: Temporal.Instant): string {
  const value = instant.toString({ smallestUnit: "second" });
  return value.replace(/[-:]/g, "");
}

export function localStamp(value: Temporal.PlainDateTime): string {
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return `${pad(value.year, 4)}${pad(value.month)}${pad(value.day)}T${pad(value.hour)}${pad(value.minute)}${pad(value.second)}`;
}

/** 時刻のプロパティ (DTSTART / DTEND)。IANA のタイムゾーンなら TZID 付きの現地時刻、ほかは UTC。 */
export function timeLine(
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
export type TimeForm =
  | { kind: "date" }
  | { kind: "utc" }
  | { kind: "zone"; zone: string }
  | { kind: "floating" };

export function timeFormOf(dtstart: Line | undefined): TimeForm {
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
export function recurrenceValue(
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

export function offsetText(offset: string): string {
  const match = /^([+-])(\d{2}):(\d{2})/.exec(offset);
  return match ? `${match[1]}${match[2]}${match[3]}` : "+0000";
}

export function vtimezoneComponent(zone: string, around: Date): Component {
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
