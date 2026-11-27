"use client";

import { type RefObject, useEffect } from "react";
import { useDrawerSwipe } from "@/components/mail/drawer-swipe";
import { DRAWER_MAX_WIDTH } from "@/lib/drawer-swipe";
import { isNativeApp } from "@/lib/native/app";
import { registerSheetBack } from "@/lib/sheet-back";

/** サイドバーを引き出し (ドロワー) として重ねて出す画面の幅 (Tailwind の md 未満)。 */
export const SIDEBAR_DRAWER_QUERY = `(max-width: ${DRAWER_MAX_WIDTH}px)`;

/**
 * スマホ幅で左から引き出すサイドバーの操作 (Mail と Calendar で共通)。
 * - 画面の左端からのスワイプで開き、左へのスワイプで閉じる (useDrawerSwipe)。
 * - 開いている間、Esc で閉じる。
 * - 開いている間、戻る操作 (Android の戻るボタン、ブラウザーの CloseWatcher) で閉じる。
 *   開いたままだと、後ろの画面が戻ってしまう。
 */
export function useSidebarDrawer({
  asideRef,
  backdropRef,
  open,
  onOpenChange,
  disabled = false,
}: {
  asideRef: RefObject<HTMLElement | null>;
  backdropRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** スワイプで開閉しない (作成画面を開いている間など)。Esc と戻る操作は効く。 */
  disabled?: boolean;
}) {
  useDrawerSwipe({ asideRef, backdropRef, open, onOpenChange, disabled });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open || !window.matchMedia(SIDEBAR_DRAWER_QUERY).matches) return;
    return registerSheetBack(
      () => onOpenChange(false),
      !isNativeApp(),
      undefined,
      "sidebar",
    );
  }, [open, onOpenChange]);
}
