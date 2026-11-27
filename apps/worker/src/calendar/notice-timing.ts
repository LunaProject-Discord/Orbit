import {
  type CalendarTextTiming,
  type EventNoticeSnapshot,
  expandOccurrences,
} from "@orbit/core";
import type { StoredEventNoticeSnapshot } from "@orbit/db";

/**
 * 招待・変更・取り消しの通知に出す日時と期限 (段取り 9、レビュー H1・L7)。
 * - 繰り返す予定は、原本の最初の回ではなく「今より後に終わる次の回」を使う。次の回が無い
 *   (終わった繰り返し) なら null = 送らない。
 * - 終日の予定の終了は、利用者のタイムゾーンで終了日 (含まない日) の 0:00 にする。終了日が
 *   無い・開始日と同じ行は、開始日の翌日を終了日とみなす。
 */

const DAY_MS = 24 * 60 * 60_000;
/** 次の回を探す範囲 (毎年の繰り返しも拾えるように 13 か月強)。 */
const NEXT_OCCURRENCE_SEARCH_DAYS = 400;

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** その日の 0:00 (timeZone) の epoch ms。Intl でオフセットを求める (worker は Temporal を直接持たない)。 */
export function zonedDayStart(date: string, timeZone: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return (
      Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second"),
      ) - at
    );
  };
  try {
    let result = utc - offset(utc);
    result = utc - offset(result);
    return result;
  } catch {
    return utc;
  }
}

/** 終日の終了日 (含まない日)。無い・開始日以前なら開始日の翌日。 */
function allDayEndDate(startDate: string, endDate: string | undefined) {
  if (endDate && endDate > startDate) return endDate;
  return utcDate(Date.parse(`${startDate}T00:00:00Z`) + DAY_MS);
}

/** 1 回分の日時の終了 (epoch ms)。終日は timeZone の終了日の 0:00。 */
export function timingEnd(timing: CalendarTextTiming, timeZone: string) {
  if (timing.allDay) {
    return zonedDayStart(
      allDayEndDate(timing.startDate, timing.endDate),
      timeZone,
    );
  }
  return Date.parse(timing.endAt);
}

/** 1 回分の日時の開始 (epoch ms)。 */
function timingStart(timing: CalendarTextTiming, timeZone: string) {
  return timing.allDay
    ? zonedDayStart(timing.startDate, timeZone)
    : Date.parse(timing.startAt);
}

function timingOf(
  snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
): CalendarTextTiming | null {
  if (snapshot.allDay) {
    if (!snapshot.startDate) return null;
    return {
      allDay: true,
      startDate: snapshot.startDate,
      endDate: allDayEndDate(snapshot.startDate, snapshot.endDate),
    };
  }
  if (!snapshot.startAt) return null;
  return {
    allDay: false,
    startAt: snapshot.startAt,
    endAt: snapshot.endAt ?? snapshot.startAt,
  };
}

export type NoticeOccurrence = {
  /** 文言に出す日時。 */
  timing: CalendarTextTiming;
  /** その回の開始と終了 (epoch ms)。終了は通知の期限 (expiresAt) になる。 */
  start: number;
  end: number;
};

/**
 * 通知に使う回 (繰り返さない予定はその予定、繰り返す予定は今より後に終わる次の回)。
 * 終わった予定・次の回の無い繰り返しは null。timeZone は利用者のタイムゾーン (終日の終わり)。
 */
export function noticeOccurrence(
  snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
  now: number,
  timeZone: string,
): NoticeOccurrence | null {
  const timing = timingOf(snapshot);
  if (!timing) return null;
  if (!snapshot.rrule) {
    const end = timingEnd(timing, timeZone);
    if (!Number.isFinite(end) || end <= now) return null;
    return { timing, start: timingStart(timing, timeZone), end };
  }
  const occurrences = expandOccurrences<null>(
    timing.allDay
      ? { ...timing, rrule: snapshot.rrule }
      : {
          ...timing,
          startTimeZone: snapshot.timeZone,
          rrule: snapshot.rrule,
        },
    [],
    {
      from: utcDate(now - 2 * DAY_MS),
      to: utcDate(now + NEXT_OCCURRENCE_SEARCH_DAYS * DAY_MS),
      timeZone: "UTC",
    },
    { defaultTimeZone: snapshot.timeZone ?? timeZone },
  );
  for (const occurrence of occurrences) {
    const next: CalendarTextTiming = occurrence.allDay
      ? {
          allDay: true,
          startDate: occurrence.startDate,
          endDate: occurrence.endDate,
        }
      : {
          allDay: false,
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
        };
    const end = timingEnd(next, timeZone);
    if (end > now) {
      return { timing: next, start: timingStart(next, timeZone), end };
    }
  }
  return null;
}

/**
 * noticeOccurrence の、計算が投げたとき (読めない規則・タイムゾーン) の扱いつき版。
 * 投げたら snapshot の日時をそのまま使い、期限は付けない (end は undefined)。
 */
export function safeNoticeOccurrence(
  snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
  now: number,
  timeZone: string,
): { timing: CalendarTextTiming; start?: number; end?: number } | null {
  try {
    return noticeOccurrence(snapshot, now, timeZone);
  } catch {
    const timing = timingOf(snapshot);
    return timing ? { timing } : null;
  }
}
