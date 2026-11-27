"use client";

import { Temporal } from "temporal-polyfill";
import { calendarColor } from "@/components/calendar/colors";
import type { Calendar, CalendarEvent } from "@/lib/calendar/api";
import { formatMonthDayWeekday, formatTime } from "@/lib/calendar/dates";

/** 予定の検索結果 (新しい順)。押すとその日を開く。 */
export function SearchResults({
  query,
  events,
  calendars,
  timeZone,
  onOpen,
}: {
  query: string;
  events: CalendarEvent[];
  calendars: Map<string, { calendar: Calendar; index: number }>;
  timeZone: string;
  onOpen: (event: CalendarEvent, day: Temporal.PlainDate) => void;
}) {
  if (events.length === 0) {
    return (
      <p className="px-6 py-10 text-center text-muted-foreground text-sm">
        「{query}」に一致する予定はありません
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="flex max-w-3xl flex-col px-2 py-2 md:px-6">
        {events.map((event) => {
          const entry = calendars.get(event.calendarId);
          const start =
            event.allDay || !event.startAt
              ? null
              : Temporal.Instant.from(event.startAt).toZonedDateTimeISO(
                  timeZone,
                );
          const day = start
            ? start.toPlainDate()
            : Temporal.PlainDate.from(event.startDate ?? "1970-01-01");
          return (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => onOpen(event, day)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    background: calendarColor(
                      entry?.calendar,
                      entry?.index ?? 0,
                    ),
                  }}
                />
                <span className="w-36 shrink-0 text-muted-foreground tabular-nums">
                  {day.year !== Temporal.Now.plainDateISO(timeZone).year &&
                    `${day.year}年`}
                  {formatMonthDayWeekday(day)}
                  {start ? ` ${formatTime(start)}` : ""}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {event.summary?.trim() || "(タイトルなし)"}
                  {event.location && (
                    <span className="ml-2 text-muted-foreground">
                      {event.location}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
