"use client";

import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  insideSidewaysScroller,
  insideTextField,
  shouldCommit,
  swipeAxis,
  swipeThreshold,
} from "@/lib/swipe";

/** 開いているメールを、ある向きへスワイプしたときに行うこと。 */
export type MessageSwipeSide = {
  /** 後ろに出す文言とアイコン。 */
  label: string;
  icon: LucideIcon;
  /** 離せば行う位置まで来たときの色。 */
  color: string;
  /** 表示中のメールが画面から無くなる (別のメールへ移る、削除するなど) か。 */
  exits: boolean;
  run: () => void;
};

type Direction = "left" | "right";

/**
 * 本文の iframe の中の文書を、スワイプを受け取る対象に加える。
 * 指の動きは iframe の外へ伝わらないので、iframe の中にも同じ処理を登録する。
 * 戻り値を呼ぶと登録を外す。スワイプできない場所では null。
 */
export const SwipeSurfaceContext = createContext<
  ((surface: Document) => () => void) | null
>(null);

/** 指を離したあと、元の位置へ戻る / 画面の外へ出るまでの時間 (ms)。 */
const SETTLE_MS = 180;
/** トラックパッドの横スクロールが止まったとみなすまでの時間 (ms)。 */
const WHEEL_END_MS = 110;
/** 操作のあと、指を離したあとも続く慣性のスクロールを無視する時間 (ms)。 */
const WHEEL_COOLDOWN_MS = 400;
/** 画面の端から始めた動きは、端末の「戻る」などの操作に任せる (px)。 */
const EDGE_PX = 20;
/** その向きに行うことが無いときに、指に対して動かす割合。 */
const RESIST = 0.15;

