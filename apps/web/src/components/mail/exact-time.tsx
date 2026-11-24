"use client";

import { cn } from "cn";
import type { ReactNode } from "react";
import { Hint } from "@/components/hint";
import { useDateStyle } from "@/lib/date-format-settings";
import { formatExactDate } from "@/lib/format";

/**
 * 短く出した日時 (一覧の 09:35 など)。カーソルを合わせると、長い日付と長い時刻の
 * 正確な日時を説明 (ツールチップ) で出す。形式は設定「日付と時刻」に従う。
 */
export function ExactTime({
  value,
  className,
  children,
}: {
  /** ISO 8601 の日時。 */
  value: string;
  className?: string;
  /** 画面に出す短い日時。 */
  children: ReactNode;
}) {
  const style = useDateStyle();
  return (
    <Hint label={formatExactDate(value, style)}>
      <time dateTime={value} className={cn("cursor-default", className)}>
        {children}
      </time>
    </Hint>
  );
}
