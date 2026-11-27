import { Temporal } from "temporal-polyfill";
import type { Occurrence } from "@/lib/calendar/api";

/**
 * カレンダーの日付の計算。日付は Temporal (temporal-polyfill)、表示は Intl.DateTimeFormat。
 * 週は日曜から始める。
 */

export type CalendarView = "day" | "3day" | "week" | "month" | "agenda";

export const CALENDAR_VIEWS: readonly CalendarView[] = [
  "day",
  "3day",
  "week",
  "month",
  "agenda",
];

/** 予定一覧で一度に出す日数。 */
export const AGENDA_DAYS = 30;

export function localTimeZone(): string {
  return Temporal.Now.timeZoneId();
}

export function todayIn(timeZone: string): Temporal.PlainDate {
  return Temporal.Now.plainDateISO(timeZone);
}

/** その日を含む週の日曜日。 */
export function startOfWeek(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek % 7 });
}

/** 表示する日の範囲 [from, to)。月は、その月を含む週をすべて (5 か 6 週)。 */
export function viewRange(
  view: CalendarView,
  date: Temporal.PlainDate,
): { from: Temporal.PlainDate; to: Temporal.PlainDate } {
  switch (view) {
    case "day":
      return { from: date, to: date.add({ days: 1 }) };
    case "3day":
      return { from: date, to: date.add({ days: 3 }) };
    case "week": {
      const from = startOfWeek(date);
      return { from, to: from.add({ days: 7 }) };
    }
    case "month": {
      const first = date.with({ day: 1 });
      const from = startOfWeek(first);
      const last = first.add({ months: 1 });
      const weeks = Math.ceil(from.until(last).days / 7);
      return { from, to: from.add({ days: weeks * 7 }) };
    }
    case "agenda":
      return { from: date, to: date.add({ days: AGENDA_DAYS }) };
  }
}

/** 前後の期間へ動かす。 */
export function shiftDate(
  view: CalendarView,
  date: Temporal.PlainDate,
  direction: 1 | -1,
): Temporal.PlainDate {
  switch (view) {
    case "day":
      return date.add({ days: direction });
    case "3day":
      return date.add({ days: 3 * direction });
    case "week":
      return date.add({ weeks: direction });
    case "month":
      return date.with({ day: 1 }).add({ months: direction });
    case "agenda":
      return date.add({ days: AGENDA_DAYS * direction });
  }
}

export function daysBetween(
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): Temporal.PlainDate[] {
  const days: Temporal.PlainDate[] = [];
  for (let day = from; Temporal.PlainDate.compare(day, to) < 0; ) {
    days.push(day);
    day = day.add({ days: 1 });
  }
  return days;
}

/** 日曜 0 〜 土曜 6。 */
export function weekdayIndex(date: Temporal.PlainDate): number {
  return date.dayOfWeek % 7;
}

export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// 日付だけを表示するので、UTC の正午として渡して UTC で書式にする (タイムゾーンで日付がずれない)。
const utc = { timeZone: "UTC" } as const;
const monthTitle = new Intl.DateTimeFormat("ja-JP", {
  ...utc,
  year: "numeric",
  month: "long",
});
const dayTitle = new Intl.DateTimeFormat("ja-JP", {
  ...utc,
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});
const monthDay = new Intl.DateTimeFormat("ja-JP", {
  ...utc,
  month: "long",
  day: "numeric",
});
const monthDayWeekday = new Intl.DateTimeFormat("ja-JP", {
  ...utc,
  month: "long",
  day: "numeric",
  weekday: "short",
});

function toDate(date: Temporal.PlainDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
}

/** 上の帯に出す見出し。 */
export function viewTitle(
  view: CalendarView,
  date: Temporal.PlainDate,
): string {
  if (view === "day") return dayTitle.format(toDate(date));
  if (view === "agenda") {
    const { to } = viewRange(view, date);
    return `${formatMonthDay(date)}〜${formatMonthDay(to.subtract({ days: 1 }))}`;
  }
  const target =
    view === "month" ? date.with({ day: 1 }) : viewRange(view, date).from;
  return monthTitle.format(toDate(target));
}

/** 狭い画面の見出し (「11月」など)。 */
export function shortMonthTitle(date: Temporal.PlainDate): string {
  return `${date.month}月`;
}

export function formatMonthDay(date: Temporal.PlainDate): string {
  return monthDay.format(toDate(date));
}

export function formatMonthDayWeekday(date: Temporal.PlainDate): string {
  return monthDayWeekday.format(toDate(date));
}

