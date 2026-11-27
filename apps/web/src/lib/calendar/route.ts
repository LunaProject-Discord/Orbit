import type { Temporal } from "temporal-polyfill";
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
