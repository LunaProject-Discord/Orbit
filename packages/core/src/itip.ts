import { Temporal } from "temporal-polyfill";
import {
  basicDate,
  type Component,
  escapeICalText,
  ICAL_PRODID,
  isIanaZone,
  type Line,
  line,
  PARTSTAT_VALUES,
  ROLE_VALUES,
  recurrenceValue,
  serialize,
  type TimeForm,
  timeLine,
  toInstant,
  utcStamp,
  vtimezoneComponent,
} from "./icalendar-lines.js";
import type { ICalEventData } from "./icalendar-write.js";
import { normalizeRecurrenceId } from "./recurrence.js";

/**
 * iTIP (RFC 5546) のメッセージの書き出し。Orbit が送る招待メール (iMIP、RFC 6047) の本体。
 * CalDAV の書き戻し (writeICalendar) と違い、既存のリソースを基にせず、送ってよい項目だけを書く
 * (VALARM、X- や未知のプロパティ、events.raw は書かない)。設計は imip-design.md の 5.1。
 * 依存は Temporal だけ (Node 専用の API を使わない)。
 */

/** 8b で扱う iTIP の METHOD。 */
export type ItipMethod = "REQUEST" | "CANCEL" | "REPLY";

export type BuildItipInput = {
  method: ItipMethod;
  /** 原本と、同じ UID の例外。REPLY と 1 回だけの REQUEST / CANCEL は 1 件。 */
  events: readonly ICalEventData[];
  /**
   * VEVENT に書く ATTENDEE を絞る (REPLY は自分だけ、参加者を外す CANCEL は外した人だけ)。
   * 省けば全員。予定の参加者にいないアドレス (外した人) も書く。
   */
  attendees?: readonly string[];
  /** REPLY のコメント。 */
  comment?: string | null;
  /** 積んだ時刻。やり直しても同じ値を使う。 */
  dtstamp: Date;
  /** 浮動時刻と、日付だけの回を読むときのタイムゾーン。 */
  defaultTimeZone: string;
};

type Attendee = ICalEventData["attendees"][number];

const lower = (email: string) => email.trim().toLowerCase();

/** 予定の DTSTART の形 (RECURRENCE-ID / RDATE / EXDATE をこれに合わせる)。 */
function formOf(event: ICalEventData): TimeForm {
  if (event.allDay) return { kind: "date" };
  return isIanaZone(event.startTimeZone)
    ? { kind: "zone", zone: event.startTimeZone }
    : { kind: "utc" };
}

function timeLines(
  event: ICalEventData,
  zones: Set<string>,
  withEnd: boolean,
): Line[] {
  if (event.allDay) {
    if (!event.startDate) return [];
    const end =
      event.endDate && event.endDate > event.startDate
        ? event.endDate
        : Temporal.PlainDate.from(event.startDate).add({ days: 1 }).toString();
    return [
      line("DTSTART", basicDate(event.startDate), [["VALUE", "DATE"]]),
      ...(withEnd ? [line("DTEND", basicDate(end), [["VALUE", "DATE"]])] : []),
    ];
  }
  if (event.startAt === null) return [];
  const start = toInstant(event.startAt);
  let end = event.endAt === null ? start : toInstant(event.endAt);
  if (Temporal.Instant.compare(end, start) < 0) end = start;
  return [
    timeLine("DTSTART", start, event.startTimeZone, zones),
    ...(withEnd
      ? [
          timeLine(
            "DTEND",
            end,
            event.endTimeZone ?? event.startTimeZone,
            zones,
          ),
        ]
      : []),
  ];
}

function personParams(name: string | null | undefined): [string, string][] {
  // CN は 1 行に収める (改行や制御文字はパラメータに書けない)。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を除くため。
  const cleaned = name?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned ? [["CN", cleaned]] : [];
}

function attendeeLine(
  method: ItipMethod,
  attendee: Attendee,
  organizerEmail: string | null,
): Line {
  const params = personParams(attendee.name);
  if (method !== "REPLY") params.push(["ROLE", ROLE_VALUES[attendee.role]]);
  if (method !== "CANCEL") {
    params.push(["PARTSTAT", PARTSTAT_VALUES[attendee.status]]);
  }
  if (
    method === "REQUEST" &&
    attendee.status === "needs_action" &&
    lower(attendee.email) !== organizerEmail
  ) {
    params.push(["RSVP", "TRUE"]);
  }
  return line("ATTENDEE", `mailto:${attendee.email.trim()}`, params);
}

/** VEVENT に書く参加者。filter があれば、その順に (予定にいない人は既定の値で) 書く。 */
function attendeesFor(
  event: ICalEventData,
  filter: readonly string[] | undefined,
): Attendee[] {
  if (!filter) return [...event.attendees];
  const byEmail = new Map(
    event.attendees.map((attendee) => [lower(attendee.email), attendee]),
  );
  const seen = new Set<string>();
  const result: Attendee[] = [];
  for (const email of filter) {
    const key = lower(email);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(
      byEmail.get(key) ?? {
        email: email.trim(),
        name: null,
        role: "required",
        status: "needs_action",
      },
    );
  }
  return result;
}

