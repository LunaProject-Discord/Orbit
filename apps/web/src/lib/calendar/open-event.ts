import type { Temporal } from "temporal-polyfill";
import {
  type CalendarEventTarget,
  eventTargetDate,
} from "@/lib/calendar/route";

/**
 * 通知から予定を開く流れ (/calendar/events/<ID>?o=<回>、段取り 9)。calendar-app.tsx が使う。
 * 1. 控えから予定を探し、その日へ移る (locate)。控えに無ければ pull してから探し直し、
 *    それでも無ければ閉じる (カレンダーを開いたままにする)。
 * 2. 移った日の表示に回が出たら、その回の詳細を開く (findOpeningItem)。非表示のカレンダーの
 *    予定など、表示に出ないものは開かない (日付だけ移る)。
 */

/** 通知から開く予定と、探す途中の状態。 */
export type OpeningEvent = CalendarEventTarget & {
  /** 控えに無かったので pull している / した。 */
  pulling?: boolean;
  pulled?: boolean;
  /** 控えで見つけ、その日へ移った。 */
  located?: boolean;
  day?: Temporal.PlainDate;
  masterId?: string;
};

export type OpeningStep =
  /** 控えの初回の同期を待つ (終われば控えが変わって、もう一度決める)。 */
  | { type: "wait" }
  /** 控えに無いので pull する。 */
  | { type: "pull" }
  /** 見つからない。カレンダーを開いたままにする。 */
  | { type: "close" }
  /** 見つけた。その日へ移る。 */
  | { type: "locate"; day: Temporal.PlainDate; masterId: string };

type SnapshotEvent = {
  id: string;
  parentId: string | null;
  allDay: boolean;
  startAt: string | null;
  startDate: string | null;
};

/** 次に何をするか。calendarsReady はカレンダーの一覧を読み終えたか。 */
export function nextOpeningStep(
  opening: OpeningEvent,
  snapshot: { events: readonly SnapshotEvent[] } | null,
  calendarsReady: boolean,
  timeZone: string,
): OpeningStep {
  if (!snapshot) {
    return calendarsReady && !opening.pulled
      ? { type: "pull" }
      : { type: "wait" };
  }
  const event = snapshot.events.find((item) => item.id === opening.eventId);
  if (!event) return opening.pulled ? { type: "close" } : { type: "pull" };
  const day = eventTargetDate(event, opening.recurrenceId, timeZone);
  if (!day) return { type: "close" };
  return { type: "locate", day, masterId: event.parentId ?? event.id };
}

/** 同じ時刻を指す recurrenceId か (書き方の違い、.000Z の有無などを無視する)。 */
export function sameRecurrenceId(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const left = Date.parse(a);
  return !Number.isNaN(left) && left === Date.parse(b);
}

/** 表示中の回から、開く回を探す。繰り返しの回は原本と回の ID で、それ以外は予定の ID で比べる。 */
export function findOpeningItem<
  T extends {
    event: { id: string };
    local: { occurrence: { masterId: string; recurrenceId: string | null } };
  },
>(opening: OpeningEvent, items: readonly T[]): T | undefined {
  return items.find((candidate) =>
    opening.recurrenceId
      ? candidate.local.occurrence.masterId === opening.masterId &&
        sameRecurrenceId(
          candidate.local.occurrence.recurrenceId,
          opening.recurrenceId,
        )
      : candidate.event.id === opening.eventId,
  );
}
