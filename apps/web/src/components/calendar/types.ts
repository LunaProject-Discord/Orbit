import type { CalendarEvent } from "@/lib/calendar/api";
import type { LocalOccurrence } from "@/lib/calendar/dates";

/** 画面に出す 1 回分。 */
export type DisplayItem = {
  /** 回ごとに一意な値 (予定の ID と回)。 */
  key: string;
  local: LocalOccurrence;
  event: CalendarEvent;
  color: string;
  /** 自分が招待されていて、まだ返事をしていない。 */
  pending: boolean;
  /** 繰り返しの予定の回。 */
  repeating: boolean;
  /** 書き込めないカレンダーの予定。 */
  readOnly: boolean;
};

/** 予定を選んだとき。anchor は詳細を出す位置の要素。 */
export type SelectHandler = (item: DisplayItem, anchor: HTMLElement) => void;

export function itemTitle(item: DisplayItem): string {
  return item.event.summary?.trim() || "(タイトルなし)";
}
