"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import {
  autoScrollStep,
  BAND_THRESHOLD,
  type BandMode,
  type BandRect,
  type BandRow,
  bandMode,
  bandRect,
  combineBand,
  rowsInBand,
  sameSelection,
} from "@/lib/rubber-band";

/** この印を付けた要素の上から始めたドラッグでは、範囲選択をしない。 */
export const BAND_IGNORE_ATTRIBUTE = "data-band-ignore";

type Options = {
  /** 一覧をスクロールさせている要素。ここで押したマウスのドラッグを範囲選択にする。 */
  scrollRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** 選べる行の、スクロールする中身の中での縦の位置 (仮想化で描画していない行も含む)。 */
  getRows: () => BandRow[];
  /** 今の選択。 */
  getSelected: () => ReadonlySet<string>;
  /**
   * 選択が変わったとき。anchor は、続けて Shift クリックしたときの起点にする行
   * (ドラッグを始めた位置にいちばん近い、掛かった行)。
   */
  onChange: (next: Set<string>, anchor: string | null) => void;
};

type Drag = {
  pointerId: number;
  mode: BandMode;
  base: ReadonlySet<string>;
  /** 始点 (スクロールする中身の中での位置)。 */
  start: { x: number; y: number };
  /** 今のカーソルの位置 (画面上の位置)。スクロールで中身の中の位置が変わるので、画面上で持つ。 */
  client: { x: number; y: number };
  started: boolean;
  last: ReadonlySet<string>;
  frame: number;
};

/** 入力欄やリンクなど、押したときの通常の動きを残すもの。 */
function ignoresBand(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return (
    target.closest(
      `input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"], [${BAND_IGNORE_ATTRIBUTE}]`,
    ) !== null
  );
}

/**
 * マウスのドラッグで四角を描き、掛かった行を選ぶ (PC のデスクトップと同じ操作)。
 * 行の上からでも、行の無い余白からでも始められる。何も押さずに描くと掛かった行だけ、
 * Shift で今の選択に加え、Ctrl / ⌘ で掛かった行の選択を反転する。
 * 枠の上下の端へカーソルを寄せると、一覧を自動でスクロールする。
 * 指やペンの操作は、スクロールやスワイプに任せるので対象にしない。
 * 描いている四角を返す (描いていなければ null)。
 */
export function useRubberBand({
  scrollRef,
  enabled,
  getRows,
  getSelected,
  onChange,
}: Options): BandRect | null {
  const [band, setBand] = useState<BandRect | null>(null);
  const latest = useRef({ getRows, getSelected, onChange });
  latest.current = { getRows, getSelected, onChange };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !enabled) return;
    let drag: Drag | null = null;

    /** 画面上の位置を、スクロールする中身の中での位置にする (中身の外へははみ出させない)。 */
    const toContent = (client: { x: number; y: number }) => {
      const rect = element.getBoundingClientRect();
      const x = client.x - rect.left + element.scrollLeft;
      const y = client.y - rect.top + element.scrollTop;
      return {
        x: Math.min(Math.max(x, 0), element.clientWidth),
        // 四角が中身より下へはみ出すと、スクロールできる範囲が伸びてしまう。
        y: Math.min(Math.max(y, 0), element.scrollHeight),
      };
    };

    const update = () => {
      if (!drag?.started) return;
      const current = toContent(drag.client);
      setBand(bandRect(drag.start, current));
      const hit = rowsInBand(latest.current.getRows(), drag.start.y, current.y);
      const next = combineBand(drag.base, hit, drag.mode);
      if (sameSelection(next, drag.last)) return;
      drag.last = next;
      // 始点にいちばん近い行を、次の Shift クリックの起点にする。
      const anchor = (current.y >= drag.start.y ? hit[0] : hit.at(-1)) ?? null;
      latest.current.onChange(next, anchor);
    };

    // 枠の上下の端にカーソルがある間は、毎フレーム少しずつスクロールする。
    const tick = () => {
      if (!drag) return;
      const rect = element.getBoundingClientRect();
      const step = autoScrollStep(drag.client.y, rect.top, rect.bottom);
      if (step !== 0) {
        const before = element.scrollTop;
        element.scrollTop = before + step;
        if (element.scrollTop !== before) update();
      }
      drag.frame = requestAnimationFrame(tick);
    };

    const finish = () => {
      if (!drag) return;
      cancelAnimationFrame(drag.frame);
      const started = drag.started;
      drag = null;
      setBand(null);
      document.documentElement.style.removeProperty("user-select");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      element.removeEventListener("scroll", update);
      if (!started) return;
      // ドラッグの終わりに起きるクリックで、行を開いたりチェックを切り替えたりしないようにする。
      const swallow = (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(
        () => window.removeEventListener("click", swallow, { capture: true }),
        0,
      );
    };

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.client = { x: event.clientX, y: event.clientY };
      if (!drag.started) {
        const now = toContent(drag.client);
        const distance = Math.hypot(now.x - drag.start.x, now.y - drag.start.y);
        if (distance < BAND_THRESHOLD) return;
        drag.started = true;
        // 枠の外 (ウィンドウの外も) でボタンを離しても受け取れるようにする。
        try {
          element.setPointerCapture(drag.pointerId);
        } catch {
          // 既にボタンを離していれば取れないが、そのときは pointerup で終わる。
        }
        // ドラッグ中に文字が選ばれないようにする。
        document.documentElement.style.setProperty("user-select", "none");
        window.getSelection()?.removeAllRanges();
        drag.frame = requestAnimationFrame(tick);
      }
      update();
    };

    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      finish();
    };

    const onCancel = () => {
      // 取り消されたら、ドラッグを始める前の選択に戻す。
      if (drag?.started) latest.current.onChange(new Set(drag.base), null);
      finish();
    };

    // Esc で範囲選択を取り消す。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag?.started) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (!event.isPrimary || drag) return;
      if (ignoresBand(event.target)) return;
      // スクロールバーの上で押したときは、スクロールの操作に任せる。
      if (
        event.target === element &&
        event.clientX - element.getBoundingClientRect().left >=
          element.clientWidth
      ) {
        return;
      }
      drag = {
        pointerId: event.pointerId,
        mode: bandMode(event),
        base: latest.current.getSelected(),
        start: toContent({ x: event.clientX, y: event.clientY }),
        client: { x: event.clientX, y: event.clientY },
        started: false,
        last: latest.current.getSelected(),
        frame: 0,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKeyDown, true);
      element.addEventListener("scroll", update, { passive: true });
    };

    element.addEventListener("pointerdown", onDown);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      finish();
    };
  }, [scrollRef, enabled]);

  return band;
}
