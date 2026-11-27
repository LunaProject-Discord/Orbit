"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { showNotice } from "@/components/mail/toasts";
import {
  installDesktopUpdateNow,
  openAppUpdateSettings,
  startAppUpdates,
  useAppUpdate,
} from "@/lib/app-update";

const BODY_UPDATE_TOAST = "body-update";

/**
 * アプリ (デスクトップ版、スマホアプリ) の画面の自動更新を始める。ブラウザーでは何もしない。
 * 画面が描けたところで「問題なく起動した」とアプリ側へ伝えるので、レイアウトの最後に置く。
 * デスクトップ版で本体の新しい版が見つかったとき (接続先のサーバーの設定が notify) は、
 * OS のダイアログではなく、画面の下の知らせで尋ねる。
 */
export function AppUpdateBoot() {
  useEffect(() => startAppUpdates(), []);
  useBodyUpdateNotice();
  return null;
}

function useBodyUpdateNotice() {
  const { body } = useAppUpdate();
  const phase = body.kind === "desktop" ? body.status.phase : undefined;
  const available = phase?.kind === "available" ? phase.version : null;
  /** 知らせた版。閉じたあとに同じ版で何度も出さない (次に起動するまで)。 */
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!available) {
      toast.dismiss(BODY_UPDATE_TOAST);
      return;
    }
    if (shown.current === available) return;
    shown.current = available;
    toast.info(`Orbit v${available} があります`, {
      id: BODY_UPDATE_TOAST,
      description: "更新すると、アプリが再起動します。",
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      action: {
        label: "更新して再起動",
        onClick: () => {
          // 進み具合は設定の「バージョン情報」に出す。
          openAppUpdateSettings();
          installDesktopUpdateNow().catch((error: unknown) => {
            showNotice(
              error instanceof Error ? error.message : "更新できませんでした。",
            );
          });
        },
      },
      cancel: {
        label: "詳細",
        onClick: openAppUpdateSettings,
      },
    });
  }, [available]);
}
