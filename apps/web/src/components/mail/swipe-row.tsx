"use client";

import { cn } from "cn";
import {
  ArchiveIcon,
  FolderInputIcon,
  type LucideIcon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  OctagonAlertIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { startsDrawerOpen } from "@/lib/drawer-swipe";
import {
  clampOffset,
  type SwipeOutcome,
  shouldCommit,
  swipeAxis,
  swipeThreshold,
} from "@/lib/swipe";

/** 操作ごとの、行の後ろに出すアイコンと色。 */
export const swipeLooks: Record<
  SwipeOutcome["kind"],
  { icon: LucideIcon; color: string }
> = {
  read: { icon: MailOpenIcon, color: "bg-sky-600 text-white" },
  unread: { icon: MailIcon, color: "bg-sky-600 text-white" },
  star: { icon: StarIcon, color: "bg-amber-500 text-white" },
  unstar: { icon: StarOffIcon, color: "bg-amber-500 text-white" },
  archive: { icon: ArchiveIcon, color: "bg-emerald-600 text-white" },
  trash: { icon: Trash2Icon, color: "bg-red-600 text-white" },
  delete: { icon: Trash2Icon, color: "bg-red-600 text-white" },
  junk: { icon: OctagonAlertIcon, color: "bg-orange-600 text-white" },
  not_junk: { icon: MailCheckIcon, color: "bg-emerald-600 text-white" },
  move: { icon: FolderInputIcon, color: "bg-violet-600 text-white" },
};

/** 指を離したあと、行が元の位置へ戻る / 画面の外へ出るまでの時間 (ms)。 */
const SETTLE_MS = 180;
/** トラックパッドの横スクロールが止まったとみなすまでの時間 (ms)。 */
const WHEEL_END_MS = 110;
/** 操作のあと、指を離したあとも続く慣性のスクロールを無視する時間 (ms)。 */
const WHEEL_COOLDOWN_MS = 250;

type Direction = "left" | "right";

type Props = {
  /** 左へスワイプしたときに行うこと。null なら、左へは動かない。 */
  left: SwipeOutcome | null;
  /** 右へスワイプしたときに行うこと。 */
  right: SwipeOutcome | null;
  /** スワイプを受け付けない (複数選択中など)。 */
  disabled?: boolean;
  /** トラックパッドの横スクロール (2 本指の横の動き) でも操作する。 */
  wheel?: boolean;
  onCommit: (outcome: SwipeOutcome) => void;
  children: ReactNode;
};

/**
 * 左右にスワイプして操作できる行。中身を指に合わせて横へずらし、後ろに操作の色と
 * アイコンを出す。十分にずらして離すと操作を行う。縦の動きは一覧のスクロールに任せる。
 *
 * ずらす量は描画し直さずに要素へ直接書く (一覧のほかの行に影響しない)。
 */
export function SwipeRow({
  left,
  right,
  disabled = false,
  wheel = false,
  onCommit,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** いま後ろに出している操作の向きと、離せば操作を行う位置まで来ているか。 */
  const [shown, setShown] = useState<{
    direction: Direction;
    armed: boolean;
  } | null>(null);

  // 指の動きの途中で設定や行の内容が変わっても、最新の値で判定する。
  const latest = useRef({ left, right, disabled, onCommit });
  latest.current = { left, right, disabled, onCommit };

  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    /** 横のスワイプと決めたか。 */
    locked: boolean;
    /** 直前の位置と時刻 (離したときの速さを求める)。 */
    lastX: number;
    lastTime: number;
    velocity: number;
  } | null>(null);
  const offsetRef = useRef(0);
  /** スワイプした直後のクリック (行を開く動作) を 1 回だけ止める。 */
  const suppressClick = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const width = () => rootRef.current?.offsetWidth ?? 0;

  const place = (offset: number, animate: boolean) => {
    offsetRef.current = offset;
    const content = contentRef.current;
    if (!content) return;
    content.style.transition = animate
      ? `transform ${SETTLE_MS}ms ease-out`
      : "";
    content.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
  };

  const show = (offset: number, viaWheel: boolean) => {
    if (offset === 0) {
      setShown(null);
      return;
    }
    const direction: Direction = offset < 0 ? "left" : "right";
    const armed = Math.abs(offset) >= swipeThreshold(width());
    setShown((current) => {
      if (current?.direction === direction && current.armed === armed) {
        return current;
      }
      // 操作を行う位置まで来たことを、対応している端末では振動でも知らせる。
      if (armed && !viaWheel && !current?.armed) {
        try {
          navigator.vibrate?.(8);
        } catch {
          // 振動できなくても、色で分かる。
        }
      }
      return { direction, armed };
    });
  };

  /** 元の位置へ戻す。 */
  const settle = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    place(0, true);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setShown(null);
      const content = contentRef.current;
      if (content) content.style.transition = "";
    }, SETTLE_MS);
  };

  /** 操作を行う。一覧から無くなる行は、画面の外まで送り出してから行う。 */
  const commit = (direction: Direction) => {
    const outcome = latest.current[direction];
    if (!outcome) {
      settle();
      return;
    }
    if (!outcome.removes) {
      settle();
      latest.current.onCommit(outcome);
      return;
    }
    if (settleTimer.current) clearTimeout(settleTimer.current);
    place(direction === "left" ? -width() : width(), true);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      latest.current.onCommit(outcome);
      // 会話の一部だけが対象だったときなど、行が残った場合は元の位置へ戻す。
      settleTimer.current = setTimeout(settle, 400);
    }, SETTLE_MS);
  };

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // 複数選択を始めたときなどは、ずらしている途中の行を元へ戻す。
  useEffect(() => {
    if (!disabled) return;
    gesture.current = null;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    offsetRef.current = 0;
    const content = contentRef.current;
    if (content) {
      content.style.transition = "";
      content.style.transform = "";
    }
    setShown(null);
  }, [disabled]);

  // トラックパッドの横スクロール。スクロールを止めるため、passive でない登録が要る。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 中で使う関数は ref 経由で最新の値を読む
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !wheel) return;
    let active = false;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let coolUntil = 0;

    const finish = () => {
      if (endTimer) clearTimeout(endTimer);
      endTimer = null;
      if (!active) return;
      active = false;
      coolUntil = Date.now() + WHEEL_COOLDOWN_MS;
      const offset = offsetRef.current;
      if (shouldCommit(offset, root.offsetWidth)) {
        commit(offset < 0 ? "left" : "right");
      } else {
        settle();
      }
    };

    const onWheel = (event: WheelEvent) => {
      const state = latest.current;
      if (state.disabled || event.ctrlKey || event.deltaMode !== 0) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5;
      if (!active) {
        if (!horizontal || Math.abs(event.deltaX) < 2) return;
        // 操作の直後に続く慣性の分は、次の操作を始めない。
        if (Date.now() < coolUntil) {
          event.preventDefault();
          coolUntil = Date.now() + WHEEL_COOLDOWN_MS;
          return;
        }
        // その向きに操作が無ければ、ブラウザーの動作 (戻る / 進むなど) に任せる。
        if (!(event.deltaX > 0 ? state.left : state.right)) return;
        if (settleTimer.current) return;
        active = true;
      }
      event.preventDefault();
      const rowWidth = root.offsetWidth;
      const armedBefore =
        Math.abs(offsetRef.current) >= swipeThreshold(rowWidth);
      // 指を左へ動かすと deltaX は正。行は指と同じ向きへ動かす。
      const offset = clampOffset(
        offsetRef.current - event.deltaX,
        // 慣性で行が画面の外まで飛んでいかないよう、幅の 6 割までにする。
        rowWidth * 0.6,
        { left: state.left !== null, right: state.right !== null },
      );
      place(offset, false);
      show(offset, true);
      // 操作を行う位置を越えたあとは、慣性の終わり (小さな動き) を待たずに決める。
      if (armedBefore && Math.abs(event.deltaX) < 3) {
        finish();
        return;
      }
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(finish, WHEEL_END_MS);
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
      if (endTimer) clearTimeout(endTimer);
    };
  }, [wheel]);

  const outcome = shown ? latest.current[shown.direction] : null;
  const look = outcome ? swipeLooks[outcome.kind] : null;
  const Icon = look?.icon;

  return (
    <div
      ref={rootRef}
      data-swipe-row=""
      data-swipe-direction={shown?.direction}
      data-swipe-armed={shown?.armed ? "" : undefined}
      // 縦の動きはブラウザーのスクロールに任せ、横の動きだけをここで受け取る。
      className="relative touch-pan-y overflow-hidden"
      onPointerDown={(event) => {
        // マウスのドラッグは対象にしない (文字の選択やクリックと紛らわしい)。
        if (event.pointerType === "mouse" || !event.isPrimary) return;
        if (disabled || (!left && !right) || settleTimer.current) return;
        // 画面の左端から始めた動きは、サイドバー (ドロワー) を開く操作に任せる。
        if (startsDrawerOpen(event.clientX, window.innerWidth)) return;
        suppressClick.current = false;
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          locked: false,
          lastX: event.clientX,
          lastTime: event.timeStamp,
          velocity: 0,
        };
      }}
      onPointerMove={(event) => {
        const state = gesture.current;
        if (!state || state.pointerId !== event.pointerId) return;
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        if (!state.locked) {
          const axis = swipeAxis(dx, dy);
          if (axis === null) return;
          if (axis === "y") {
            gesture.current = null;
            return;
          }
          state.locked = true;
          suppressClick.current = true;
          // 指が行の外へ出ても、離すまでこの行で受け取る。
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // 受け取れなくても、行の中で動かしている間は操作できる。
          }
        }
        const elapsed = event.timeStamp - state.lastTime;
        if (elapsed > 0) {
          state.velocity = (event.clientX - state.lastX) / elapsed;
          state.lastX = event.clientX;
          state.lastTime = event.timeStamp;
        }
        const offset = clampOffset(dx, width(), {
          left: left !== null,
          right: right !== null,
        });
        place(offset, false);
        show(offset, false);
      }}
      onPointerUp={(event) => {
        const state = gesture.current;
        if (!state || state.pointerId !== event.pointerId) return;
        gesture.current = null;
        if (!state.locked) return;
        const offset = offsetRef.current;
        // 指を止めてから離したときは、払った扱いにしない。
        const velocity =
          event.timeStamp - state.lastTime > 100 ? 0 : state.velocity;
        if (offset !== 0 && shouldCommit(offset, width(), velocity)) {
          commit(offset < 0 ? "left" : "right");
        } else {
          settle();
        }
      }}
      onPointerCancel={(event) => {
        // ブラウザーが縦のスクロールを始めた、長押しのメニューが開いた、など。
        const state = gesture.current;
        if (!state || state.pointerId !== event.pointerId) return;
        gesture.current = null;
        if (state.locked) settle();
      }}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenuCapture={(event) => {
        // スワイプの途中の長押しでは、メニューを開かない。
        if (gesture.current?.locked) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {shown && outcome && look && Icon && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0 flex items-center gap-2 px-5 font-medium text-sm transition-colors duration-150",
            shown.direction === "left" ? "justify-end" : "justify-start",
            shown.armed ? look.color : "bg-muted text-muted-foreground",
          )}
        >
          {shown.direction === "left" && <span>{outcome.label}</span>}
          <Icon
            className={cn(
              "size-5 shrink-0 transition-transform duration-150",
              shown.armed && "scale-125",
            )}
          />
          {shown.direction === "right" && <span>{outcome.label}</span>}
        </div>
      )}
      <div ref={contentRef} className="relative bg-background">
        {children}
      </div>
    </div>
  );
}