function vevent(
  event: ICalEventData,
  input: BuildItipInput,
  context: {
    zones: Set<string>;
    /** RECURRENCE-ID の形 (原本の DTSTART の形)。 */
    recurrenceForm: TimeForm;
    /** 原本に足す EXDATE (REQUEST で、取り消した例外の回)。 */
    extraExdates: readonly string[];
  },
): Component {
  const { method } = input;
  const { zones } = context;
  const props: Line[] = [line("UID", event.uid)];
  if (event.recurrenceId !== null) {
    const written = recurrenceValue(
      event.recurrenceId,
      context.recurrenceForm,
      input.defaultTimeZone,
      zones,
    );
    props.push(line("RECURRENCE-ID", written.value, written.params));
  }
  props.push(line("DTSTAMP", utcStamp(toInstant(input.dtstamp))));
  // 全体の取り消しは SEQUENCE を上げる (RFC 5546 の 2.1.4)。REPLY は受け取った値のまま。
  const wholeCancel =
    method === "CANCEL" &&
    event.recurrenceId === null &&
    input.attendees === undefined;
  props.push(line("SEQUENCE", String(event.sequence + (wholeCancel ? 1 : 0))));
  const organizerEmail = event.organizer ? lower(event.organizer.email) : null;
  if (event.organizer) {
    props.push(
      line(
        "ORGANIZER",
        `mailto:${event.organizer.email.trim()}`,
        personParams(event.organizer.name),
      ),
    );
  }
  for (const attendee of attendeesFor(event, input.attendees)) {
    props.push(attendeeLine(method, attendee, organizerEmail));
  }
  props.push(...timeLines(event, zones, method !== "CANCEL"));
  if (method === "REQUEST" && event.recurrenceId === null) {
    const form = formOf(event);
    const rule = event.rrule?.trim().replace(/^RRULE:/i, "");
    if (rule) props.push(line("RRULE", rule));
    const dates = (name: string, values: readonly string[]) => {
      for (const value of new Set(values.map(normalizeRecurrenceId))) {
        const written = recurrenceValue(
          value,
          form,
          input.defaultTimeZone,
          zones,
        );
        props.push(line(name, written.value, written.params));
      }
    };
    dates("RDATE", event.rdates ?? []);
    dates("EXDATE", [...(event.exdates ?? []), ...context.extraExdates]);
  }
  if (event.summary) props.push(line("SUMMARY", escapeICalText(event.summary)));
  if (method === "REQUEST") {
    if (event.location) {
      props.push(line("LOCATION", escapeICalText(event.location)));
    }
    if (event.description) {
      props.push(line("DESCRIPTION", escapeICalText(event.description)));
    }
    if (event.conferenceUrl) {
      // 読み取り (parseICalendar) と CalDAV の書き戻しと同じ名前で書く。
      props.push(line("X-GOOGLE-CONFERENCE", event.conferenceUrl));
    }
    props.push(line("STATUS", "CONFIRMED"));
    props.push(line("TRANSP", event.busy ? "OPAQUE" : "TRANSPARENT"));
  } else if (method === "CANCEL") {
    props.push(line("STATUS", "CANCELLED"));
  } else if (input.comment && input.comment.trim().length > 0) {
    props.push(line("COMMENT", escapeICalText(input.comment.trim())));
  }
  return { name: "VEVENT", props, children: [] };
}

/** iTIP のメッセージ (METHOD 付きの VCALENDAR、CRLF 区切り) を作る。 */
export function buildItip(input: BuildItipInput): string {
  if (input.events.length === 0) {
    throw new Error("buildItip: 予定がありません。");
  }
  if (Number.isNaN(input.dtstamp.getTime())) {
    throw new Error("buildItip: dtstamp が日時ではありません。");
  }
  const master = input.events.find((event) => event.recurrenceId === null);
  let targets: readonly ICalEventData[] = input.events;
  const extraExdates: string[] = [];
  if (input.method === "CANCEL" && master) {
    // 全体の取り消し・参加者を外すときは、原本だけで足りる (UID で全部の回を指す)。
    targets = [master];
  } else if (input.method === "REQUEST" && master) {
    // 取り消した例外の回は VEVENT にせず、原本の EXDATE に入れる。
    targets = input.events.filter((event) => {
      if (event === master || event.status !== "cancelled") return true;
      if (event.recurrenceId !== null) extraExdates.push(event.recurrenceId);
      return false;
    });
  }
  const zones = new Set<string>();
  const vevents = targets.map((event) =>
    vevent(event, input, {
      zones,
      recurrenceForm: formOf(master ?? event),
      extraExdates: event === master ? extraExdates : [],
    }),
  );
  const reference =
    targets[0]?.startAt ?? targets[0]?.startDate ?? input.dtstamp;
  const around =
    typeof reference === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reference)
      ? new Date(`${reference}T00:00:00Z`)
      : new Date(toInstant(reference).epochMilliseconds);
  const calendar: Component = {
    name: "VCALENDAR",
    props: [
      line("PRODID", ICAL_PRODID),
      line("VERSION", "2.0"),
      line("CALSCALE", "GREGORIAN"),
      line("METHOD", input.method),
    ],
    children: [
      ...[...zones].sort().map((zone) => vtimezoneComponent(zone, around)),
      ...vevents,
    ],
  };
  const out: string[] = [];
  serialize(calendar, out);
  return `${out.join("\r\n")}\r\n`;
}
