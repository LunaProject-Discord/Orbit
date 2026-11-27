"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Temporal } from "temporal-polyfill";
import { CALENDAR_BRAND, weekdayTone } from "@/components/calendar/colors";
import { Button } from "@/components/ui/button";
import {
  daysBetween,
  viewRange,
  WEEKDAY_LABELS,
  weekdayIndex,
} from "@/lib/calendar/dates";

/** サイドバーの小さな月のカレンダー。表示中の期間に背景を付け、予定のある日に点を付ける。 */
export function MiniMonth({
  today,
  selected,
  selectedRange,
  busyDays,
  onSelect,
}: {
  today: Temporal.PlainDate;
  selected: Temporal.PlainDate;
  /** 表示中の期間 [from, to)。 */
  selectedRange: { from: Temporal.PlainDate; to: Temporal.PlainDate };
  /** 予定のある日 (YYYY-MM-DD)。 */
  busyDays: ReadonlySet<string>;
  onSelect: (date: Temporal.PlainDate) => void;
}) {
  const [month, setMonth] = useState(() => selected.with({ day: 1 }));
  // 表示中の日付が別の月へ移ったら、小さなカレンダーもその月にする。
  useEffect(() => {
    setMonth(selected.with({ day: 1 }));
  }, [selected]);
  const { from, to } = viewRange("month", month);
  const days = daysBetween(from, to);
  const inRange = (day: Temporal.PlainDate) =>
    Temporal.PlainDate.compare(day, selectedRange.from) >= 0 &&
    Temporal.PlainDate.compare(day, selectedRange.to) < 0;
  return (
    <div className="px-4 pt-1 pb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-sm">
          {month.year}年{month.month}月
        </span>
        <span className="flex text-muted-foreground">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="前の月"
            onClick={() => setMonth(month.subtract({ months: 1 }))}
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="次の月"
            onClick={() => setMonth(month.add({ months: 1 }))}
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
        {WEEKDAY_LABELS.map((label, index) => (
          <span key={label} className={cn("py-1", weekdayTone(index))}>
            {label}
          </span>
        ))}
        {days.map((day) => {
          const outside = day.month !== month.month;
          const isToday = Temporal.PlainDate.compare(day, today) === 0;
          const highlighted = inRange(day);
          const weekday = weekdayIndex(day);
          const first =
            highlighted &&
            (weekday === 0 ||
              Temporal.PlainDate.compare(day, selectedRange.from) === 0);
          const last =
            highlighted &&
            (weekday === 6 ||
              Temporal.PlainDate.compare(
                day,
                selectedRange.to.subtract({ days: 1 }),
              ) === 0);
          return (
            <button
              key={day.toString()}
              type="button"
              onClick={() => onSelect(day)}
              aria-label={`${day.month}月${day.day}日`}
              aria-current={isToday ? "date" : undefined}
              className={cn(
                "relative flex h-7 items-center justify-center text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                highlighted && "bg-sidebar-accent",
                first && "rounded-l-md",
                last && "rounded-r-md",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full hover:bg-muted",
                  outside ? "text-muted-foreground/50" : "text-foreground",
                  isToday && "font-semibold text-white hover:bg-[unset]",
                )}
                style={isToday ? { background: CALENDAR_BRAND } : undefined}
              >
                {day.day}
              </span>
              {!outside && !isToday && busyDays.has(day.toString()) && (
                <span className="absolute bottom-0.5 size-1 rounded-full bg-muted-foreground/50" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
