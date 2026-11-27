import { Temporal } from "temporal-polyfill";
import { navigateApp } from "@/lib/app-navigation";
import {
  CALENDAR_VIEWS,
  type CalendarView,
  parsePlainDate,
} from "@/lib/calendar/dates";

/**
 * カレンダーの画面の URL。/calendar/<表示>/<日付> (例 /calendar/week/2026-11-27)。
 * 表示や日付が無ければ、端末に合う表示と今日。
 */
export type CalendarRoute = {
  view: CalendarView | null;
  date: Temporal.PlainDate | null;
};

export const CALENDAR_PATH = "/calendar";

export function isCalendarPath(pathname: string): boolean {
  return pathname === CALENDAR_PATH || pathname.startsWith(`${CALENDAR_PATH}/`);
}

export function parseCalendarRoute(pathname: string): CalendarRoute {
  const segments = pathname.split("/").filter(Boolean).slice(1);
  const view = CALENDAR_VIEWS.includes(segments[0] as CalendarView)
    ? (segments[0] as CalendarView)
    : null;
  const date = parsePlainDate(segments[view ? 1 : 0] ?? null);
  return { view, date };
}

export function buildCalendarRoute(
  view: CalendarView,
  date: Temporal.PlainDate,
): string {
  return `${CALENDAR_PATH}/${view}/${date.toString()}`;
}

// ---------------------------------------------------------------------------
// 予定を開く URL (段取り 9、設計 8 章): /calendar/events/<ID>?o=<回>
// 通知を押したとき (サービスワーカー、Desktop、Android) にこの URL で予定を開く。
// ---------------------------------------------------------------------------

/** 予定の ID (UUID) の形。通知や URL から受け取った値を確かめる。 */
export const EVENT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** 回の ID (日付か ISO 8601 の時刻) として受け付ける形。 */
const RECURRENCE_ID = /^[0-9A-Za-z:+.-]{1,64}$/;

export const CALENDAR_EVENTS_PATH = `${CALENDAR_PATH}/events`;

/** 開く予定。recurrenceId は繰り返しの回 (繰り返さない予定は null)。 */
export type CalendarEventTarget = {
  eventId: string;
  recurrenceId: string | null;
};

/** 受け取った値を確かめる。形が違えば null (外から開ける URL なので、ID の形だけ受け付ける)。 */
export function toCalendarEventTarget(
  eventId: unknown,
  recurrenceId: unknown,
): CalendarEventTarget | null {
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) return null;
  return {
    eventId: eventId.toLowerCase(),
    recurrenceId:
      typeof recurrenceId === "string" && RECURRENCE_ID.test(recurrenceId)
        ? recurrenceId
        : null,
  };
}

export function buildCalendarEventRoute(target: CalendarEventTarget): string {
  const path = `${CALENDAR_EVENTS_PATH}/${encodeURIComponent(target.eventId)}`;
  return target.recurrenceId
    ? `${path}?o=${encodeURIComponent(target.recurrenceId)}`
    : path;
}

/** /calendar/events/<ID>?o=<回> を読む。予定の URL でなければ null。 */
export function parseCalendarEventRoute(
  pathname: string,
  search = "",
): CalendarEventTarget | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "calendar") return null;
  if (segments[1] !== "events") return null;
  let eventId: string;
  try {
    eventId = decodeURIComponent(segments[2] ?? "");
  } catch {
    return null;
  }
  return toCalendarEventTarget(eventId, new URLSearchParams(search).get("o"));
}

/**
 * 開く予定の日付 (表示する日)。例外の行はその行の開始、原本と回の ID なら回の開始、
 * 繰り返さない予定はその開始。時刻のある予定は timeZone の日付。分からなければ null。
 */
export function eventTargetDate(
  event: {
    id: string;
    parentId: string | null;
    allDay: boolean;
    startAt: string | null;
    startDate: string | null;
  },
  recurrenceId: string | null,
  timeZone: string,
): Temporal.PlainDate | null {
  // 原本 (例外でない行) に回の ID が付いていれば、その回の日。
  const occurrence = event.parentId === null ? recurrenceId : null;
  try {
    if (event.allDay) {
      const value = occurrence ?? event.startDate;
      return value ? parsePlainDateLoose(value) : null;
    }
    const value = occurrence ?? event.startAt;
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parsePlainDateLoose(value);
    return Temporal.Instant.from(value)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate();
  } catch {
    return null;
  }
}

function parsePlainDateLoose(value: string): Temporal.PlainDate | null {
  return parsePlainDate(value.slice(0, 10));
}

/** 開いているカレンダーの画面へ「この予定を開いて」と知らせるイベント (detail は CalendarEventTarget)。 */
export const OPEN_CALENDAR_EVENT = "orbit:open-calendar-event";

/**
 * 予定を開く (通知を押したとき)。メールの画面を開いていればカレンダーの画面へ移り、
 * カレンダーの画面を開いていれば、その場で日付を移して詳細を出す。
 * target が null (まとめた招待など) ならカレンダーを開くだけ。
 */
export function openCalendarEvent(target: CalendarEventTarget | null): void {
  if (typeof window === "undefined") return;
  if (!target) {
    if (!isCalendarPath(window.location.pathname)) navigateApp(CALENDAR_PATH);
    return;
  }
  navigateApp(buildCalendarEventRoute(target));
  window.dispatchEvent(
    new CustomEvent<CalendarEventTarget>(OPEN_CALENDAR_EVENT, {
      detail: target,
    }),
  );
}