function motionOff(): boolean {
  return (
    document.documentElement.dataset.motion === "off" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type Props = {
  /** 左へスワイプしたときに行うこと。null なら、少しだけ動いて戻る。 */
  left: MessageSwipeSide | null;
  right: MessageSwipeSide | null;
  /** スワイプを受け付けない。 */
  disabled?: boolean;
  /** トラックパッドの横スクロール (2 本指の横の動き) でも操作する。 */
  wheel?: boolean;
  /** 表示中のメールを表す値。変わったら、ずらした位置を戻す。 */
  resetKey: string;
  children: ReactNode;
};

/**
 * 開いているメールを左右にスワイプして操作するための枠。中身を指に合わせて横へずらし、
 * 後ろに何をするかを出す。十分にずらして離すと行う。縦の動きはスクロールに任せる。
 *
 * 一覧の行 (SwipeRow) と違い、本文の iframe の上でも受け取れるように touch イベントを使う
 * (iframe の中の文書にも SwipeSurfaceContext 経由で登録する)。
 */
export function MessageSwipe({
  left,
  right,
  disabled = false,
  wheel = false,
  resetKey,
  children,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{
    direction: Direction;
    armed: boolean;
  } | null>(null);

  const latest = useRef({ left, right, disabled, wheel });
  latest.current = { left, right, disabled, wheel };

  const gesture = useRef<{
    id: number;
    startX: number;
    startY: number;
    target: EventTarget | null;
    locked: boolean;
    lastX: number;
    lastTime: number;
    velocity: number;
  } | null>(null);
  const offsetRef = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** スワイプで別のメールへ移ったときに、新しいメールが入ってくる向き。 */
  const entering = useRef<Direction | null>(null);
  const wheelState = useRef({
    active: false,
    endTimer: null as ReturnType<typeof setTimeout> | null,
    coolUntil: 0,
  });

  const width = () => rootRef.current?.offsetWidth ?? 0;

  const place = (offset: number, animate: boolean) => {
    offsetRef.current = offset;
    const content = contentRef.current;
    if (!content) return;
    content.style.transition =
      animate && !motionOff() ? `transform ${SETTLE_MS}ms ease-out` : "";
    content.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
  };

  const show = (offset: number, vibrate: boolean) => {
    if (offset === 0) {
      setShown(null);
      return;
    }
    const direction: Direction = offset < 0 ? "left" : "right";
    const armed =
      latest.current[direction] !== null &&
      Math.abs(offset) >= swipeThreshold(width());
    setShown((current) => {
      if (current?.direction === direction && current.armed === armed) {
        return current;
      }
      if (armed && vibrate && !current?.armed) {
        try {
          navigator.vibrate?.(8);
        } catch {
          // 振動できなくても、色で分かる。
        }
      }
      return { direction, armed };
    });
  };

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

  const commit = (direction: Direction) => {
    const side = latest.current[direction];
    if (!side) {
      settle();
      return;
    }
    if (!side.exits) {
      settle();
      side.run();
      return;
    }
    // 画面の外まで送り出してから行う。
    if (settleTimer.current) clearTimeout(settleTimer.current);
    place(direction === "left" ? -width() : width(), true);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      entering.current = direction;
      latest.current[direction]?.run();
      // 表示が変わらなかった (移り先が無くなっていたなど) ときは、元の位置へ戻す。
      settleTimer.current = setTimeout(() => {
        entering.current = null;
        settle();
      }, 400);
    }, SETTLE_MS);
  };

  /** 指の位置に合わせてずらす量。行うことが無い向きへは、少しだけ動かす。 */
  const offsetFor = (delta: number, limit: number) => {
    const side = delta < 0 ? latest.current.left : latest.current.right;
    if (!side) return delta * RESIST;
    return Math.min(limit, Math.max(-limit, delta));
  };

  // 別のメールへ移ったら、ずらした位置を戻す。スワイプで移ったときは、反対側から入ってくる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 表示中のメールが変わったときだけ行う
  useLayoutEffect(() => {
    gesture.current = null;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    const from = entering.current;
    entering.current = null;
    place(0, false);
    setShown(null);
    const content = contentRef.current;
    if (from && content && !motionOff()) {
      content.animate(
        [
          {
            transform: `translateX(${from === "left" ? 48 : -48}px)`,
            opacity: 0.4,
          },
          { transform: "translateX(0)", opacity: 1 },
        ],
        { duration: SETTLE_MS, easing: "ease-out" },
      );
    }
  }, [resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 受け付けなくなったときだけ行う
  useEffect(() => {
    if (!disabled) return;
    gesture.current = null;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    place(0, false);
    setShown(null);
  }, [disabled]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      const state = wheelState.current;
      if (state.endTimer) clearTimeout(state.endTimer);
    },
    [],
  );

  // 中で使う値や関数は、ref 経由で最新のものを読む。
  const handlers = useRef({
    touchStart: (_event: TouchEvent) => {},
    touchMove: (_event: TouchEvent) => {},
    touchEnd: (_event: TouchEvent) => {},
    wheel: (_event: WheelEvent) => {},
  });
  handlers.current = {
    touchStart: (event) => {
      const state = latest.current;
      const touch = event.touches[0];
      // 2 本指 (拡大など) は対象にしない。
      if (event.touches.length !== 1 || !touch) {
        if (gesture.current?.locked) settle();
        gesture.current = null;
        return;
      }
      if (state.disabled || (!state.left && !state.right)) return;
      if (settleTimer.current) return;
      // 位置は画面を基準に読む (iframe の中と外で同じになり、中身をずらしても変わらない)。
      const x = touch.screenX - window.screenX;
      if (x < EDGE_PX || x > window.innerWidth - EDGE_PX) return;
      gesture.current = {
        id: touch.identifier,
        startX: touch.screenX,
        startY: touch.screenY,
        target: event.target,
        locked: false,
        lastX: touch.screenX,
        lastTime: event.timeStamp,
        velocity: 0,
      };
    },
    touchMove: (event) => {
      const state = gesture.current;
      if (!state) return;
      const touch = Array.from(event.touches).find(
        (item) => item.identifier === state.id,
      );
      if (!touch || event.touches.length !== 1) {
        gesture.current = null;
        if (state.locked) settle();
        return;
      }
      const dx = touch.screenX - state.startX;
      const dy = touch.screenY - state.startY;
      if (!state.locked) {
        const axis = swipeAxis(dx, dy);
        if (axis === null) return;
        if (
          axis === "y" ||
          insideTextField(state.target) ||
          insideSidewaysScroller(state.target, rootRef.current) ||
          // 文字を選んでいる途中は、選択の操作に任せる。
          hasSelection(state.target)
        ) {
          gesture.current = null;
          return;
        }
        state.locked = true;
      }
      // 横のスワイプの間は、縦へスクロールさせない。
      if (event.cancelable) event.preventDefault();
      const elapsed = event.timeStamp - state.lastTime;
      if (elapsed > 0) {
        state.velocity = (touch.screenX - state.lastX) / elapsed;
        state.lastX = touch.screenX;
        state.lastTime = event.timeStamp;
      }
      const offset = offsetFor(dx, width());
      place(offset, false);
      show(offset, true);
    },
    touchEnd: (event) => {
      const state = gesture.current;
      if (!state) return;
      // ほかの指を離しただけなら続ける。
      if (
        Array.from(event.touches).some((item) => item.identifier === state.id)
      ) {
        return;
      }
      gesture.current = null;
      if (!state.locked) return;
      const offset = offsetRef.current;
      const velocity =
        event.timeStamp - state.lastTime > 100 ? 0 : state.velocity;
      const direction: Direction = offset < 0 ? "left" : "right";
      if (
        event.type === "touchend" &&
        offset !== 0 &&
        latest.current[direction] &&
        shouldCommit(offset, width(), velocity)
      ) {
        commit(direction);
      } else {
        settle();
      }
    },
    wheel: (event) => {
      const state = latest.current;
      const wheeling = wheelState.current;
      if (!state.wheel || state.disabled) return;
      if (event.ctrlKey || event.deltaMode !== 0) return;
      const finish = () => {
        if (wheeling.endTimer) clearTimeout(wheeling.endTimer);
        wheeling.endTimer = null;
        if (!wheeling.active) return;
        wheeling.active = false;
        wheeling.coolUntil = Date.now() + WHEEL_COOLDOWN_MS;
        const offset = offsetRef.current;
        const direction: Direction = offset < 0 ? "left" : "right";
        if (latest.current[direction] && shouldCommit(offset, width())) {
          commit(direction);
        } else {
          settle();
        }
      };
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5;
      if (!wheeling.active) {
        if (!horizontal || Math.abs(event.deltaX) < 2) return;
        // 操作の直後に続く慣性の分は、次の操作を始めない。
        if (Date.now() < wheeling.coolUntil) {
          event.preventDefault();
          wheeling.coolUntil = Date.now() + WHEEL_COOLDOWN_MS;
          return;
        }
        // その向きに行うことが無ければ、ブラウザーの動作 (戻る / 進むなど) に任せる。
        if (!(event.deltaX > 0 ? state.left : state.right)) return;
        if (settleTimer.current) return;
        if (
          insideTextField(event.target) ||
          insideSidewaysScroller(event.target, rootRef.current)
        ) {
          return;
        }
        wheeling.active = true;
      }
      event.preventDefault();
      const rowWidth = width();
      const armedBefore =
        Math.abs(offsetRef.current) >= swipeThreshold(rowWidth);
      // 指を左へ動かすと deltaX は正。中身は指と同じ向きへ動かす。
      // 慣性で画面の外まで飛んでいかないよう、幅の 6 割までにする。
      const offset = offsetFor(
        offsetRef.current - event.deltaX,
        rowWidth * 0.6,
      );
      // 行うことの無い向きへ戻ってきたら、そこで止める。
      const next =
        (offset < 0 ? state.left : state.right) === null ? 0 : offset;
      place(next, false);
      show(next, false);
      if (armedBefore && Math.abs(event.deltaX) < 3) {
        finish();
        return;
      }
      if (wheeling.endTimer) clearTimeout(wheeling.endTimer);
      wheeling.endTimer = setTimeout(finish, WHEEL_END_MS);
    },
  };

  /** 枠そのものや、本文の iframe の中の文書に、指とトラックパッドの動きの処理を登録する。 */
  const bind = useCallback((surface: HTMLElement | Document) => {
    const start = (event: Event) =>
      handlers.current.touchStart(event as TouchEvent);
    const move = (event: Event) =>
      handlers.current.touchMove(event as TouchEvent);
    const end = (event: Event) =>
      handlers.current.touchEnd(event as TouchEvent);
    const onWheel = (event: Event) =>
      handlers.current.wheel(event as WheelEvent);
    surface.addEventListener("touchstart", start, { passive: true });
    // スクロールを止めるため、passive でない登録が要る。
    surface.addEventListener("touchmove", move, { passive: false });
    surface.addEventListener("touchend", end);
    surface.addEventListener("touchcancel", end);
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("touchstart", start);
      surface.removeEventListener("touchmove", move);
      surface.removeEventListener("touchend", end);
      surface.removeEventListener("touchcancel", end);
      surface.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    return root ? bind(root) : undefined;
  }, [bind]);

  const side = shown ? latest.current[shown.direction] : null;
  const Icon = side?.icon;

  return (
    <SwipeSurfaceContext.Provider value={bind}>
      <div
        ref={rootRef}
        data-message-swipe=""
        data-swipe-direction={shown?.direction}
        data-swipe-armed={shown?.armed ? "" : undefined}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {shown && side && Icon && (
          <div
            aria-hidden="true"
            className={cn(
              "absolute inset-0 flex items-center gap-2 px-5 font-medium text-sm transition-colors duration-150",
              shown.direction === "left" ? "justify-end" : "justify-start",
              shown.armed ? side.color : "bg-muted text-muted-foreground",
            )}
          >
            {shown.direction === "left" && <span>{side.label}</span>}
            <Icon
              className={cn(
                "size-5 shrink-0 transition-transform duration-150",
                shown.armed && "scale-125",
              )}
            />
            {shown.direction === "right" && <span>{side.label}</span>}
          </div>
        )}
        <div
          ref={contentRef}
          className="relative flex min-h-0 flex-1 flex-col bg-background"
        >
          {children}
        </div>
      </div>
    </SwipeSurfaceContext.Provider>
  );
}

/** 触れた場所の文書で、文字を選んでいるか。 */
function hasSelection(target: EventTarget | null): boolean {
  const doc = (target as Node | null)?.ownerDocument;
  const selection = doc?.getSelection?.();
  return selection != null && !selection.isCollapsed;
}
