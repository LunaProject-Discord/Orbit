"use client";

import { cn } from "cn";
import { CalendarIcon } from "lucide-react";
import { useRef, useState } from "react";
import { ja } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD の文字列を、端末の時刻帯のその日の 0 時にする。形が違えば undefined。 */
export function parseDateValue(value: string): Date | undefined {
  const match = DATE.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(year, month - 1, day);
  // 2 月 30 日のような、暦に無い日は受け付けない。
  return date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : undefined;
}

/** 日付を YYYY-MM-DD の文字列にする (端末の時刻帯)。 */
export function formatDateValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const display = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 日付を 1 つ選ぶ欄。押すとカレンダーが開く。
 * 値は YYYY-MM-DD の文字列で、未指定は空文字。
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "指定なし",
  className,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
  /** 選べる範囲の始まりと終わり (YYYY-MM-DD)。 */
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const calendar = useRef<HTMLDivElement>(null);
  const selected = parseDateValue(value);
  const after = min ? parseDateValue(min) : undefined;
  const before = max ? parseDateValue(max) : undefined;
  const label = props["aria-label"];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            {...props}
            // 読み上げでは、欄の名前に続けて選んである日付を伝える。
            aria-label={
              label
                ? `${label}: ${selected ? display.format(selected) : placeholder}`
                : undefined
            }
            className={cn(
              "justify-start gap-1.5 px-2 font-normal tabular-nums",
              !selected && "text-muted-foreground",
              className,
            )}
          />
        }
      >
        <CalendarIcon className="text-muted-foreground" aria-hidden="true" />
        <span className="truncate">
          {selected ? display.format(selected) : placeholder}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // 開いたら、選んである日 (無ければ今日) にフォーカスを置き、矢印キーですぐ動かせるようにする。
        initialFocus={() =>
          calendar.current?.querySelector<HTMLElement>(
            'button[data-day][tabindex="0"]',
          ) ?? true
        }
        className="w-auto gap-0 p-0"
      >
        <PopoverTitle className="sm:sr-only">
          {label ? `${label}を選ぶ` : "日付を選ぶ"}
        </PopoverTitle>
        <div ref={calendar} className="max-sm:flex max-sm:justify-center">
          <Calendar
            mode="single"
            locale={ja}
            selected={selected}
            defaultMonth={selected ?? before ?? after}
            disabled={[
              ...(after ? [{ before: after }] : []),
              ...(before ? [{ after: before }] : []),
            ]}
            onSelect={(date) => {
              onChange(date ? formatDateValue(date) : "");
              setOpen(false);
            }}
          />
        </div>
        <div className="flex items-center justify-between border-t p-2 max-sm:px-0">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="max-sm:h-10 max-sm:px-4 max-sm:text-sm"
            disabled={!selected}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            クリア
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="max-sm:h-10 max-sm:px-4 max-sm:text-sm"
            onClick={() => {
              const today = new Date();
              const outside =
                (after && today < after) || (before && today > before);
              if (!outside) onChange(formatDateValue(today));
              setOpen(false);
            }}
          >
            今日
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
