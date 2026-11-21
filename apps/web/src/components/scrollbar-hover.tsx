"use client";

import { useEffect } from "react";
import {
  overScrollbar,
  SCROLLBAR_HOVER_ATTRIBUTE,
} from "@/lib/scrollbar-hover";

/**
 * スクロールバーにカーソルが乗っている要素に目印の属性を付ける。
 * CSS だけでは「つまみ」に乗ったときしか分からず、バーの空いている部分に乗っても太くならないため。
 * 描画はせず、ページ全体で 1 つだけ置く。
 */
export function ScrollbarHover() {
  useEffect(() => {
    let current: Element | null = null;
    const set = (next: Element | null) => {
      if (next === current) return;
      current?.removeAttribute(SCROLLBAR_HOVER_ATTRIBUTE);
      next?.setAttribute(SCROLLBAR_HOVER_ATTRIBUTE, "");
      current = next;
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        set(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const over = overScrollbar(event, {
        left: rect.left,
        top: rect.top,
        clientLeft: target.clientLeft,
        clientTop: target.clientTop,
        clientWidth: target.clientWidth,
        clientHeight: target.clientHeight,
        offsetWidth: target.offsetWidth,
        offsetHeight: target.offsetHeight,
      });
      set(over ? target : null);
    };
    const onLeave = () => set(null);
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      set(null);
    };
  }, []);
  return null;
}
