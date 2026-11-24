"use client";

import { cn } from "cn";
import type { ReactNode } from "react";
import { Hint } from "@/components/hint";
import { type DateStyle, formatExactDate } from "@/lib/format";

/**
 * 短く出した日時 (一覧の 09:35 など)。カーソルを合わせると、年月日・曜日・秒までの
 * 正確な日時を説明 (ツールチップ) で出す。
 */
export function ExactTime({
  value,
  style,
  className,
  children,
}: {
  /** ISO 8601 の日時。 */
  value: string;
  /** 12 時間制などの設定。 */
  style?: DateStyle;
  className?: string;
  /** 画面に出す短い日時。 */
  children: ReactNode;
}) {
  return (
    <Hint label={formatExactDate(value, style)}>
      <time dateTime={value} className={cn("cursor-default", className)}>
        {children}
      </time>
    </Hint>
  );
}
