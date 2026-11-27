import {
  type EventTiming,
  expandOccurrences,
  type RecurrenceException,
} from "@orbit/core/recurrence";
import { Temporal } from "temporal-polyfill";
import type { CalendarEvent, EventRange, Occurrence } from "@/lib/calendar/api";
import type { EventRangeQuery } from "@/lib/calendar/offline/types";

/**
 * 端末の控え (原本と例外) を、期間内の回に展開する。
 * API の GET /v1/calendars/events と同じ手順 (原本ごとに例外を集めて expandOccurrences、
 * 取り消された原本は飛ばす) で、同じ形 (EventRange) を返す。
 */

function shiftDate(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** API の rowTiming と同じ。時刻の無い予定は null。 */
export function eventTiming(event: CalendarEvent): EventTiming | null {
  if (event.allDay) {
    if (!event.startDate) return null;
    const endDate =
      event.endDate && event.endDate > event.startDate
        ? event.endDate
        : shiftDate(event.startDate, 1);
    return { allDay: true, startDate: event.startDate, endDate };
  }
  if (!event.startAt) return null;
  return {
    allDay: false,
    startAt: event.startAt,
    endAt: event.endAt ?? event.startAt,
    startTimeZone: event.startTimeZone,
  };
}

const isRecurring = (event: CalendarEvent) =>
  Boolean(event.rrule) || event.rdates.length > 0;

/**
 * 期間にかかりそうな原本か (API の SQL の絞り込みと同じ。タイムゾーンの差を見込んで 1 日ずつ広く取る)。
 * 細かい判定は expandOccurrences がする。
 */
function mayOverlap(
  event: CalendarEvent,
  fromDate: string,
  toDate: string,
): boolean {
  const fromAt = Date.parse(`${fromDate}T00:00:00Z`);
  const toAt = Date.parse(`${toDate}T00:00:00Z`);
  if (event.allDay) {
    if (!event.startDate) return false;
    if (event.startDate >= toDate) return false;
    return isRecurring(event) || (event.endDate ?? event.startDate) >= fromDate;
  }
  if (!event.startAt) return false;
  const start = Date.parse(event.startAt);
  if (start >= toAt) return false;
  return (
    isRecurring(event) || Date.parse(event.endAt ?? event.startAt) >= fromAt
  );
}

export function expandRange(
  events: Iterable<CalendarEvent>,
  range: EventRangeQuery,
): EventRange {
  const fromDate = shiftDate(range.from, -1);
  const toDate = shiftDate(range.to, 1);
  const masters: CalendarEvent[] = [];
  const exceptionsByParent = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (event.parentId) {
      const list = exceptionsByParent.get(event.parentId) ?? [];
      list.push(event);
      exceptionsByParent.set(event.parentId, list);
    } else if (mayOverlap(event, fromDate, toDate)) {
      masters.push(event);
    }
  }
  // 並びを決めておく (同じ入力なら同じ結果)。
  masters.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const occurrences: Occurrence[] = [];
  const used = new Map<string, CalendarEvent>();
  for (const master of masters) {
    const masterTiming = eventTiming(master);
    if (!masterTiming || master.status === "cancelled") continue;
    const exceptions: RecurrenceException<CalendarEvent>[] = [];
    if (isRecurring(master)) {
      for (const row of exceptionsByParent.get(master.id) ?? []) {
        const value = eventTiming(row);
        if (!value || !row.recurrenceId) continue;
        exceptions.push({
          ...value,
          key: row,
          recurrenceId: row.recurrenceId,
          cancelled: row.status === "cancelled",
        });
      }
    }
    let expanded: ReturnType<typeof expandOccurrences<CalendarEvent>>;
    try {
      expanded = expandOccurrences(
        {
          ...masterTiming,
          rrule: master.rrule,
          rdates: master.rdates,
          exdates: master.exdates,
        },
        exceptions,
        range,
        { defaultTimeZone: range.timeZone },
      );
    } catch {
      // 読めない時刻の予定は飛ばす (ほかの予定の表示を止めない)。
      continue;
    }
    for (const occurrence of expanded) {
      const event = occurrence.exception ?? master;
      used.set(event.id, event);
      occurrences.push({
        eventId: event.id,
        masterId: master.id,
        recurrenceId: occurrence.recurrenceId,
        allDay: occurrence.allDay,
        startAt: occurrence.allDay ? null : occurrence.startAt,
        endAt: occurrence.allDay ? null : occurrence.endAt,
        startDate: occurrence.allDay ? occurrence.startDate : null,
        endDate: occurrence.allDay ? occurrence.endDate : null,
      });
    }
    if (expanded.length > 0) used.set(master.id, master);
  }
  return { events: [...used.values()], occurrences };
}
