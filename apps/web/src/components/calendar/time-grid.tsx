"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, RepeatIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Temporal } from "temporal-polyfill";
import { CALENDAR_BRAND, weekdayTone } from "@/components/calendar/colors";
import {
  type DisplayItem,
  itemTitle,
  type SelectHandler,
} from "@/components/calendar/types";
import {
  formatTime,
  minutesOnDay,
  showsInAllDayRow,
  WEEKDAY_LABELS,
  weekdayIndex,
} from "@/lib/calendar/dates";
import { layoutBars, layoutTimed } from "@/lib/calendar/layout";

/** 1 時間の高さ (px)。 */
const HOUR = 52;
/** 最初に見せる時刻 (時)。 */
const INITIAL_HOUR = 8;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function eventStyle(item: DisplayItem): React.CSSProperties {
  return item.pending
    ? {
        borderColor: item.color,
        color: "var(--foreground)",
        background: "var(--background)",
      }
    : {
        borderColor: item.color,
        background: `color-mix(in oklab, ${item.color} 16%, var(--background))`,
      };
}

/** 日・3 日・週の表示 (上に終日の段、下に時間の格子)。 */
export function TimeGrid({
  days,
  items,
  timeZone,
  today,
  now,
  holidays,
  selectedKey,
  compact = false,
  onSelect,
  onCreateAt,
  onSelectDay,
}: {
  days: Temporal.PlainDate[];
  items: DisplayItem[];
  timeZone: string;
  today: Temporal.PlainDate;
  now: Temporal.ZonedDateTime;
  /** 祝日 (YYYY-MM-DD)。曜日を赤くする。 */
  holidays: ReadonlySet<string>;
  selectedKey: string | null;
  /** 狭い画面 (時刻の列を細くする)。 */
  compact?: boolean;
  onSelect: SelectHandler;
  /** 空いているところを押した (時刻は 30 分単位)。 */
  onCreateAt: (day: Temporal.PlainDate, minutes: number) => void;
  onSelectDay: (day: Temporal.PlainDate) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const first = days[0];
  const last = days[days.length - 1];

  const { bars, laneCount, timed } = useMemo(() => {
    if (!first || !last) return { bars: [], laneCount: 0, timed: [] };
    const allDay: { item: DisplayItem; from: number; to: number }[] = [];
    const perDay = days.map(
      () => [] as { item: DisplayItem; start: number; end: number }[],
    );
    for (const item of items) {
      if (showsInAllDayRow(item.local)) {
        const from = Math.max(0, first.until(item.local.firstDay).days);
        const to = Math.min(
          days.length - 1,
          first.until(item.local.lastDay).days,
        );
        if (to < 0 || from > days.length - 1 || from > to) continue;
        allDay.push({ item, from, to });
        continue;
      }
      days.forEach((day, index) => {
        const span = minutesOnDay(item.local, day, timeZone);
        if (span) perDay[index]?.push({ item, ...span });
      });
    }
    const placedBars = layoutBars(
      allDay.map((bar) => ({ id: bar.item.key, from: bar.from, to: bar.to })),
    );
    const byKey = new Map(allDay.map((bar) => [bar.item.key, bar]));
    const bars = placedBars.map((placed) => ({
      ...placed,
      item: byKey.get(placed.id)?.item as DisplayItem,
    }));
    const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);
    const timed = perDay.map((list) => {
      const map = new Map(list.map((entry) => [entry.item.key, entry.item]));
      return layoutTimed(
        list.map((entry) => ({
          id: entry.item.key,
          start: entry.start,
          end: entry.end,
        })),
      ).map((placed) => ({
        ...placed,
        item: map.get(placed.id) as DisplayItem,
      }));
    });
    return { bars, laneCount, timed };
  }, [days, items, timeZone, first, last]);

  // 最初は朝 8 時 (それより早い予定があればその少し前) から見せる。
  const firstKey = first?.toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 表示する日が変わったときだけ動かす (予定が届くたびには動かさない)
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !firstKey) return;
    const earliest = timed
      .flat()
      .reduce((min, entry) => Math.min(min, entry.start), INITIAL_HOUR * 60);
    element.scrollTop = Math.max(0, (earliest / 60 - 0.5) * HOUR);
  }, [firstKey]);

  const gutter = compact ? "w-11" : "w-16";
  const lastDay = last;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 日付の見出し */}
      <div className="flex shrink-0 border-b pr-3">
        <div className={cn(gutter, "shrink-0")} />
        {days.map((day) => {
          const isToday = Temporal.PlainDate.compare(day, today) === 0;
          const weekday = weekdayIndex(day);
          return (
            <button
              key={day.toString()}
              type="button"
              onClick={() => onSelectDay(day)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 border-l py-2 pl-3 text-left",
                compact && "flex-col gap-0.5 pl-0 text-center",
              )}
            >
              <span
                className={cn(
                  "text-sm",
                  weekdayTone(weekday, holidays.has(day.toString())),
                  isToday && "font-semibold",
                )}
                style={isToday ? { color: CALENDAR_BRAND } : undefined}
              >
                {WEEKDAY_LABELS[weekday]}
              </span>
              <span
                className={cn(
                  "flex size-8 items-center justify-center rounded-full font-display font-semibold text-lg tabular-nums",
                  isToday && "text-white",
                )}
                style={isToday ? { background: CALENDAR_BRAND } : undefined}
              >
                {day.day}
              </span>
            </button>
          );
        })}
      </div>
      {/* 終日 */}
      <div className="relative flex shrink-0 border-b pr-3">
        <div
          className={cn(
            gutter,
            "flex shrink-0 items-start justify-end py-1.5 pr-2 text-[11px] text-muted-foreground",
          )}
        >
          終日
        </div>
        {days.map((day) => (
          <div
            key={day.toString()}
            className="flex-1 border-l"
            style={{ minHeight: Math.max(36, laneCount * 27 + 8) }}
          />
        ))}
        <div
          className={cn(
            "absolute inset-y-0 right-3 grid py-1",
            compact ? "left-11" : "left-16",
          )}
          style={{
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            gridAutoRows: "24px",
            rowGap: 3,
          }}
        >
          {bars.map((bar) => {
            const continuesBefore =
              first &&
              Temporal.PlainDate.compare(bar.item.local.firstDay, first) < 0;
            const continuesAfter =
              lastDay &&
              Temporal.PlainDate.compare(bar.item.local.lastDay, lastDay) > 0;
            return (
              <button
                key={bar.id}
                type="button"
                onClick={(event) => onSelect(bar.item, event.currentTarget)}
                className={cn(
                  "mx-1 flex min-w-0 items-center gap-1 rounded-md px-2 text-left font-medium text-white text-xs",
                  bar.item.pending &&
                    "border border-dashed bg-background! text-foreground",
                  selectedKey === bar.item.key && "ring-2 ring-ring",
                )}
                style={{
                  gridColumn: `${bar.from + 1} / ${bar.to + 2}`,
                  gridRow: bar.lane + 1,
                  background: bar.item.color,
                  borderColor: bar.item.color,
                }}
              >
                {continuesBefore && (
                  <ChevronLeftIcon className="size-3.5 shrink-0" />
                )}
                <span
                  className={cn("truncate", bar.item.declined && "opacity-60")}
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
      </div>
      {/* 時間の格子 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex" style={{ height: HOUR * 24 }}>
          <div className={cn(gutter, "shrink-0")}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="relative text-right text-[11px] text-muted-foreground tabular-nums"
                style={{ height: HOUR }}
              >
                {hour > 0 && (
                  <span className="absolute -top-2 right-2">{hour}:00</span>
                )}
              </div>
            ))}
          </div>
          {days.map((day, index) => {
            const weekday = weekdayIndex(day);
            const isToday = Temporal.PlainDate.compare(day, today) === 0;
            return (
              <div
                key={day.toString()}
                className={cn(
                  "relative min-w-0 flex-1 border-l",
                  (weekday === 0 ||
                    weekday === 6 ||
                    holidays.has(day.toString())) &&
                    "bg-muted/40",
                )}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="border-border/70 border-b"
                    style={{ height: HOUR }}
                  />
                ))}
                {/* 空いているところを押すと、その時刻の予定を作る。 */}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`${day.month}月${day.day}日に予定を作成`}
                  className="absolute inset-0 cursor-default"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const minutes = ((event.clientY - rect.top) / HOUR) * 60;
                    onCreateAt(day, Math.floor(minutes / 30) * 30);
                  }}
                />
                {(timed[index] ?? []).map((entry) => {
                  const top = (entry.start / 60) * HOUR;
                  const height = Math.max(
                    ((entry.end - entry.start) / 60) * HOUR,
                    18,
                  );
                  const overlapped = entry.columns > 1;
                  const item = entry.item;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={(event) => onSelect(item, event.currentTarget)}
                      className={cn(
                        "absolute flex flex-col items-stretch justify-start overflow-hidden rounded-md border-l-[3px] px-2 py-0.5 text-left text-xs",
                        item.pending && "border border-l-[3px] border-dashed",
                        selectedKey === item.key && "ring-2 ring-ring",
                      )}
                      style={{
                        top: top + 1,
                        height: height - 2,
                        // 重なる予定は少しずらして重ねる (後の列が手前)。
                        left: overlapped
                          ? `calc(${(entry.column * 30) / Math.max(1, entry.columns - 1)}% + 3px)`
                          : 3,
                        width: overlapped
                          ? "calc(70% - 6px)"
                          : "calc(100% - 8px)",
                        zIndex: entry.column + 1,
                        boxShadow: overlapped
                          ? "0 0 0 1.5px var(--background)"
                          : undefined,
                        ...eventStyle(item),
                      }}
                    >
                      <span className="flex items-center gap-1 font-medium">
                        <span
                          className={cn(
                            "truncate",
                            item.declined && "opacity-50",
                          )}
                        >
                          {itemTitle(item)}
                        </span>
                        {item.repeating && (
                          <RepeatIcon className="size-3 shrink-0 opacity-60" />
                        )}
                      </span>
                      {height > 30 && (
                        <span className="block truncate text-muted-foreground tabular-nums">
                          {formatTime(item.local.start)}〜
                          {formatTime(item.local.end)}
                          {item.event.location && height > 50
                            ? ` · ${item.event.location}`
                            : ""}
                        </span>
                      )}
                      {item.pending && height > 44 && (
                        <span className="block text-muted-foreground">
                          返事をしていません
                        </span>
                      )}
                    </button>
                  );
                })}
                {isToday && (
                  <div
                    className="pointer-events-none absolute right-0 left-0 z-20 flex items-center"
                    style={{ top: ((now.hour * 60 + now.minute) / 60) * HOUR }}
                  >
                    <span
                      className="-ml-1.5 size-3 rounded-full"
                      style={{ background: CALENDAR_BRAND }}
                    />
                    <span
                      className="h-0.5 flex-1"
                      style={{ background: CALENDAR_BRAND }}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <div className="w-3 shrink-0" />
        </div>
      </div>
    </div>
  );
}
