"use client";

/**
 * 一覧とメールの表示の境目のつまみ。ドラッグか矢印キーで一覧の大きさを変える。
 * horizontal は一覧の右端 (幅を変える)、vertical は一覧の下端 (高さを変える)。
 * 置き場所 (一覧の枠) は relative にしておく。
 */
export function PaneResizer({
  size,
  min,
  direction,
  onChange,
}: {
  /** いまの一覧の幅か高さ (px)。 */
  size: number;
  min: number;
  direction: "horizontal" | "vertical";
  onChange: (size: number) => void;
}) {
  const horizontal = direction === "horizontal";
  return (
    // biome-ignore lint/a11y/useSemanticElements: 大きさを変えるつまみは hr では作れない
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={horizontal ? "メール一覧の幅" : "メール一覧の高さ"}
      aria-valuenow={size}
      aria-valuemin={min}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const target = event.currentTarget;
        const start = horizontal ? event.clientX : event.clientY;
        // 画面の大きさで抑えられている (max-width など) ときは、見えている大きさから動かし始める。
        const rect = target.parentElement?.getBoundingClientRect();
        const startSize = rect ? (horizontal ? rect.width : rect.height) : size;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          const now = horizontal ? moveEvent.clientX : moveEvent.clientY;
          onChange(Math.max(min, Math.round(startSize + now - start)));
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
        const [less, more] = horizontal
          ? ["ArrowLeft", "ArrowRight"]
          : ["ArrowUp", "ArrowDown"];
        const delta =
          event.key === less ? -step : event.key === more ? step : 0;
        if (delta === 0) return;
        event.preventDefault();
        onChange(Math.max(min, size + delta));
      }}
      className={
        horizontal
          ? "absolute inset-y-0 -right-1 z-30 hidden w-2 cursor-col-resize outline-none hover:bg-primary/30 focus-visible:bg-primary/40 lg:block"
          : "absolute inset-x-0 -bottom-1 z-30 hidden h-2 cursor-row-resize outline-none hover:bg-primary/30 focus-visible:bg-primary/40 lg:block"
      }
    />
  );
}
