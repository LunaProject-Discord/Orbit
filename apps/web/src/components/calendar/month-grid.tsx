"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { Temporal } from "temporal-polyfill";
import { CALENDAR_BRAND, weekdayTone } from "@/components/calendar/colors";
import {
  type DisplayItem,
  itemTitle,
  type SelectHandler,
} from "@/components/calendar/types";
import {
  formatTime,
  showsInAllDayRow,
  WEEKDAY_LABELS,
  weekdayIndex,
} from "@/lib/calendar/dates";
import { layoutBars } from "@/lib/calendar/layout";

/** 1 つの日に並べる行 (帯の段と時刻付きの予定) の上限。 */
const MAX_ROWS = 4;
const ROW = 20;

/** 月の表示。週ごとの行に、日をまたぐ予定は帯で、時刻付きの予定は点と時刻で出す。 */
export function MonthGrid({
  month,
  days,
  items,
  today,
  holidays,
  selectedKey,
  onSelect,
  onSelectDay,
}: {
  /** 表示している月 (1 日)。 */
  month: Temporal.PlainDate;
  days: Temporal.PlainDate[];
  items: DisplayItem[];
  today: Temporal.PlainDate;
  holidays: ReadonlySet<string>;
  selectedKey: string | null;
  onSelect: SelectHandler;
  onSelectDay: (day: Temporal.PlainDate) => void;
}) {
  const weeks = useMemo(() => {
    const result: Temporal.PlainDate[][] = [];
    for (let index = 0; index < days.length; index += 7) {
      result.push(days.slice(index, index + 7));
    }
    return result;
  }, [days]);

  const layout = useMemo(
    () =>
      weeks.map((week) => {
        const first = week[0] as Temporal.PlainDate;
        const bars: { item: DisplayItem; from: number; to: number }[] = [];
        const timed = week.map(() => [] as DisplayItem[]);
        for (const item of items) {
          const from = first.until(item.local.firstDay).days;
          const to = first.until(item.local.lastDay).days;
          if (to < 0 || from > 6) continue;
          const multiDay = from !== to;
          if (showsInAllDayRow(item.local) || multiDay) {
            bars.push({ item, from: Math.max(0, from), to: Math.min(6, to) });
          } else {
            timed[from]?.push(item);
          }
        }
        const placed = layoutBars(
          bars.map((bar) => ({ id: bar.item.key, from: bar.from, to: bar.to })),
        );
        const byKey = new Map(bars.map((bar) => [bar.item.key, bar.item]));
        const barRows = placed.map((bar) => ({
          ...bar,
          item: byKey.get(bar.id) as DisplayItem,
        }));
        for (const list of timed) {
          list.sort((a, b) =>
            Temporal.ZonedDateTime.compare(a.local.start, b.local.start),
          );
        }
        return { bars: barRows, timed };
      }),
    [weeks, items],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b">
        {WEEKDAY_LABELS.map((label, index) => (
          <span
            key={label}
            className={cn(
              "border-l py-1.5 pl-2 text-xs first:border-l-0",
              weekdayTone(index),
            )}
          >
            {label}
          </span>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.map((week, weekIndex) => {
          const { bars, timed } = layout[weekIndex] ?? { bars: [], timed: [] };
          const visibleBars = bars.filter((bar) => bar.lane < MAX_ROWS - 1);
          return (
            <div
              key={week[0]?.toString()}
              className="relative grid min-h-0 grid-cols-7 border-b"
            >
              {week.map((day, dayIndex) => {
                const outside = day.month !== month.month;
                const isToday = Temporal.PlainDate.compare(day, today) === 0;
                const weekday = weekdayIndex(day);
                const holiday = holidays.has(day.toString());
                // この日にかかる帯の段のうち、いちばん下の段。
                const lanesHere = bars
                  .filter((bar) => bar.from <= dayIndex && bar.to >= dayIndex)
                  .map((bar) => bar.lane);
                const usedLanes =
                  lanesHere.length === 0 ? 0 : Math.max(...lanesHere) + 1;
                const shownLanes = Math.min(usedLanes, MAX_ROWS - 1);
                const hiddenBars = lanesHere.filter(
                  (lane) => lane >= MAX_ROWS - 1,
                ).length;
                const list = timed[dayIndex] ?? [];
                const room = Math.max(0, MAX_ROWS - shownLanes);
                const fits = list.length + hiddenBars <= room;
                const shown = fits
                  ? list
                  : list.slice(0, Math.max(0, room - 1));
                const hidden = list.length - shown.length + hiddenBars;
                return (
                  <div
                    key={day.toString()}
                    className={cn(
                      "min-w-0 overflow-hidden border-l p-1 first:border-l-0",
                      (weekday === 0 || weekday === 6 || holiday) &&
                        "bg-muted/40",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectDay(day)}
                      aria-label={`${day.month}月${day.day}日を表示`}
                      className={cn(
                        "ml-1 inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums hover:bg-muted",
                        weekdayTone(weekday, holiday),
                        weekday !== 0 &&
                          weekday !== 6 &&
                          !holiday &&
                          "text-foreground",
                        outside && "text-muted-foreground/50!",
                        isToday && "font-semibold text-white! hover:bg-[unset]",
                      )}
                      style={
                        isToday ? { background: CALENDAR_BRAND } : undefined
                      }
                    >
                      {day.day}
                    </button>
                    <div style={{ height: shownLanes * (ROW + 2) }} />
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {shown.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={(event) =>
                            onSelect(item, event.currentTarget)
                          }
                          className={cn(
                            "flex h-5 min-w-0 items-center gap-1.5 rounded px-1 text-left text-xs hover:bg-muted",
                            item.pending && "opacity-70",
                            selectedKey === item.key && "ring-2 ring-ring",
                          )}
                        >
                          <span
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              item.pending && "border-2 bg-transparent!",
                            )}
                            style={{
                              background: item.color,
                              borderColor: item.color,
                            }}
                          />
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {formatTime(item.local.start)}
                          </span>
                          <span
                            className={cn(
                              "truncate",
                              item.declined && "opacity-50",
                            )}
                          >
                            {itemTitle(item)}
                          </span>
                        </button>
                      ))}
                      {hidden > 0 && (
                        <button
                          type="button"
                          onClick={() => onSelectDay(day)}
                          className="h-5 rounded px-1 text-left text-muted-foreground text-xs hover:bg-muted"
                        >
                          ほか {hidden} 件
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleBars.map((bar) => {
                const continuesBefore =
                  Temporal.PlainDate.compare(
                    bar.item.local.firstDay,
                    week[0] as Temporal.PlainDate,
                  ) < 0;
                const continuesAfter =
                  Temporal.PlainDate.compare(
                    bar.item.local.lastDay,
                    week[6] as Temporal.PlainDate,
                  ) > 0;
                return (
                  <button
                    key={bar.id}
                    type="button"
                    onClick={(event) => onSelect(bar.item, event.currentTarget)}
                    className={cn(
                      "absolute flex items-center gap-0.5 truncate rounded px-1.5 text-left font-medium text-white text-xs",
                      bar.item.pending &&
                        "border border-dashed bg-background! text-foreground",
                      selectedKey === bar.item.key && "ring-2 ring-ring",
                    )}
                    style={{
                      top: 32 + bar.lane * (ROW + 2),
                      height: ROW,
                      left: `calc(100% / 7 * ${bar.from} + 4px)`,
                      width: `calc(100% / 7 * ${bar.to - bar.from + 1} - 8px)`,
                      background: bar.item.color,
                      borderColor: bar.item.color,
                    }}
                  >
                    {continuesBefore && (
                      <ChevronLeftIcon className="size-3.5 shrink-0" />
                    )}
                    <span
                      className={cn(
                        "truncate",
                        bar.item.declined && "opacity-60",
                      )}
                    >
                      {itemTitle(bar.item)}
                    </span>
                    {continuesAfter && (
                      <ChevronRightIcon className="ml-auto size-3.5 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