/** 時刻 (「9:30」)。 */
export function formatTime(value: Temporal.ZonedDateTime): string {
  return `${value.hour}:${String(value.minute).padStart(2, "0")}`;
}

/** 回を、表示するタイムゾーンでの日時にした形。 */
export type LocalOccurrence = {
  occurrence: Occurrence;
  allDay: boolean;
  /** 終日: その日の 0 時。時刻付き: 開始と終了。 */
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
  /** 最初の日と最後の日 (終わりの日を含む)。 */
  firstDay: Temporal.PlainDate;
  lastDay: Temporal.PlainDate;
};

export function toLocal(
  occurrence: Occurrence,
  timeZone: string,
): LocalOccurrence | null {
  if (occurrence.allDay) {
    if (!occurrence.startDate) return null;
    const firstDay = Temporal.PlainDate.from(occurrence.startDate);
    const endDate = occurrence.endDate
      ? Temporal.PlainDate.from(occurrence.endDate)
      : firstDay.add({ days: 1 });
    const lastDay =
      Temporal.PlainDate.compare(endDate, firstDay) > 0
        ? endDate.subtract({ days: 1 })
        : firstDay;
    return {
      occurrence,
      allDay: true,
      start: firstDay.toZonedDateTime(timeZone),
      end: lastDay.add({ days: 1 }).toZonedDateTime(timeZone),
      firstDay,
      lastDay,
    };
  }
  if (!occurrence.startAt) return null;
  const start = Temporal.Instant.from(occurrence.startAt).toZonedDateTimeISO(
    timeZone,
  );
  const endRaw = Temporal.Instant.from(
    occurrence.endAt ?? occurrence.startAt,
  ).toZonedDateTimeISO(timeZone);
  const end =
    Temporal.ZonedDateTime.compare(endRaw, start) < 0 ? start : endRaw;
  // 0 時ちょうどに終わる予定は、前の日までとして扱う。
  const endsAtMidnight =
    end.hour === 0 &&
    end.minute === 0 &&
    end.second === 0 &&
    Temporal.ZonedDateTime.compare(end, start) > 0;
  const lastDay = endsAtMidnight
    ? end.toPlainDate().subtract({ days: 1 })
    : end.toPlainDate();
  return {
    occurrence,
    allDay: false,
    start,
    end,
    firstDay: start.toPlainDate(),
    lastDay,
  };
}

/** 時刻付きでも、24 時間以上続く予定は終日の段に出す。 */
export function showsInAllDayRow(local: LocalOccurrence): boolean {
  if (local.allDay) return true;
  return local.start.until(local.end, { largestUnit: "hours" }).hours >= 24;
}

/** その日の何分目から何分目までにかかるか (0〜1440、壁時計の時刻)。かからなければ null。 */
export function minutesOnDay(
  local: LocalOccurrence,
  day: Temporal.PlainDate,
  timeZone: string,
): { start: number; end: number } | null {
  const dayStart = day.toZonedDateTime(timeZone);
  const dayEnd = day.add({ days: 1 }).toZonedDateTime(timeZone);
  const cmp = Temporal.ZonedDateTime.compare;
  if (cmp(local.start, dayEnd) >= 0) return null;
  const zeroLength = cmp(local.start, local.end) === 0;
  if (cmp(local.end, dayStart) < 0) return null;
  if (cmp(local.end, dayStart) === 0 && !zeroLength) return null;
  const start =
    cmp(local.start, dayStart) <= 0
      ? 0
      : local.start.hour * 60 + local.start.minute;
  const end =
    cmp(local.end, dayEnd) >= 0 ? 1440 : local.end.hour * 60 + local.end.minute;
  return { start, end: Math.max(end, start) };
}

/** 時刻付きの予定の「9:00〜10:30」。日をまたぐときは日付も付ける。 */
export function formatTimeRange(local: LocalOccurrence): string {
  if (local.allDay) {
    if (Temporal.PlainDate.compare(local.firstDay, local.lastDay) === 0) {
      return "終日";
    }
    return `${formatMonthDay(local.firstDay)}〜${formatMonthDay(local.lastDay)}`;
  }
  const sameDay =
    Temporal.PlainDate.compare(
      local.start.toPlainDate(),
      local.end.toPlainDate(),
    ) === 0;
  if (sameDay) return `${formatTime(local.start)}〜${formatTime(local.end)}`;
  return `${formatMonthDay(local.start.toPlainDate())} ${formatTime(local.start)}〜${formatMonthDay(local.end.toPlainDate())} ${formatTime(local.end)}`;
}

/** URL などに使う日付の文字列。 */
export function parsePlainDate(
  value: string | null,
): Temporal.PlainDate | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    return null;
  }
}
