import { RRuleTemporal } from "rrule-temporal";
import { Temporal } from "temporal-polyfill";

/**
 * 予定の繰り返しを、表示と通知のための個々の回に展開する。
 *
 * 回を表す recurrenceId (iCalendar の RECURRENCE-ID にあたる値) の書き方:
 * - 時刻のある予定: 元の回の開始の UTC (Temporal.Instant の文字列。例 "2026-10-26T13:00:00Z")
 * - 終日の予定: 元の回の日付 ("2026-10-26")
 * RDATE と EXDATE (events.rdates / exdates) も同じ書き方で持つ。
 */

/** 予定の時刻。時刻付きは UTC とタイムゾーン、終日は日付 (終わりの日は含まない)。 */
export type EventTiming =
  | {
      allDay: false;
      /** 開始と終了 (ISO 8601。UTC でなくてもよい)。 */
      startAt: string;
      endAt: string;
      /** 開始のタイムゾーン (IANA 名)。null は浮動時刻で、展開には既定のタイムゾーンを使う。 */
      startTimeZone: string | null;
    }
  | {
      allDay: true;
      /** YYYY-MM-DD。endDate はその日を含まない。 */
      startDate: string;
      endDate: string;
    };

/** 展開する予定 (繰り返しの原本、または繰り返さない予定)。 */
export type RecurringEvent = EventTiming & {
  /** RRULE の値 ("FREQ=WEEKLY;BYDAY=MO" など。先頭の "RRULE:" は付いていてもよい)。 */
  rrule: string | null;
  rdates?: readonly string[] | null;
  exdates?: readonly string[] | null;
};

/** その回だけ変えた例外。 */
export type RecurrenceException<K> = EventTiming & {
  key: K;
  recurrenceId: string;
  /** その回を取り消した (STATUS:CANCELLED、Google の cancelled)。 */
  cancelled: boolean;
};

/** 展開した回。 */
export type Occurrence<K> = {
  /** 例外の回なら例外の key、そうでなければ null (原本の中身を使う)。 */
  exception: K | null;
  /** 繰り返しの回なら元の回の開始、繰り返さない予定なら null。 */
  recurrenceId: string | null;
} & (
  | { allDay: false; startAt: string; endAt: string }
  | { allDay: true; startDate: string; endDate: string }
);

/** 展開する範囲。from の日の 0 時から to の日の 0 時まで (timeZone での日付)。 */
export type OccurrenceRange = {
  from: string;
  to: string;
  timeZone: string;
};

export type ExpandOptions = {
  /** 浮動時刻 (タイムゾーン無し) の予定を展開するときのタイムゾーン。 */
  defaultTimeZone: string;
  /** 1 つの予定から作る回の上限。既定 5000。 */
  limit?: number;
};

const DEFAULT_LIMIT = 5000;

function normalizeRule(rrule: string): string {
  return rrule.replace(/^RRULE:/i, "").trim();
}

/** 時刻付きの回の recurrenceId。 */
export function instantRecurrenceId(value: string | Temporal.Instant): string {
  const instant =
    typeof value === "string" ? Temporal.Instant.from(value) : value;
  return instant.toString({ smallestUnit: "second" });
}

/**
 * recurrenceId を比べられる形にそろえる。時刻付きは UTC の秒まで、終日は日付。
 * プロバイダごとに書き方 (オフセット付き、ミリ秒付き) が違っても同じ回は同じ値になる。
 */
export function normalizeRecurrenceId(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  try {
    return instantRecurrenceId(value);
  } catch {
    return value;
  }
}

function rangeInstants(range: OccurrenceRange) {
  const from = Temporal.PlainDate.from(range.from)
    .toZonedDateTime(range.timeZone)
    .toInstant();
  const to = Temporal.PlainDate.from(range.to)
    .toZonedDateTime(range.timeZone)
    .toInstant();
  return { from, to };
}

/**
 * 予定を範囲内の回に展開する。範囲と重なる回 (始まりが範囲の終わりより前で、
 * 終わりが範囲の始まりより後) を、開始の早い順に返す。
 * 範囲の外の回を範囲の中へ動かした例外も含める。
 */
