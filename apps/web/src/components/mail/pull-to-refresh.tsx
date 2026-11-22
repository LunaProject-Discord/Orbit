"use client";

import { RefreshCwIcon } from "lucide-react";
import { type RefObject, useEffect, useRef } from "react";
import { pullDistance, pullIntent, shouldRefresh } from "@/lib/pull-to-refresh";

/** 更新中の印を出しておく、いちばん短い時間 (一瞬で消えると、更新されたか分からない)。 */
const MIN_SPIN_MS = 600;
/** 更新が終わらなくても、印を片付けるまでの時間。 */
const MAX_SPIN_MS = 10_000;
/** 更新中に印を止めておく位置 (px)。 */
const HOLD = 56;

/**
 * 一覧を下へ引っ張って更新する (スマホアプリと、スマホのブラウザー)。
 * scrollRef の枠がいちばん上までスクロールされているときに、指で下へ引っ張ると印が下りてきて、
 * 十分に引いて離すと onRefresh を呼ぶ。印は、この部品を置いた枠 (position: relative) の上端に出る。
 * 印の位置は、指の動きに遅れないよう要素へ直接書く (行のスワイプと同じ)。
 */
export function PullToRefresh({
  scrollRef,
  onRefresh,
  disabled = false,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  /** 更新する。返した Promise が終わるまで、印を回しておく。 */
  onRefresh: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const markRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const scroller = scrollRef.current;
    const mark = markRef.current;
    if (!scroller || !mark || disabled) return;

    /** 指を置いた位置。null は、引っ張りの対象でない (途中までスクロールしていた、など)。 */
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    let refreshing = false;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const place = (offset: number, animate: boolean) => {
      mark.style.transition = animate
        ? "transform 0.2s ease-out, opacity 0.2s ease-out"
        : "none";
      mark.style.transform = `translate(-50%, ${offset - 44}px)`;
      mark.style.opacity = offset > 4 ? "1" : "0";
    };
    const turn = (offset: number) => {
      const icon = mark.firstElementChild as HTMLElement | null;
      if (icon) icon.style.transform = `rotate(${offset * 4}deg)`;
      mark.dataset.ready = shouldRefresh(offset) ? "true" : "false";
    };
    const reset = () => {
      distance = 0;
      pulling = false;
      start = null;
      mark.dataset.state = "idle";
      mark.dataset.ready = "false";
      place(0, true);
    };

    const onStart = (event: TouchEvent) => {
      if (refreshing || event.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      // いちばん上まで戻っているときだけ、引っ張りを受け付ける。
      start =
        touch && scroller.scrollTop <= 0
          ? { x: touch.clientX, y: touch.clientY }
          : null;
      pulling = false;
      distance = 0;
    };

    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch || refreshing) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!pulling) {
        const intent = pullIntent(dx, dy);
        if (intent === null) return;
        if (!intent || scroller.scrollTop > 0) {
          start = null;
          return;
        }
        pulling = true;
        mark.dataset.state = "pulling";
      }
      // ブラウザー自身の「引っ張って再読み込み」や、端の跳ね返りを止める。
      if (event.cancelable) event.preventDefault();
      distance = pullDistance(dy);
      place(distance, false);
      turn(distance);
    };

    const finish = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      refreshing = false;
      reset();
    };

    const onEnd = () => {
      if (!pulling) {
        start = null;
        return;
      }
      if (!shouldRefresh(distance)) {
        reset();
        return;
      }
      refreshing = true;
      pulling = false;
      start = null;
      mark.dataset.state = "refreshing";
      place(HOLD, true);
      const began = Date.now();
      // 終わらない更新で、印が回り続けないようにする。
      hideTimer = setTimeout(finish, MAX_SPIN_MS);
      void Promise.resolve()
        .then(() => refreshRef.current())
        .catch(() => {
          // 失敗の知らせは、更新する側が出す。
        })
        .then(() => {
          if (!refreshing) return;
          const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - began));
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(finish, wait);
        });
    };

    const onCancel = () => {
      if (pulling) reset();
      start = null;
    };

    scroller.addEventListener("touchstart", onStart, { passive: true });
    // スクロールを止めるため、passive でない登録が要る。
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", onCancel);
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onCancel);
      if (hideTimer) clearTimeout(hideTimer);
      mark.dataset.state = "idle";
      place(0, false);
    };
  }, [scrollRef, disabled]);

  return (
    <div
      ref={markRef}
      data-pull-to-refresh
      data-state="idle"
      data-ready="false"
      aria-hidden="true"
      className="group pointer-events-none absolute top-0 left-1/2 z-20 flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-md data-[ready=true]:text-primary data-[state=refreshing]:text-primary"
      style={{ transform: `translate(-50%, -44px)` }}
    >
      <RefreshCwIcon className="size-4 group-data-[state=refreshing]:animate-spin" />
    </div>
  );
}
