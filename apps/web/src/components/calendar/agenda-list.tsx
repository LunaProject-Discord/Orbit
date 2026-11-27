"use client";

import { cn } from "cn";
import { MapPinIcon, RepeatIcon } from "lucide-react";
import { useMemo } from "react";
import { Temporal } from "temporal-polyfill";
import { CALENDAR_BRAND, weekdayTone } from "@/components/calendar/colors";
import {
  type DisplayItem,
  itemTitle,
  type SelectHandler,
} from "@/components/calendar/types";
import {
  daysBetween,
  formatMonthDay,
  formatTime,
  WEEKDAY_LABELS,
  weekdayIndex,
} from "@/lib/calendar/dates";

type Row = { item: DisplayItem; time: string; title: string };

/** 日ごとに分けた予定 (予定の無い日は出さない)。 */
export function agendaDays(
  items: readonly DisplayItem[],
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): { day: Temporal.PlainDate; rows: Row[] }[] {
  const result: { day: Temporal.PlainDate; rows: Row[] }[] = [];
  for (const day of daysBetween(from, to)) {
    const rows: Row[] = [];
    for (const item of items) {
      const { local } = item;
      if (
        Temporal.PlainDate.compare(local.firstDay, day) > 0 ||
        Temporal.PlainDate.compare(local.lastDay, day) < 0
      ) {
        continue;
      }
      const total = local.firstDay.until(local.lastDay).days + 1;
      const nth = local.firstDay.until(day).days + 1;
      const suffix = total > 1 ? ` (${nth}/${total} 日目)` : "";
      let time: string;
      if (local.allDay) time = "終日";
      else if (total === 1)
        time = `${formatTime(local.start)}〜${formatTime(local.end)}`;
      else if (nth === 1) time = `${formatTime(local.start)}〜`;
      else if (nth === total) time = `〜${formatTime(local.end)}`;
      else time = "終日";
      rows.push({ item, time, title: `${itemTitle(item)}${suffix}` });
    }
    rows.sort((a, b) => {
      const allDayA = a.time === "終日" ? 0 : 1;
      const allDayB = b.time === "終日" ? 0 : 1;
      return (
        allDayA - allDayB ||
        Temporal.ZonedDateTime.compare(a.item.local.start, b.item.local.start)
      );
    });
    if (rows.length > 0) result.push({ day, rows });
  }
  return result;
}

/** 予定一覧 (日ごと)。 */
export function AgendaList({
  items,
  from,
  to,
  today,
  holidays,
  selectedKey,
  compact = false,
  emptyLabel = "この期間に予定はありません",
  onSelect,
}: {
  items: DisplayItem[];
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
  today: Temporal.PlainDate;
  holidays: ReadonlySet<string>;
  selectedKey: string | null;
  /** 狭い画面 (日付を上に、行を詰める)。 */
  compact?: boolean;
  emptyLabel?: string;
  onSelect: SelectHandler;
}) {
  const days = useMemo(() => agendaDays(items, from, to), [items, from, to]);
  if (days.length === 0) {
    return (
      <p className="px-6 py-10 text-center text-muted-foreground text-sm">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col", !compact && "max-w-3xl px-6 py-4")}>
      {days.map(({ day, rows }) => {
        const isToday = Temporal.PlainDate.compare(day, today) === 0;
        const weekday = weekdayIndex(day);
        return (
          <div
            key={day.toString()}
            className={cn(
              "flex border-b py-3",
              compact ? "flex-col gap-1 px-4" : "gap-6",
            )}
          >
            <div
              className={cn(
                "shrink-0",
                compact ? "flex items-baseline gap-2" : "w-28",
              )}
            >
              <p
                className="font-display font-semibold"
                style={isToday ? { color: CALENDAR_BRAND } : undefined}
              >
                {formatMonthDay(day)}
              </p>
              <p
                className={cn(
                  "text-sm",
                  weekdayTone(weekday, holidays.has(day.toString())),
                )}
              >
                {WEEKDAY_LABELS[weekday]}曜日{isToday && " · 今日"}
              </p>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {rows.map(({ item, time, title }) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={(event) => onSelect(item, event.currentTarget)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-1 py-1.5 text-left text-sm hover:bg-muted",
                    selectedKey === item.key && "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "size-2.5 shrink-0 rounded-full",
                      item.pending && "border-2 bg-transparent!",
                    )}
                    style={{ background: item.color, borderColor: item.color }}
                  />
                  <span
                    className={cn(
                      "shrink-0 text-muted-foreground tabular-nums",
                      compact ? "w-24 text-xs" : "w-28",
                    )}
                  >
                    {time}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {title}
                    {item.repeating && (
                      <RepeatIcon className="ml-1 inline size-3 text-muted-foreground" />
                    )}
                    {item.event.location && !compact && (
                      <span className="ml-2 text-muted-foreground">
                        <MapPinIcon className="mr-0.5 inline size-3" />
                        {item.event.location}
                      </span>
                    )}
                  </span>
                  {item.pending && (
                    <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                      未返信
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
