"use client";

import { ChevronLeftIcon } from "lucide-react";
import { createContext, useContext } from "react";

/**
 * スマホ幅で、メニューを画面の下に貼り付けるための位置の指定。
 * 部品が要素に直接書き込む位置 (style) を打ち消すので、すべて優先して効かせる。
 * 見た目は globals.css の [data-menu-sheet] で決める。
 */
export const sheetPositioner =
  "max-sm:fixed! max-sm:inset-x-0! max-sm:top-auto! max-sm:bottom-0! max-sm:w-full! max-sm:transform-none!";

/** スマホ幅でシートの後ろを暗くする幕。押すとメニューが閉じる。 */
export const sheetBackdrop =
  "fixed inset-0 z-50 bg-black/40 duration-200 sm:hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0";

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
