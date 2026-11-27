"use client";

import { cn } from "cn";

/**
 * いくつかの中から 1 つを選ぶ、横並びの切り替え (地が bg-muted の丸い箱、高さ 36px)。
 * Calendar の日/週/月の切り替えなどで使う。fill なら幅いっぱいに等分して並べる。
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  fill = false,
  className,
}: {
  items: readonly { value: T; label: string }[];
  /** 選んでいる項目。null ならどれも選んでいない見た目にする。 */
  value: T | null;
  onChange: (value: T) => void;
  /** まとまりの読み上げ用の名前。 */
  label: string;
  fill?: boolean;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: ボタンのまとまり (fieldset は見た目の既定が多い)
    <div
      role="group"
      aria-label={label}
      // デスクトップ版で上部の行 (タイトルバー) に置いたとき、ボタンの間の余白でウィンドウを動かさない。
      data-titlebar-nodrag=""
      className={cn(
        "shrink-0 rounded-lg bg-muted p-1",
        fill ? "grid auto-cols-fr grid-flow-col" : "flex",
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onChange(item.value)}
          className={cn(
            "flex h-7 items-center justify-center rounded-md px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            item.value === value
              ? "bg-background font-medium shadow-xs"
              : "text-muted-foreground pointer-fine:hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
