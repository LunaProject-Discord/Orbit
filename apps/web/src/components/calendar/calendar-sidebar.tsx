"use client";

import { cn } from "cn";
import {
  CheckIcon,
  ChevronDownIcon,
  MenuIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import type { Temporal } from "temporal-polyfill";
import { AppSwitcher } from "@/components/brand/app-switcher";
import { MiniMonth } from "@/components/calendar/mini-month";
import { Button } from "@/components/ui/button";
import type { User } from "@/lib/api";
import type { Calendar } from "@/lib/calendar/api";
import type { CalendarGroup } from "@/lib/calendar/groups";

export function CalendarSidebar({
  user,
  groups,
  colorOf,
  today,
  selected,
  selectedRange,
  busyDays,
  canCreate,
  onSelectDate,
  onCreateEvent,
  onToggleCalendar,
  onAddCalendar,
  onOpenSettings,
  onToggleSidebar,
  onNavigate,
}: {
  user: User;
  groups: CalendarGroup[];
  colorOf: (calendar: Calendar) => string;
  today: Temporal.PlainDate;
  selected: Temporal.PlainDate;
  selectedRange: { from: Temporal.PlainDate; to: Temporal.PlainDate };
  busyDays: ReadonlySet<string>;
  canCreate: boolean;
  onSelectDate: (date: Temporal.PlainDate) => void;
  onCreateEvent: () => void;
  onToggleCalendar: (calendar: Calendar) => void;
  onAddCalendar: () => void;
  onOpenSettings: () => void;
  /** 広い画面でサイドバーを閉じる。null なら出さない。 */
  onToggleSidebar: (() => void) | null;
  /** アプリを切り替える前に呼ぶ。 */
  onNavigate?: () => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="relative flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        {onToggleSidebar && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="サイドバーを閉じる"
            className="text-muted-foreground"
            onClick={onToggleSidebar}
          >
            <MenuIcon className="size-5" />
          </Button>
        )}
        <AppSwitcher current="calendar" onNavigate={onNavigate} />
      </div>
      <div className="px-2 pb-2">
        <Button
          className="h-10 w-full"
          disabled={!canCreate}
          onClick={onCreateEvent}
        >
          <PlusIcon className="size-4" />
          予定を作成
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MiniMonth
          today={today}
          selected={selected}
          selectedRange={selectedRange}
          busyDays={busyDays}
          onSelect={onSelectDate}
        />
        <div className="flex flex-col gap-3 px-2 pb-4">
          {groups.map((group) => {
            const isFolded = folded.has(group.key);
            return (
              <div key={group.key}>
                <button
                  type="button"
                  aria-expanded={!isFolded}
                  onClick={() => toggleGroup(group.key)}
                  className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent"
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      isFolded && "-rotate-90",
                    )}
                  />
                  <span className="shrink-0 font-medium text-sm">
                    {group.name}
                  </span>
                  {group.sub && (
                    <span className="truncate text-muted-foreground text-xs">
                      {group.sub}
                    </span>
                  )}
                </button>
                {!isFolded &&
                  group.calendars.map((calendar) => {
                    const color = colorOf(calendar);
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: 色付きの四角を出すため、ボタンにチェックボックスの役割を持たせる
                      <button
                        key={calendar.id}
                        type="button"
                        role="checkbox"
                        aria-checked={calendar.visible}
                        onClick={() => onToggleCalendar(calendar)}
                        className="flex h-8 w-full items-center gap-2.5 rounded-md pr-2 pl-7 text-left text-sm hover:bg-sidebar-accent"
                      >
                        <span
                          className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border-2"
                          style={{
                            borderColor: color,
                            background: calendar.visible
                              ? color
                              : "transparent",
                          }}
                        >
                          {calendar.visible && (
                            <CheckIcon
                              className="size-3 text-white"
                              strokeWidth={3}
                            />
                          )}
                        </span>
                        <span
                          className={cn(
                            "flex-1 truncate",
                            !calendar.visible && "text-muted-foreground",
                          )}
                        >
                          {calendar.name}
                        </span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
          <button
            type="button"
            onClick={onAddCalendar}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground"
          >
            <PlusIcon className="size-4" />
            カレンダーを追加
          </button>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t py-3 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">{user.name}</p>
          <p className="truncate text-muted-foreground text-xs">{user.email}</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="設定"
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
