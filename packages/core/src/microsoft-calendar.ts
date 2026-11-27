import { createHmac, timingSafeEqual } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { GRAPH_WEBHOOK_PATH } from "./graph-webhook.js";
import type { ParsedAttendee, ParsedEvent } from "./icalendar.js";
import { instantRecurrenceId, normalizeRecurrenceId } from "./recurrence.js";

/**
 * Microsoft Graph の予定 (event) と Orbit の予定の形の相互変換。純粋な関数だけを置く。
 * - 読み取り: Graph の JSON → 予定 1 行分 (parseGraphEvent)
 * - 繰り返し: patternedRecurrence ⇔ RRULE
 * - 書き込み: 予定の列 → PATCH / POST の本文 (graphEventBody)
 * - 変更通知: clientState と受け口の URL
 * https://learn.microsoft.com/graph/api/resources/event
 */

// ---------------------------------------------------------------------------
// タイムゾーン
// ---------------------------------------------------------------------------

/**
 * Windows のタイムゾーン名 → IANA 名。Graph の start.timeZone や originalStartTimeZone は
 * Windows 名で返ることが多い (icalendar.ts の WINDOWS_ZONES と同じ考え方で、範囲を広げたもの)。
 * 書き込みでは逆引きして Windows 名を送る (最初に出てくる名前を使う)。
 */
const MICROSOFT_WINDOWS_ZONES: Record<string, string> = {
  UTC: "Etc/UTC",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei",
  "Singapore Standard Time": "Asia/Singapore",
  "SE Asia Standard Time": "Asia/Bangkok",
  "India Standard Time": "Asia/Kolkata",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Myanmar Standard Time": "Asia/Yangon",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "W. Australia Standard Time": "Australia/Perth",
  "Philippines Standard Time": "Asia/Manila",
  "Malay Peninsula Standard Time": "Asia/Kuala_Lumpur",
  "Pakistan Standard Time": "Asia/Karachi",
  "West Asia Standard Time": "Asia/Tashkent",
  "Afghanistan Standard Time": "Asia/Kabul",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabic Standard Time": "Asia/Baghdad",
  "Israel Standard Time": "Asia/Jerusalem",
  "Jordan Standard Time": "Asia/Amman",
  "Middle East Standard Time": "Asia/Beirut",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Morocco Standard Time": "Africa/Casablanca",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "Canada Central Standard Time": "America/Regina",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Central America Standard Time": "America/Guatemala",
  "SA Pacific Standard Time": "America/Bogota",
  "SA Western Standard Time": "America/La_Paz",
  "SA Eastern Standard Time": "America/Cayenne",
  "Pacific SA Standard Time": "America/Santiago",
  "Argentina Standard Time": "America/Buenos_Aires",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Venezuela Standard Time": "America/Caracas",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "Tasmania Standard Time": "Australia/Hobart",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Fiji Standard Time": "Pacific/Fiji",
  "Samoa Standard Time": "Pacific/Apia",
  "Dateline Standard Time": "Etc/GMT+12",
};

const zoneCache = new Map<string, boolean>();

function isIanaZone(id: string): boolean {
  const cached = zoneCache.get(id);
  if (cached !== undefined) return cached;
  let ok: boolean;
  // "+09:00" のようなオフセットは、Graph のタイムゾーン名としては使えない。
  if (/^[+-]/.test(id)) return false;
  try {
    Temporal.Now.zonedDateTimeISO(id);
    ok = true;
  } catch {
    ok = false;
  }
  zoneCache.set(id, ok);
  return ok;
}

/** Graph のタイムゾーン名 (Windows 名か IANA 名) を IANA 名にする。分からなければ null。 */
export function graphTimeZoneToIana(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/^(utc|gmt|etc\/utc|z)$/i.test(trimmed)) return "Etc/UTC";
  const mapped = MICROSOFT_WINDOWS_ZONES[trimmed];
  if (mapped) return mapped;
  return isIanaZone(trimmed) ? trimmed : null;
}

const IANA_TO_WINDOWS = new Map<string, string>();
for (const [windows, iana] of Object.entries(MICROSOFT_WINDOWS_ZONES)) {
  if (!IANA_TO_WINDOWS.has(iana)) IANA_TO_WINDOWS.set(iana, windows);
}

/**
 * IANA 名を Graph に送る名前にする。対応表にあれば Windows 名、無ければ IANA 名のまま
 * (推測: Graph は IANA 名も受け付ける)。使えない値なら "UTC"。
 */
