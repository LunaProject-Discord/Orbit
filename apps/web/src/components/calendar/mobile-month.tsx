"use client";

import { cn } from "cn";
import { useMemo } from "react";
import { Temporal } from "temporal-polyfill";
import { AgendaList } from "@/components/calendar/agenda-list";
import { CALENDAR_BRAND, weekdayTone } from "@/components/calendar/colors";
import type { DisplayItem, SelectHandler } from "@/components/calendar/types";
import { WEEKDAY_LABELS, weekdayIndex } from "@/lib/calendar/dates";

/** スマホの月の表示。日ごとに予定の色の点を出し、下に選んだ日の予定を並べる。 */
export function MobileMonth({
  month,
  selected,
  days,
  items,
  today,
  holidays,
  selectedKey,
  onSelect,
  onSelectDay,
}: {
  month: Temporal.PlainDate;
  /** 下に予定を出す日。 */
  selected: Temporal.PlainDate;
  days: Temporal.PlainDate[];
  items: DisplayItem[];
  today: Temporal.PlainDate;
  holidays: ReadonlySet<string>;
  selectedKey: string | null;
  onSelect: SelectHandler;
  onSelectDay: (day: Temporal.PlainDate) => void;
}) {
  const dots = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of items) {
      for (
        let day = item.local.firstDay;
        Temporal.PlainDate.compare(day, item.local.lastDay) <= 0;
        day = day.add({ days: 1 })
      ) {
        const key = day.toString();
        const list = map.get(key) ?? [];
        list.push(item.color);
        map.set(key, list);
      }
    }
    return map;
  }, [items]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="grid shrink-0 grid-cols-7 px-2 text-center text-xs">
        {WEEKDAY_LABELS.map((label, index) => (
          <span key={label} className={cn("py-1.5", weekdayTone(index))}>
            {label}
          </span>
        ))}
        {days.map((day) => {
          const key = day.toString();
          const outside = day.month !== month.month;
          const isToday = Temporal.PlainDate.compare(day, today) === 0;
          const isSelected = Temporal.PlainDate.compare(day, selected) === 0;
          const weekday = weekdayIndex(day);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectDay(day)}
              aria-label={`${day.month}月${day.day}日`}
              className="flex h-12 flex-col items-center gap-1 pt-1"
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                  weekday === 0 || weekday === 6 || holidays.has(key)
                    ? weekdayTone(weekday, holidays.has(key))
                    : "text-foreground",
                  outside && "text-muted-foreground/50!",
                  isSelected && !isToday && "bg-muted",
                  isToday && "font-semibold text-white!",
                )}
                style={isToday ? { background: CALENDAR_BRAND } : undefined}
              >
                {day.day}
              </span>
              <span className="flex gap-0.5">
                {!outside &&
                  (dots.get(key) ?? []).slice(0, 3).map((color, index) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: 同じ色が並ぶので位置で見分ける
                      key={index}
                      className="size-1.5 rounded-full"
                      style={{ background: color }}
                    />
                  ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 border-t">
        <AgendaList
          compact
          items={items}
          from={selected}
          to={selected.add({ days: 1 })}
          today={today}
          holidays={holidays}
          selectedKey={selectedKey}
          emptyLabel="予定はありません"
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}
