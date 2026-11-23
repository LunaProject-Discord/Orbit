"use client";

import { ChevronLeftIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SHEET_QUERY,
  sheetDismisses,
  sheetDragIntent,
  sheetOffset,
} from "@/lib/sheet-swipe";

/**
 * スマホ幅で、メニューやピッカーを画面の下に貼り付けるための位置の指定。
 * 部品が要素に直接書き込む位置 (style) を打ち消すので、すべて優先して効かせる。
 * 見た目は globals.css の [data-menu-sheet] で決める。
 */
export const sheetPositioner =
  "max-sm:fixed! max-sm:inset-x-0! max-sm:top-auto! max-sm:bottom-0! max-sm:w-full! max-sm:transform-none!";

/** スマホ幅でシートの後ろを暗くする幕。押すとメニューが閉じる。 */
export const sheetBackdrop =
  "fixed inset-0 z-50 bg-black/40 duration-200 sm:hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0";

/**
 * ダイアログを、スマホ幅でだけ画面の下に貼り付くシートにするクラス。
 * 高さの上限 (max-sm:max-h-*) は呼び出し側で決める。
 */
export const dialogSheet =
  "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:duration-200 max-sm:data-closed:zoom-out-100 max-sm:data-closed:slide-out-to-bottom max-sm:data-open:zoom-in-100 max-sm:data-open:slide-in-from-bottom";

/** スマホの幅 (Tailwind の sm 未満) かどうか。シートで出すかを決める。 */
export function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(SHEET_QUERY);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia(SHEET_QUERY).matches,
    () => false,
  );
}

/** 入れ子のメニューから、1 つ前のシートへ戻るための情報。 */
export const SubSheetContext = createContext<{ close: () => void } | null>(
  null,
);

/**
 * 入れ子のシートの先頭に置く「戻る」の中身。スマホ幅でだけ出す行の中で使う。
 * 行そのもの (メニューの項目) は、メニューの種類ごとに呼び出し側で用意する。
 */
export function SubSheetBackLabel({ title }: { title?: string }) {
  return (
    <>
      <ChevronLeftIcon />
      {title ?? "戻る"}
    </>
  );
}

export function useSubSheet() {
  return useContext(SubSheetContext);
}

/** シートを下へ払ったときに、閉じる方法。メニューやポップオーバーの Root が渡す。 */
export const SheetCloseContext = createContext<{ close: () => void } | null>(
  null,
);

type Closable = { close: () => void };

/**
 * Root の部品で使う。Base UI の actionsRef と、中のシートへ渡す「閉じる方法」を用意する。
 * 呼び出し側が actionsRef を渡していれば、それを使う。
 */
export function useSheetClose<Actions extends Closable>(
  given?: React.RefObject<Actions | null>,
) {
  const own = useRef<Actions | null>(null);
  const actionsRef = given ?? own;
  const value = useMemo(
    () => ({ close: () => actionsRef.current?.close() }),
    [actionsRef],
  );
  return { actionsRef, value };
}

/** 指で動かしても、シートを引き下ろさない場所か (文字の入力欄、つまみを動かす面など)。 */
function blocksSheetDrag(target: EventTarget | null, sheet: HTMLElement) {
  for (
    let element = target instanceof Element ? target : null;
    element;
    element = element === sheet ? null : element.parentElement
  ) {
    if (
      element.matches(
        'textarea, [contenteditable="true"], input[type="range"], [role="slider"], [data-sheet-no-swipe]',
      )
    ) {
      return true;
    }
    const style = getComputedStyle(element);
    if (style.touchAction === "none") return true;
    // 中身を下へ送ってあるときは、まず中身を上へ戻す動きとして扱う。
    if (
      element.scrollTop > 0 &&
      (style.overflowY === "auto" || style.overflowY === "scroll")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * スマホ幅のシートを、指で下へ払って閉じられるようにする。返す ref をシートの要素に付ける。
 * 指の動きに合わせてシートが下がり、離したときに十分下がっていれば閉じる (足りなければ戻る)。
 * 閉じる方法は、引数か、Root が渡す SheetCloseContext から受け取る。
 */
export function useSheetSwipe(onDismiss?: () => void, enabled = true) {
  const context = useContext(SheetCloseContext);
  const dismiss = useRef<(() => void) | undefined>(undefined);
  dismiss.current = onDismiss ?? context?.close;
  const [sheet, setSheet] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!sheet || !enabled) return;
    let start: { id: number; x: number; y: number } | null = null;
    let dragging = false;
    let offset = 0;
    /** 速さを測るための、少し前の位置と時刻。 */
    let previous = { y: 0, time: 0 };
    let latest = { y: 0, time: 0 };
    let settle: ReturnType<typeof setTimeout> | undefined;

    const find = (touches: TouchList) =>
      Array.from(touches).find((touch) => touch.identifier === start?.id);
    const reset = () => {
      sheet.style.transition = "";
      sheet.style.translate = "";
      delete sheet.dataset.sheetDragging;
    };

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (
        event.touches.length !== 1 ||
        !touch ||
        !window.matchMedia(SHEET_QUERY).matches ||
        blocksSheetDrag(event.target, sheet)
      ) {
        start = null;
        return;
      }
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      dragging = false;
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = find(event.touches);
      if (!touch || event.touches.length !== 1) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!dragging) {
        const intent = sheetDragIntent(dx, dy);
        if (intent === null) return;
        if (!intent) {
          start = null;
          return;
        }
        dragging = true;
        clearTimeout(settle);
        // 動かし始めた位置を起点にして、指に付いてくるようにする。
        start = { ...start, y: touch.clientY };
        latest = { y: touch.clientY, time: event.timeStamp };
        previous = latest;
        sheet.style.transition = "none";
        sheet.dataset.sheetDragging = "";
        event.preventDefault();
        return;
      }
      // 中身のスクロールや、ページの引っ張って更新が一緒に動かないようにする。
      event.preventDefault();
      offset = sheetOffset(touch.clientY - start.y);
      sheet.style.translate = `0 ${offset}px`;
      if (event.timeStamp - latest.time >= 16) {
        previous = latest;
        latest = { y: touch.clientY, time: event.timeStamp };
      }
    };
    const onEnd = (event: TouchEvent) => {
      if (!start || find(event.touches)) return;
      const wasDragging = dragging;
      start = null;
      dragging = false;
      if (!wasDragging) return;
      const elapsed = Math.max(1, latest.time - previous.time);
      // 指を止めてから離したときは、払った速さとして数えない。
      const velocity =
        event.timeStamp - latest.time > 100
          ? 0
          : (latest.y - previous.y) / elapsed;
      const close = dismiss.current;
      if (
        close &&
        event.type === "touchend" &&
        sheetDismisses(offset, sheet.offsetHeight, velocity)
      ) {
        // 下げた位置はそのままにして閉じる。閉じる動きが、その位置から続きを引き継ぐ。
        delete sheet.dataset.sheetDragging;
        close();
        // 閉じるのを断られたとき (保存中など) は、元の位置へ戻す。
        settle = setTimeout(() => {
          if (sheet.isConnected) reset();
        }, 600);
      } else {
        sheet.style.transition =
          "translate 0.2s cubic-bezier(0.32, 0.72, 0, 1)";
        sheet.style.translate = "0 0";
        settle = setTimeout(reset, 220);
      }
      offset = 0;
    };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    // 動かしている間はスクロールを止めるので、passive にしない。
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onEnd);
    return () => {
      clearTimeout(settle);
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onEnd);
    };
  }, [sheet, enabled]);

  return useCallback((element: HTMLElement | null) => setSheet(element), []);
}