export function ianaToGraphTimeZone(zone: string | null | undefined): string {
  if (!zone || /^(utc|etc\/utc|gmt|z)$/i.test(zone)) return "UTC";
  const windows = IANA_TO_WINDOWS.get(zone);
  if (windows) return windows;
  return isIanaZone(zone) ? zone : "UTC";
}

/** IANA 名として使えるタイムゾーンか。"+09:00" などのオフセットや不明な名前は null。 */
function usableZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  return isIanaZone(zone) ? zone : null;
}

// ---------------------------------------------------------------------------
// Graph の JSON の形 (使う項目だけ)
// ---------------------------------------------------------------------------

export type GraphDateTimeTimeZone = { dateTime: string; timeZone?: string };

export type GraphRecurrencePattern = {
  type:
    | "daily"
    | "weekly"
    | "absoluteMonthly"
    | "relativeMonthly"
    | "absoluteYearly"
    | "relativeYearly";
  interval: number;
  month?: number;
  dayOfMonth?: number;
  daysOfWeek?: string[];
  firstDayOfWeek?: string;
  index?: "first" | "second" | "third" | "fourth" | "last";
};

export type GraphRecurrenceRange = {
  type: "endDate" | "noEnd" | "numbered";
  startDate: string;
  endDate?: string | null;
  recurrenceTimeZone?: string | null;
  numberOfOccurrences?: number;
};

export type GraphPatternedRecurrence = {
  pattern: GraphRecurrencePattern;
  range: GraphRecurrenceRange;
};

type GraphEmail = { emailAddress?: { address?: string; name?: string } };

export type GraphEvent = {
  id?: string;
  "@odata.etag"?: string;
  "@removed"?: { reason?: string };
  changeKey?: string;
  iCalUId?: string;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string | null;
  originalStart?: string | null;
  originalStartTimeZone?: string | null;
  originalEndTimeZone?: string | null;
  subject?: string | null;
  body?: { contentType?: string; content?: string } | null;
  location?: { displayName?: string | null } | null;
  start?: GraphDateTimeTimeZone | null;
  end?: GraphDateTimeTimeZone | null;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  recurrence?: GraphPatternedRecurrence | null;
  cancelledOccurrences?: string[] | null;
  organizer?: GraphEmail | null;
  attendees?: (GraphEmail & {
    type?: string;
    status?: { response?: string };
  })[];
  isReminderOn?: boolean;
  reminderMinutesBeforeStart?: number;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
  lastModifiedDateTime?: string | null;
  transactionId?: string | null;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// 時刻
// ---------------------------------------------------------------------------

function plainDateTime(value: string): Temporal.PlainDateTime {
  // Graph の dateTime は "2026-12-10T01:00:00.0000000" の形 (オフセット無し)。
  return Temporal.PlainDateTime.from(
    value.replace(/(Z|[+-]\d{2}:?\d{2})$/i, ""),
  );
}

/** dateTimeTimeZone を UTC の時刻にする。 */
function toInstant(value: GraphDateTimeTimeZone): Temporal.Instant {
  const zone = graphTimeZoneToIana(value.timeZone) ?? "Etc/UTC";
  return plainDateTime(value.dateTime)
    .toZonedDateTime(zone, { disambiguation: "compatible" })
    .toInstant();
}

function isoInstant(instant: Temporal.Instant): string {
  return instant.toString({ smallestUnit: "second" });
}

/** 終日の予定の日付。dateTime のタイムゾーンが元のタイムゾーンと違えば、元のタイムゾーンの日付にする。 */
function allDayDate(
  value: GraphDateTimeTimeZone,
  originalZone: string | null,
): string {
  const local = plainDateTime(value.dateTime);
  const zone = graphTimeZoneToIana(value.timeZone);
  if (!originalZone || !zone || zone === originalZone) {
    return local.toPlainDate().toString();
  }
  const converted = local
    .toZonedDateTime(zone, { disambiguation: "compatible" })
    .withTimeZone(originalZone);
  // 23:59 などの丸めのずれは、近い方の日付に寄せる。
  const rounded = converted.hour >= 12 ? converted.add({ days: 1 }) : converted;
  return rounded.toPlainDate().toString();
}

/**
 * 例外の originalStart (DateTimeOffset) を recurrenceId にする。終日は日付。
 * 推測: 終日の回の originalStart は、元のタイムゾーンの 0 時か UTC の 0 時のどちらか。
 * UTC の 0 時ならその日付、そうでなければ元のタイムゾーンでの日付にする。
 */
export function graphOriginalStartToRecurrenceId(
  originalStart: string,
  allDay: boolean,
  originalZone: string | null,
): string {
  if (!allDay) return normalizeRecurrenceId(originalStart);
  let instant: Temporal.Instant;
  try {
    instant = Temporal.Instant.from(
      /[zZ]|[+-]\d{2}:?\d{2}$/.test(originalStart)
        ? originalStart
        : `${originalStart}Z`,
    );
  } catch {
    return originalStart.slice(0, 10);
  }
  const utc = instant.toZonedDateTimeISO("UTC");
  if (utc.hour === 0 && utc.minute === 0) return utc.toPlainDate().toString();
  return instant
    .toZonedDateTimeISO(originalZone ?? "UTC")
    .toPlainDate()
    .toString();
}

// ---------------------------------------------------------------------------
// 繰り返し: patternedRecurrence ⇔ RRULE
// ---------------------------------------------------------------------------

const GRAPH_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const RRULE_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

function graphDayToRrule(day: string): string | null {
  const index = GRAPH_DAYS.indexOf(day.toLowerCase() as never);
  return index < 0 ? null : (RRULE_DAYS[index] ?? null);
}

function rruleDayToGraph(day: string): string | null {
  const index = RRULE_DAYS.indexOf(day.toUpperCase() as never);
  return index < 0 ? null : (GRAPH_DAYS[index] ?? null);
}

const INDEX_TO_POS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  last: -1,
};
const POS_TO_INDEX: Record<string, GraphRecurrencePattern["index"]> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "-1": "last",
};

