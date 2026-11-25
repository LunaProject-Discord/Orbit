"use client";

import { MIN_PANE_WIDTH } from "@/lib/table-view";

/**
 * 一覧の右端のつまみ。ドラッグか左右の矢印キーで一覧の幅を変える (テーブル表示の広い画面)。
 * 置き場所 (一覧の枠) は relative にしておく。
 */
export function PaneResizer({
  width,
  onChange,
}: {
  width: number;
  onChange: (width: number) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 幅を変えるつまみは hr では作れない
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="メール一覧の幅"
      aria-valuenow={width}
      aria-valuemin={MIN_PANE_WIDTH}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const target = event.currentTarget;
        const startX = event.clientX;
        // 画面の幅で抑えられている (maxWidth) ときは、見えている幅から動かし始める。
        const startWidth =
          target.parentElement?.getBoundingClientRect().width ?? width;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          onChange(
            Math.max(MIN_PANE_WIDTH, startWidth + moveEvent.clientX - startX),
          );
        };
        const end = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", end);
          target.removeEventListener("pointercancel", end);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", end);
        target.addEventListener("pointercancel", end);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 16;
        const delta =
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0;
        if (delta === 0) return;
        event.preventDefault();
        onChange(Math.max(MIN_PANE_WIDTH, width + delta));
      }}
      className="absolute inset-y-0 -right-1 z-30 hidden w-2 cursor-col-resize outline-none hover:bg-primary/30 focus-visible:bg-primary/40 lg:block"
    />
  );
}
