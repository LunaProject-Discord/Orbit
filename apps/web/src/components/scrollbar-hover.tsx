"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/native/app";
import { installOverlayScrollbars } from "@/lib/overlay-scrollbars";
import {
  OS_SCROLLBARS_ATTRIBUTE,
  overScrollbar,
  SCROLLBAR_HIDE_DELAY,
  SCROLLBAR_HOVER_ATTRIBUTE,
  SCROLLING_ATTRIBUTE,
} from "@/lib/scrollbar-hover";

/**
 * スクロールバーの表示を受け持つ。描画はせず、ページ全体で 1 つだけ置く。
 *
 * - スマホアプリ (Android / iOS) では何もせず、OS のバーのままにする。端末によっては
 *   マウスで指せる端末だと答える (hover: hover / pointer: fine) ことがあり、そのまま
 *   重ねるバーやパソコン向けのバーにすると、タッチでのスクロール中にバーが見えなくなる。
 * - 内容の上に重ねて表示するバーを有効にする (lib/overlay-scrollbars.ts)。
 * - ダイアログやメニューの中などブラウザーのバーを使う場所のために、スクロールしている要素と、
 *   バーにカーソルが乗っている要素へ目印の属性を付ける。globals.css がこの属性を見て
 *   表示したり太くしたりする (どちらも CSS だけでは分からない)。
 */
export function ScrollbarHover() {
  useEffect(() => {
    if (!isNativeApp()) return installOverlayScrollbars();
    const root = document.documentElement;
    root.setAttribute(OS_SCROLLBARS_ATTRIBUTE, "");
    return () => root.removeAttribute(OS_SCROLLBARS_ATTRIBUTE);
  }, []);
  useEffect(() => {
    if (isNativeApp()) return;
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

    // スクロールしている間と、止まってから少しの間だけ、つまみを見せる。
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target =
        event.target instanceof Document
          ? event.target.documentElement
          : event.target;
      if (!(target instanceof Element)) return;
      const timer = timers.get(target);
      if (timer) clearTimeout(timer);
      else target.setAttribute(SCROLLING_ATTRIBUTE, "");
      timers.set(
        target,
        setTimeout(() => {
          timers.delete(target);
          target.removeAttribute(SCROLLING_ATTRIBUTE);
        }, SCROLLBAR_HIDE_DELAY),
      );
    };
    // scroll は親へ伝わらないので、伝わる前 (capture) に受け取る。
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const [target, timer] of timers) {
        clearTimeout(timer);
        target.removeAttribute(SCROLLING_ATTRIBUTE);
      }
      timers.clear();
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      set(null);
    };
  }, []);
  return null;
}