function compactUtc(instant: Temporal.Instant): string {
  return isoInstant(instant).replace(/[-:]/g, "");
}

/**
 * Graph の patternedRecurrence を RRULE の値 ("FREQ=WEEKLY;BYDAY=MO" など、"RRULE:" 無し) にする。
 * 終わりの日 (range.endDate、その日を含む) は、時刻付きならその日の終わり (繰り返しのタイムゾーン)
 * の UTC、終日なら日付の UNTIL にする。表せなければ null。
 */
export function graphRecurrenceToRrule(
  recurrence: GraphPatternedRecurrence | null | undefined,
  options: { allDay: boolean; timeZone: string | null },
): string | null {
  if (!recurrence?.pattern) return null;
  const { pattern, range } = recurrence;
  const parts: string[] = [];
  const days = (pattern.daysOfWeek ?? [])
    .map(graphDayToRrule)
    .filter((day): day is string => day !== null);
  const interval =
    Number.isInteger(pattern.interval) && pattern.interval > 1
      ? pattern.interval
      : 1;
  const relative = () => {
    const pos = INDEX_TO_POS[pattern.index ?? "first"] ?? 1;
    if (days.length === 0) return false;
    if (days.length === 1) parts.push(`BYDAY=${pos}${days[0]}`);
    else parts.push(`BYDAY=${days.join(",")}`, `BYSETPOS=${pos}`);
    return true;
  };
  switch (pattern.type) {
    case "daily":
      parts.push("FREQ=DAILY");
      break;
    case "weekly":
      parts.push("FREQ=WEEKLY");
      if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
      break;
    case "absoluteMonthly":
      parts.push("FREQ=MONTHLY");
      if (pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
      break;
    case "relativeMonthly":
      parts.push("FREQ=MONTHLY");
      if (!relative()) return null;
      break;
    case "absoluteYearly":
      parts.push("FREQ=YEARLY");
      if (pattern.month) parts.push(`BYMONTH=${pattern.month}`);
      if (pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`);
      break;
    case "relativeYearly":
      parts.push("FREQ=YEARLY");
      if (pattern.month) parts.push(`BYMONTH=${pattern.month}`);
      if (!relative()) return null;
      break;
    default:
      return null;
  }
  if (interval > 1) parts.splice(1, 0, `INTERVAL=${interval}`);
  if (pattern.type === "weekly" && pattern.firstDayOfWeek) {
    const wkst = graphDayToRrule(pattern.firstDayOfWeek);
    if (wkst) parts.push(`WKST=${wkst}`);
  }
  if (range?.type === "numbered" && (range.numberOfOccurrences ?? 0) > 0) {
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  } else if (range?.type === "endDate" && range.endDate) {
    const end = range.endDate.slice(0, 10);
    if (options.allDay) {
      parts.push(`UNTIL=${end.replace(/-/g, "")}`);
    } else {
      const zone =
        graphTimeZoneToIana(range.recurrenceTimeZone) ??
        usableZone(options.timeZone) ??
        "Etc/UTC";
      const until = Temporal.PlainDate.from(end)
        .toZonedDateTime({
          timeZone: zone,
          plainTime: Temporal.PlainTime.from("23:59:59"),
        })
        .toInstant();
      parts.push(`UNTIL=${compactUtc(until)}`);
    }
  }
  return parts.join(";");
}

/** Graph の繰り返しで表せない規則のときの理由。 */
export class UnsupportedRecurrenceError extends Error {
  constructor(message = "Microsoft のカレンダーでは表せない繰り返しです。") {
    super(message);
    this.name = "UnsupportedRecurrenceError";
  }
}

function parseUntil(value: string, zone: string): string | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) return `${date[1]}-${date[2]}-${date[3]}`;
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!time) return null;
  const text = `${time[1]}-${time[2]}-${time[3]}T${time[4]}:${time[5]}:${time[6]}`;
  if (time[7] === "Z") {
    return Temporal.Instant.from(`${text}Z`)
      .toZonedDateTimeISO(zone)
      .toPlainDate()
      .toString();
  }
  return text.slice(0, 10);
}

/**
 * RRULE の値を Graph の patternedRecurrence にする。Graph の 6 種類の型で表せない規則
 * (BYSETPOS と単一の曜日の組み合わせ以外、複数の BYMONTHDAY / BYMONTH、BYHOUR、HOURLY など) は
 * UnsupportedRecurrenceError を投げる。
 * - startDate: 予定の開始日 (開始のタイムゾーンでの日付)
 * - timeZone: 開始のタイムゾーン (IANA 名)。UNTIL を日付にするのと recurrenceTimeZone に使う。
 */
export function rruleToGraphRecurrence(
  rrule: string,
  options: { startDate: string; timeZone: string | null },
): GraphPatternedRecurrence {
  const fields = new Map<string, string>();
  for (const part of rrule
    .replace(/^RRULE:/i, "")
    .trim()
    .split(";")) {
    if (!part) continue;
    const [key, value] = part.split("=");
    if (!key || value === undefined) throw new UnsupportedRecurrenceError();
    fields.set(key.toUpperCase(), value.toUpperCase());
  }
  const allowed = new Set([
    "FREQ",
    "INTERVAL",
    "COUNT",
    "UNTIL",
    "BYDAY",
    "BYMONTHDAY",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
  ]);
  for (const key of fields.keys()) {
    if (!allowed.has(key)) throw new UnsupportedRecurrenceError();
  }
  const start = Temporal.PlainDate.from(options.startDate);
  const startDay: string = GRAPH_DAYS[start.dayOfWeek - 1] ?? "monday";
  const interval = Number(fields.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) {
    throw new UnsupportedRecurrenceError();
  }
  const byDay = fields.get("BYDAY")?.split(",") ?? [];
  const byMonthDay = fields.get("BYMONTHDAY")?.split(",") ?? [];
  const byMonth = fields.get("BYMONTH")?.split(",") ?? [];
  const bySetPos = fields.get("BYSETPOS")?.split(",") ?? [];
  if (byMonthDay.length > 1 || byMonth.length > 1 || bySetPos.length > 1) {
    throw new UnsupportedRecurrenceError();
  }
  const plainDays = () => {
    const days = byDay.map((day) => {
      const graph = /^[A-Z]{2}$/.test(day) ? rruleDayToGraph(day) : null;
      if (!graph) throw new UnsupportedRecurrenceError();
      return graph;
    });
    return days;
  };
  const firstDayOfWeek = fields.has("WKST")
    ? (rruleDayToGraph(fields.get("WKST") ?? "") ?? "sunday")
    : "sunday";

  /** 月の中の位置で決まる規則 (第 2 月曜、最終金曜など)。表せなければ null。 */
  const relative = (): Pick<
    GraphRecurrencePattern,
    "daysOfWeek" | "index"
  > | null => {
    if (byDay.length === 0) return null;
    if (bySetPos.length === 1) {
      const index = POS_TO_INDEX[bySetPos[0] ?? ""];
      if (!index) throw new UnsupportedRecurrenceError();
      return { daysOfWeek: plainDays(), index };
    }
    let position: string | null = null;
    const days = byDay.map((day) => {
      const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(day);
      const graph = match ? rruleDayToGraph(match[2] ?? "") : null;
      if (!match || !graph) throw new UnsupportedRecurrenceError();
      const pos = (match[1] ?? "").replace(/^\+/, "");
      if (position !== null && pos !== position) {
        throw new UnsupportedRecurrenceError();
      }
      position = pos;
      return graph;
    });
    if (!position) throw new UnsupportedRecurrenceError();
    const index = POS_TO_INDEX[position];
    if (!index) throw new UnsupportedRecurrenceError();
    return { daysOfWeek: days, index };
  };
  const dayOfMonth = () => {
    const value = Number(byMonthDay[0] ?? start.day);
    if (!Number.isInteger(value) || value < 1 || value > 31) {
      throw new UnsupportedRecurrenceError();
    }
    return value;
  };

  let pattern: GraphRecurrencePattern;
  switch (fields.get("FREQ")) {
    case "DAILY":
      if (byMonthDay.length > 0 || byMonth.length > 0 || bySetPos.length > 0) {
        throw new UnsupportedRecurrenceError();
      }
      // 平日だけの毎日 (FREQ=DAILY;BYDAY=MO,...,FR) は、毎週の曜日指定にする。
      pattern =
        byDay.length > 0
          ? interval === 1
            ? {
                type: "weekly",
                interval: 1,
                daysOfWeek: plainDays(),
                firstDayOfWeek,
              }
            : (() => {
                throw new UnsupportedRecurrenceError();
              })()
          : { type: "daily", interval };
      break;
    case "WEEKLY":
      if (byMonthDay.length > 0 || byMonth.length > 0 || bySetPos.length > 0) {
        throw new UnsupportedRecurrenceError();
      }
      pattern = {
        type: "weekly",
        interval,
        daysOfWeek: byDay.length > 0 ? plainDays() : [startDay],
        firstDayOfWeek,
      };
      break;
    case "MONTHLY": {
      if (byMonth.length > 0) throw new UnsupportedRecurrenceError();
      if (byDay.length > 0) {
        if (byMonthDay.length > 0) throw new UnsupportedRecurrenceError();
        const rel = relative();
        if (!rel) throw new UnsupportedRecurrenceError();
        pattern = { type: "relativeMonthly", interval, ...rel };
      } else {
        if (bySetPos.length > 0) throw new UnsupportedRecurrenceError();
        pattern = {
          type: "absoluteMonthly",
          interval,
          dayOfMonth: dayOfMonth(),
        };
      }
      break;
    }
    case "YEARLY": {
      const month = Number(byMonth[0] ?? start.month);
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new UnsupportedRecurrenceError();
      }
      if (byDay.length > 0) {
        if (byMonthDay.length > 0) throw new UnsupportedRecurrenceError();
        const rel = relative();
        if (!rel) throw new UnsupportedRecurrenceError();
        pattern = { type: "relativeYearly", interval, month, ...rel };
      } else {
        if (bySetPos.length > 0) throw new UnsupportedRecurrenceError();
        pattern = {
          type: "absoluteYearly",
          interval,
          month,
          dayOfMonth: dayOfMonth(),
        };
      }
      break;
    }
    default:
      throw new UnsupportedRecurrenceError();
  }

  const zone = usableZone(options.timeZone) ?? "Etc/UTC";
  const range: GraphRecurrenceRange = {
    type: "noEnd",
    startDate: start.toString(),
    recurrenceTimeZone: ianaToGraphTimeZone(zone),
  };
  const count = fields.get("COUNT");
  const until = fields.get("UNTIL");
  if (count !== undefined && until !== undefined) {
    throw new UnsupportedRecurrenceError();
  }
  if (count !== undefined) {
    const value = Number(count);
    if (!Number.isInteger(value) || value < 1) {
      throw new UnsupportedRecurrenceError();
    }
    range.type = "numbered";
    range.numberOfOccurrences = value;
  } else if (until !== undefined) {
    const endDate = parseUntil(until, zone);
    if (!endDate) throw new UnsupportedRecurrenceError();
    range.type = "endDate";
    range.endDate = endDate;
  }
  return { pattern, range };
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/** Graph の予定 1 件を読んだもの。worker の RemoteEvent と同じ形 (uid は例外で null)。 */
export type MicrosoftParsedEvent = Omit<ParsedEvent, "uid" | "attendees"> & {
  uid: string | null;
  remoteId: string;
  etag: string | null;
  parentRemoteId: string | null;
  attendees: (ParsedAttendee & { self?: boolean })[];
  /** Graph の type (singleInstance / occurrence / exception / seriesMaster)。 */
  graphType: string;
};

const ATTENDEE_STATUS: Record<string, ParsedAttendee["status"]> = {
  accepted: "accepted",
  organizer: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
  none: "needs_action",
  notResponded: "needs_action",
};

/**
 * cancelledOccurrences の値 ("OID.{seriesMasterId}.2026-12-08" の形) から日付を取り出す。
 * 推測: 日付は原本のタイムゾーンでの回の日付。
 */
function cancelledOccurrenceDate(value: string): string | null {
  return /(\d{4}-\d{2}-\d{2})$/.exec(value)?.[1] ?? null;
}

/** 原本の取り消された回を exdates (recurrenceId の書き方) にする。 */
function cancelledToExdates(
  event: GraphEvent,
  allDay: boolean,
  startZone: string | null,
): string[] | null {
  const list = event.cancelledOccurrences;
  if (!Array.isArray(list) || list.length === 0) return null;
  const result: string[] = [];
  let time: Temporal.PlainTime | null = null;
  if (!allDay && event.start?.dateTime) {
    const zoned = toInstant(event.start).toZonedDateTimeISO(
      startZone ?? "Etc/UTC",
    );
    time = zoned.toPlainTime();
  }
  for (const value of list) {
    const date =
      typeof value === "string" ? cancelledOccurrenceDate(value) : null;
    if (!date) continue;
    if (allDay || !time) {
      result.push(date);
    } else {
      const instant = Temporal.PlainDate.from(date)
        .toZonedDateTime({ timeZone: startZone ?? "Etc/UTC", plainTime: time })
        .toInstant();
      result.push(instantRecurrenceId(instant));
    }
  }
  return result.length > 0 ? [...new Set(result)].sort() : null;
}

/**
 * Graph の予定の JSON を、予定 1 行分にする。
 * - 例外 (type=exception) は uid を null にする (iCalUId が回ごとに違うことがあるので、
 *   土台に原本の uid を補わせる)。parentRemoteId は seriesMasterId。
 * - 原本は patternedRecurrence を RRULE に、cancelledOccurrences を exdates にする。
 * - 本文は Prefer: outlook.body-content-type="text" で取る前提で、そのまま説明にする。
 * - raw には JSON をそのまま入れる。
 * id が無ければ null。
 */
export function parseGraphEvent(
  event: GraphEvent,
  options: { selfEmail?: string | null; raw?: string } = {},
): MicrosoftParsedEvent | null {
  if (!event.id) return null;
  const type = event.type ?? "singleInstance";
  const allDay = event.isAllDay === true;
  const startZone =
    graphTimeZoneToIana(event.originalStartTimeZone) ??
    graphTimeZoneToIana(event.start?.timeZone);
  const endZone =
    graphTimeZoneToIana(event.originalEndTimeZone) ??
    graphTimeZoneToIana(event.end?.timeZone) ??
    startZone;

  let startAt: string | null = null;
  let endAt: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (allDay) {
    if (event.start?.dateTime) startDate = allDayDate(event.start, startZone);
    if (event.end?.dateTime) endDate = allDayDate(event.end, endZone);
  } else {
    if (event.start?.dateTime) startAt = isoInstant(toInstant(event.start));
    if (event.end?.dateTime) endAt = isoInstant(toInstant(event.end));
  }

  const exception = type === "exception" || type === "occurrence";
  const recurrenceId =
    exception && event.originalStart
      ? graphOriginalStartToRecurrenceId(event.originalStart, allDay, startZone)
      : null;
  const master = type === "seriesMaster";
  const selfEmail = options.selfEmail?.toLowerCase() ?? null;
  const showAs = event.showAs ?? "busy";

  const attendees: MicrosoftParsedEvent["attendees"] = [];
  for (const attendee of event.attendees ?? []) {
    const email = attendee.emailAddress?.address?.trim();
    if (!email) continue;
    const role: ParsedAttendee["role"] =
      attendee.type === "optional"
        ? "optional"
        : attendee.type === "resource"
          ? "non_participant"
          : "required";
    attendees.push({
      email,
      name: attendee.emailAddress?.name || null,
      role,
      status:
        ATTENDEE_STATUS[attendee.status?.response ?? "none"] ?? "needs_action",
      ...(selfEmail !== null && email.toLowerCase() === selfEmail
        ? { self: true }
        : {}),
    });
  }
  const organizerEmail = event.organizer?.emailAddress?.address?.trim();

  return {
    uid: exception ? null : (event.iCalUId ?? event.id),
    recurrenceId,
    remoteId: event.id,
    etag: event["@odata.etag"] ?? event.changeKey ?? null,
    parentRemoteId: exception ? (event.seriesMasterId ?? null) : null,
    graphType: type,
    summary: event.subject || null,
    location: event.location?.displayName || null,
    description: event.body?.content || null,
    status: event.isCancelled
      ? "cancelled"
      : showAs === "tentative"
        ? "tentative"
        : "confirmed",
    busy: showAs !== "free" && showAs !== "workingElsewhere",
    allDay,
    startAt,
    endAt,
    startDate,
    endDate,
    startTimeZone: allDay ? null : startZone,
    endTimeZone: allDay ? null : endZone,
    rrule: master
      ? graphRecurrenceToRrule(event.recurrence, {
          allDay,
          timeZone: startZone,
        })
      : null,
    rdates: null,
    exdates: master ? cancelledToExdates(event, allDay, startZone) : null,
    organizer: organizerEmail
      ? {
          email: organizerEmail,
          ...(event.organizer?.emailAddress?.name
            ? { name: event.organizer.emailAddress.name }
            : {}),
        }
      : null,
    attendees,
    sequence: 0,
    conferenceUrl:
      event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || null,
    remoteUpdatedAt: event.lastModifiedDateTime
      ? normalizeRecurrenceId(event.lastModifiedDateTime)
      : null,
    // Graph には「カレンダーの既定」が無いので、予定ごとのリマインダーとして持つ。
    reminders:
      event.isReminderOn === false
        ? []
        : [
            {
              method: "display",
              minutes: Math.max(0, event.reminderMinutesBeforeStart ?? 15),
            },
          ],
    raw: options.raw ?? JSON.stringify(event),
  };
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

/** 書き込む予定の列 (DB の events の行と同じ名前)。 */
export type MicrosoftEventWriteInput = {
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
  rdates: string[] | null;
  useDefaultReminders: boolean;
  reminders: { method: string; minutes: number }[];
  attendees: {
    email: string;
    name: string | null;
    role: string;
  }[];
};

function instantOf(value: Date | string): Temporal.Instant {
  return Temporal.Instant.from(
    typeof value === "string" ? value : value.toISOString(),
  );
}

function graphTime(
  value: Date | string,
  zone: string | null,
): GraphDateTimeTimeZone {
  const iana = usableZone(zone) ?? "Etc/UTC";
  const local = instantOf(value)
    .toZonedDateTimeISO(iana)
    .toPlainDateTime()
    .toString({ smallestUnit: "second" });
  return { dateTime: local, timeZone: ianaToGraphTimeZone(iana) };
}

/**
 * 予定の列から、Graph に送る本文を作る。fields に入っている項目だけを入れる
 * (PATCH は送った項目だけを変えるので、Orbit が知らない項目は消えない)。
 * - raw: 前回の相手側の JSON (showAs や終日のタイムゾーンを引き継ぐのに使う)
 * - fallbackTimeZone: 予定にタイムゾーンが無いときに使う (カレンダーのタイムゾーン)
 * - master: 繰り返しの原本 (recurrence を送る)。例外では recurrence を送らない。
 * 表せない繰り返しは UnsupportedRecurrenceError を投げる。
 */
export function graphEventBody(
  input: MicrosoftEventWriteInput,
  fields: readonly string[],
  options: {
    raw: GraphEvent | null;
    fallbackTimeZone: string | null;
    exception: boolean;
  },
): Record<string, unknown> {
  const has = (name: string) => fields.includes(name);
  const body: Record<string, unknown> = {};
  const raw = options.raw;
  if (has("summary")) body.subject = input.summary ?? "";
  if (has("location")) body.location = { displayName: input.location ?? "" };
  if (has("description")) {
    body.body = { contentType: "text", content: input.description ?? "" };
  }
  if (has("busy") || has("status")) {
    const previous = raw?.showAs;
    body.showAs = !input.busy
      ? "free"
      : input.status === "tentative"
        ? "tentative"
        : previous === "oof"
          ? "oof"
          : "busy";
  }
  const zone =
    usableZone(input.startTimeZone) ?? usableZone(options.fallbackTimeZone);
  if (has("time")) {
    if (input.allDay) {
      if (!input.startDate || !input.endDate) {
        throw new Error("終日の予定に日付がありません。");
      }
      const allDayZone =
        raw?.isAllDay && raw.start?.timeZone
          ? raw.start.timeZone
          : ianaToGraphTimeZone(usableZone(options.fallbackTimeZone));
      body.isAllDay = true;
      body.start = {
        dateTime: `${input.startDate}T00:00:00`,
        timeZone: allDayZone,
      };
      body.end = {
        dateTime: `${input.endDate}T00:00:00`,
        timeZone: allDayZone,
      };
    } else {
      if (!input.startAt || !input.endAt) {
        throw new Error("予定に開始と終了の時刻がありません。");
      }
      body.isAllDay = false;
      body.start = graphTime(input.startAt, zone);
      body.end = graphTime(input.endAt, usableZone(input.endTimeZone) ?? zone);
    }
  }
  if (!options.exception && (has("recurrence") || has("time"))) {
    if (input.rdates && input.rdates.length > 0) {
      throw new UnsupportedRecurrenceError(
        "Microsoft のカレンダーでは、追加の回 (RDATE) を表せません。",
      );
    }
    if (input.rrule) {
      const startDate = input.allDay
        ? input.startDate
        : input.startAt
          ? instantOf(input.startAt)
              .toZonedDateTimeISO(zone ?? "Etc/UTC")
              .toPlainDate()
              .toString()
          : null;
      if (!startDate) throw new UnsupportedRecurrenceError();
      body.recurrence = rruleToGraphRecurrence(input.rrule, {
        startDate,
        timeZone: zone,
      });
    } else if (has("recurrence")) {
      body.recurrence = null;
    }
  }
  if (has("reminders") || has("useDefaultReminders")) {
    if (input.useDefaultReminders) {
      // Graph には既定のリマインダーが無い。オンにだけして、時間は相手側に任せる。
      body.isReminderOn = true;
    } else if (input.reminders.length === 0) {
      body.isReminderOn = false;
    } else {
      body.isReminderOn = true;
      body.reminderMinutesBeforeStart = Math.min(
        ...input.reminders.map((reminder) => reminder.minutes),
      );
    }
  }
  if (has("attendees")) {
    body.attendees = input.attendees.map((attendee) => ({
      emailAddress: {
        address: attendee.email,
        ...(attendee.name ? { name: attendee.name } : {}),
      },
      type: graphAttendeeType(attendee.role),
    }));
  }
  return body;
}

/** 参加者の役割を Graph の type にする。会議室など (non_participant) は resource。 */
function graphAttendeeType(role: string) {
  if (role === "optional") return "optional";
  if (role === "non_participant") return "resource";
  return "required";
}

// ---------------------------------------------------------------------------
// 変更通知 (subscription)
// ---------------------------------------------------------------------------

/** カレンダーの変更通知の受け口のパス (/v1 より後ろ)。メールの /webhooks/microsoft とは分ける。 */
export const MICROSOFT_CALENDAR_WEBHOOK_PATH = "/webhooks/microsoft-calendar";

/**
 * カレンダーの変更通知の URL。webhookBaseUrl は、メールの受け口の URL (…/v1/webhooks/microsoft)
 * か、/v1 までの URL のどちらでもよい。
 */
export function microsoftCalendarWebhookUrl(
  webhookBaseUrl: string,
  accountId: string,
  calendarId: string,
): string {
  let base = webhookBaseUrl.replace(/\/+$/, "");
  if (base.endsWith(MICROSOFT_CALENDAR_WEBHOOK_PATH)) {
    base = base.slice(0, -MICROSOFT_CALENDAR_WEBHOOK_PATH.length);
  } else if (base.endsWith(GRAPH_WEBHOOK_PATH)) {
    base = base.slice(0, -GRAPH_WEBHOOK_PATH.length);
  }
  return `${base}${MICROSOFT_CALENDAR_WEBHOOK_PATH}?account=${encodeURIComponent(accountId)}&calendar=${encodeURIComponent(calendarId)}`;
}

/**
 * カレンダーの購読に付ける合言葉 (clientState)。graphClientState と同じ方式 (鍵の HMAC) で、
 * 文脈の文字列を変えてある (メールの購読の合言葉とは一致しない)。保存は不要。
 */
export function microsoftCalendarClientState(
  key: Buffer,
  accountId: string,
  calendarId: string,
): string {
  return createHmac("sha256", key)
    .update(`graph-calendar-webhook:${accountId}:${calendarId}`)
    .digest("hex");
}

export function verifyMicrosoftCalendarClientState(
  key: Buffer,
  accountId: string,
  calendarId: string,
  clientState: unknown,
): boolean {
  if (typeof clientState !== "string") return false;
  const expected = Buffer.from(
    microsoftCalendarClientState(key, accountId, calendarId),
  );
  const actual = Buffer.from(clientState);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