export function expandOccurrences<K>(
  event: RecurringEvent,
  exceptions: readonly RecurrenceException<K>[],
  range: OccurrenceRange,
  options: ExpandOptions,
): Occurrence<K>[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const window = rangeInstants(range);
  const byId = new Map<string, RecurrenceException<K>>();
  for (const exception of exceptions) {
    byId.set(normalizeRecurrenceId(exception.recurrenceId), exception);
  }
  const used = new Set<string>();
  const result: Occurrence<K>[] = [];

  const push = (
    recurrenceId: string | null,
    timing: EventTiming,
    exception: K | null,
  ) => {
    if (!overlaps(timing, window, range.timeZone)) return;
    result.push(
      timing.allDay
        ? {
            exception,
            recurrenceId,
            allDay: true,
            startDate: timing.startDate,
            endDate: timing.endDate,
          }
        : {
            exception,
            recurrenceId,
            allDay: false,
            startAt: instantRecurrenceId(timing.startAt),
            endAt: instantRecurrenceId(timing.endAt),
          },
    );
  };

  if (!event.rrule && !(event.rdates && event.rdates.length > 0)) {
    push(null, event, null);
  } else {
    const starts = recurrenceStarts(event, window, options, limit);
    const excluded = new Set((event.exdates ?? []).map(normalizeRecurrenceId));
    for (const recurrenceId of starts) {
      if (excluded.has(recurrenceId)) continue;
      const exception = byId.get(recurrenceId);
      if (exception) {
        used.add(recurrenceId);
        if (!exception.cancelled) push(recurrenceId, exception, exception.key);
        continue;
      }
      push(recurrenceId, shiftTiming(event, recurrenceId), null);
    }
  }

  // 元の回が範囲の外 (または規則から外れた回) でも、動かした先が範囲に入る例外は出す。
  for (const [recurrenceId, exception] of byId) {
    if (used.has(recurrenceId) || exception.cancelled) continue;
    push(recurrenceId, exception, exception.key);
  }

  result.sort(
    (a, b) => sortKey(a, range.timeZone) - sortKey(b, range.timeZone),
  );
  return result.slice(0, limit);
}

/** 範囲 (と、範囲の前に始まって範囲にかかる回) の元の開始を、recurrenceId の形で返す。 */
function recurrenceStarts(
  event: RecurringEvent,
  window: { from: Temporal.Instant; to: Temporal.Instant },
  options: ExpandOptions,
  limit: number,
): string[] {
  const timeZone = event.allDay
    ? "UTC"
    : (event.startTimeZone ?? options.defaultTimeZone);
  const dtstart = event.allDay
    ? Temporal.PlainDate.from(event.startDate).toZonedDateTime("UTC")
    : Temporal.Instant.from(event.startAt).toZonedDateTimeISO(timeZone);
  const span = durationOf(event);
  // 終日の回は日付で比べるので、どのタイムゾーンで見ても範囲にかかるよう 1 日ずつ広げる。
  const margin = event.allDay ? { hours: 24 } : { hours: 0 };
  const after = window.from.subtract(span).subtract(margin);
  const before = window.to.add(margin);

  const starts: Temporal.ZonedDateTime[] = [];
  if (event.rrule) {
    try {
      const rule = new RRuleTemporal({
        temporal: Temporal,
        rruleString: normalizeRule(event.rrule),
        dtstart,
        tzid: timeZone,
        allDay: event.allDay,
      });
      const iterator = (date: Temporal.ZonedDateTime) => {
        if (Temporal.Instant.compare(date.toInstant(), before) >= 0)
          return false;
        if (Temporal.Instant.compare(date.toInstant(), after) > 0)
          starts.push(date);
        return starts.length < limit;
      };
      rule.all(iterator);
    } catch {
      // 読めない規則は、最初の回だけを出す (予定そのものが消えて見えないように)。
      starts.push(dtstart);
    }
  } else {
    starts.push(dtstart);
  }
  const ids = starts.map((date) =>
    event.allDay
      ? date.toPlainDate().toString()
      : instantRecurrenceId(date.toInstant()),
  );
  for (const rdate of event.rdates ?? []) {
    const id = normalizeRecurrenceId(rdate);
    if (event.allDay !== /^\d{4}-\d{2}-\d{2}$/.test(id)) continue;
    const start = event.allDay
      ? Temporal.PlainDate.from(id).toZonedDateTime("UTC").toInstant()
      : Temporal.Instant.from(id);
    if (
      Temporal.Instant.compare(start, after) > 0 &&
      Temporal.Instant.compare(start, before) < 0
    )
      ids.push(id);
  }
  return [...new Set(ids)];
}

