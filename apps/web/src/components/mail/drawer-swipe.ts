"use client";

import { type RefObject, useEffect, useRef } from "react";
import {
  drawerMode,
  drawerOffset,
  drawerSettlesOpen,
  startsDrawerOpen,
} from "@/lib/drawer-swipe";
import { swipeAxis } from "@/lib/swipe";

type Gesture = {
  id: number;
  startX: number;
  startY: number;
  /** 閉じた状態から開こうとしているか (false は、開いた状態から閉じようとしている)。 */
  opening: boolean;
  /** 横の動きと決まり、ドロワーを指に合わせて動かしているか。 */
  dragging: boolean;
  width: number;
  offset: number;
  lastX: number;
  lastTime: number;
  velocity: number;
};

/**
 * スマホ幅で、サイドバー (ドロワー) を指のスワイプで開閉する。
 * - 閉じているとき: 画面の左端から右へスワイプすると、指に付いて出てくる。
 * - 開いているとき: ドロワーや、その外の暗い部分を左へスワイプすると閉じる。
 * 離したときに半分より開いていれば開き、そうでなければ閉じる (素早く払えばその向き)。
 * 動かしている間の位置は、指に遅れないよう要素へ直接書く。
 */
export function useDrawerSwipe({
  asideRef,
  backdropRef,
  open,
  onOpenChange,
  disabled = false,
}: {
  asideRef: RefObject<HTMLElement | null>;
  /** ドロワーの外を暗くする要素。動かしている間、開き具合に合わせて濃さを変える。 */
  backdropRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  const openRef = useRef(open);
  openRef.current = open;
  const changeRef = useRef(onOpenChange);
  changeRef.current = onOpenChange;

  useEffect(() => {
    if (disabled) return;
    let gesture: Gesture | null = null;

    const find = (touches: TouchList, id: number) => {
      for (const touch of touches) if (touch.identifier === id) return touch;
      return null;
    };

    /** 動かしている間に要素へ直接書いた見た目を消し、クラスの指定に戻す。 */
    const release = () => {
      const aside = asideRef.current;
      if (aside) {
        aside.style.translate = "";
        aside.style.transition = "";
        aside.style.visibility = "";
      }
      const backdrop = backdropRef.current;
      if (backdrop) {
        backdrop.style.display = "";
        backdrop.style.opacity = "";
      }
    };

    const place = (state: Gesture) => {
      const aside = asideRef.current;
      if (!aside) return;
      aside.style.transition = "none";
      aside.style.visibility = "visible";
      // Tailwind の translate-x-* は translate プロパティなので、同じプロパティで上書きする。
      aside.style.translate = `${state.offset}px 0`;
      const backdrop = backdropRef.current;
      if (backdrop) {
        backdrop.style.display = "block";
        backdrop.style.opacity = String(1 + state.offset / state.width);
      }
    };

    const onStart = (event: TouchEvent) => {
      gesture = null;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const aside = asideRef.current;
      if (!touch || !aside || !drawerMode(window.innerWidth)) return;
      const opening = !openRef.current;
      // ダイアログやメニューを開いている間は、その下のドロワーを開かない。
      if (
        opening &&
        document.querySelector(
          '[role="dialog"], [role="menu"], [data-menu-sheet]',
        )
      ) {
        return;
      }
      if (opening && !startsDrawerOpen(touch.clientX, window.innerWidth)) {
        return;
      }
      gesture = {
        id: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        opening,
        dragging: false,
        width: aside.offsetWidth,
        offset: opening ? -aside.offsetWidth : 0,
        lastX: touch.clientX,
        lastTime: event.timeStamp,
        velocity: 0,
      };
    };

    const onMove = (event: TouchEvent) => {
      const state = gesture;
      if (!state) return;
      const touch = find(event.touches, state.id);
      if (!touch) return;
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      if (!state.dragging) {
        const axis = swipeAxis(dx, dy);
        if (axis === null) return;
        // 縦の動き (スクロール) と、開閉と逆向きの動きは対象にしない。
        if (axis === "y" || (state.opening ? dx <= 0 : dx >= 0)) {
          gesture = null;
          return;
        }
        state.dragging = true;
        // 向きを決めるまでに動いた分は、位置に含めない (急に飛ばないように)。
        state.startX = touch.clientX;
      }
      // ブラウザーの「端からスワイプで戻る」や、下の画面のスクロールを止める。
      if (event.cancelable) event.preventDefault();
      const elapsed = event.timeStamp - state.lastTime;
      if (elapsed > 0) {
        state.velocity = (touch.clientX - state.lastX) / elapsed;
        state.lastX = touch.clientX;
        state.lastTime = event.timeStamp;
      }
      state.offset = drawerOffset(
        touch.clientX - state.startX,
        state.width,
        state.opening,
      );
      place(state);
    };

    const onEnd = (event: TouchEvent) => {
      const state = gesture;
      if (!state || find(event.touches, state.id)) return;
      gesture = null;
      if (!state.dragging) return;
      const settled =
        event.type === "touchcancel"
          ? !state.opening
          : drawerSettlesOpen(state.offset, state.width, state.velocity);
      release();
      if (settled !== openRef.current) changeRef.current(settled);
    };

    // ドロワーを動かしたあとに指を離した場所の、クリック (メールを開くなど) を止める。
    const options = { capture: true } as const;
    document.addEventListener("touchstart", onStart, {
      capture: true,
      passive: true,
    });
    // スクロールを止めるため、passive でない登録が要る。
    document.addEventListener("touchmove", onMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchend", onEnd, options);
    document.addEventListener("touchcancel", onEnd, options);
    return () => {
      document.removeEventListener("touchstart", onStart, options);
      document.removeEventListener("touchmove", onMove, options);
      document.removeEventListener("touchend", onEnd, options);
      document.removeEventListener("touchcancel", onEnd, options);
      release();
    };
  }, [asideRef, backdropRef, disabled]);
}
