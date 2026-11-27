import type { Calendar } from "@/lib/calendar/api";

/** 今日の印などに使う、カレンダーの色 (Orbit Calendar の色)。 */
export const CALENDAR_BRAND = "#F43F7A";

/** 色を選んでいないカレンダーに、並び順で割り当てる色。 */
const PALETTE = [
  "#0ea5e9",
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#f43f5e",
  "#14b8a6",
  "#64748b",
];

export function calendarColor(calendar: Calendar | undefined, index = 0) {
  if (calendar?.color) return calendar.color;
  if (calendar?.source === "holidays") return "#f43f5e";
  return PALETTE[index % PALETTE.length] as string;
}

/** 土日・祝日の文字色。 */
export function weekdayTone(weekday: number, holiday = false): string {
  if (weekday === 0 || holiday) return "text-rose-500";
  if (weekday === 6) return "text-sky-600 dark:text-sky-400";
  return "text-muted-foreground";
}