/** 予定の長さ。時刻付きは実際の経過時間、終日は日数。 */
function durationOf(event: EventTiming): Temporal.Duration {
  if (event.allDay) {
    const days = Temporal.PlainDate.from(event.startDate).until(
      Temporal.PlainDate.from(event.endDate),
      { largestUnit: "days" },
    ).days;
    return Temporal.Duration.from({ hours: Math.max(days, 0) * 24 });
  }
  const start = Temporal.Instant.from(event.startAt);
  const end = Temporal.Instant.from(event.endAt);
  return Temporal.Instant.compare(end, start) > 0
    ? start.until(end, { largestUnit: "hours" })
    : Temporal.Duration.from({ hours: 0 });
}

/** 原本の時刻を、指定した回の開始へずらす (長さはそのまま)。 */
function shiftTiming(event: EventTiming, recurrenceId: string): EventTiming {
  if (event.allDay) {
    const days = Temporal.PlainDate.from(event.startDate).until(
      Temporal.PlainDate.from(event.endDate),
      { largestUnit: "days" },
    ).days;
    const start = Temporal.PlainDate.from(recurrenceId);
    return {
      allDay: true,
      startDate: start.toString(),
      endDate: start.add({ days: Math.max(days, 1) }).toString(),
    };
  }
  const start = Temporal.Instant.from(recurrenceId);
  return {
    allDay: false,
    startAt: start.toString(),
    endAt: start.add(durationOf(event)).toString(),
    startTimeZone: event.startTimeZone,
  };
}

function overlaps(
  timing: EventTiming,
  window: { from: Temporal.Instant; to: Temporal.Instant },
  timeZone: string,
): boolean {
  if (timing.allDay) {
    // 終日の予定は、表示するタイムゾーンでの日付として扱う。
    const start = Temporal.PlainDate.from(timing.startDate)
      .toZonedDateTime(timeZone)
      .toInstant();
    const endDate = Temporal.PlainDate.from(timing.endDate);
    const end = (
      Temporal.PlainDate.compare(
        endDate,
        Temporal.PlainDate.from(timing.startDate),
      ) > 0
        ? endDate
        : Temporal.PlainDate.from(timing.startDate).add({ days: 1 })
    )
      .toZonedDateTime(timeZone)
      .toInstant();
    return (
      Temporal.Instant.compare(start, window.to) < 0 &&
      Temporal.Instant.compare(end, window.from) > 0
    );
  }
  const start = Temporal.Instant.from(timing.startAt);
  const end = Temporal.Instant.from(timing.endAt);
  if (Temporal.Instant.compare(start, window.to) >= 0) return false;
  // 長さ 0 の予定は、開始が範囲に入っていれば出す。
  if (Temporal.Instant.compare(end, start) <= 0)
    return Temporal.Instant.compare(start, window.from) >= 0;
  return Temporal.Instant.compare(end, window.from) > 0;
}

function sortKey(occurrence: Occurrence<unknown>, timeZone: string): number {
  return occurrence.allDay
    ? Temporal.PlainDate.from(occurrence.startDate)
        .toZonedDateTime(timeZone)
        .toInstant().epochMilliseconds
    : Temporal.Instant.from(occurrence.startAt).epochMilliseconds;
}
