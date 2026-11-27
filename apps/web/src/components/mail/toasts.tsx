"use client";

import { Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * 画面の下に出す知らせ (トースト)。表示は sonner (components/ui/sonner.tsx の Toaster) に任せ、
 * ここでは知らせの種類ごとの出し方をまとめる。
 */

/** 短い知らせを出しておく時間 (ms)。 */
export const NOTICE_MS = 8_000;

const NOTICE_ID = "notice";
const FAILURES_ID = "failures";

/** しばらくすると消える、短い知らせ。同時に出すのは 1 つで、新しい知らせが前のものを置き換える。 */
export function showNotice(message: string, tone: "error" | "info" = "error") {
  const options = { id: NOTICE_ID, duration: NOTICE_MS, closeButton: true };
  if (tone === "error") toast.error(message, options);
  else toast.info(message, options);
}

export function hideNotice() {
  toast.dismiss(NOTICE_ID);
}

/**
 * 削除や移動のあとに出す知らせ。「元に戻す」を押すと onUndo を呼ぶ。
 * 出しておく時間は呼び出し側が決め (hideUndo で消す)、利用者が閉じたら onClose を呼ぶ。
 */
export function showUndo(
  id: number | string,
  message: string,
  onUndo: () => void,
  onClose: () => void,
) {
  toast(message, {
    id: `undo-${id}`,
    duration: Number.POSITIVE_INFINITY,
    // 暗い地に明るい文字にして、一覧の上でも目に入るようにする。
    invert: true,
    closeButton: true,
    action: {
      label: (
        <span className="flex items-center gap-1.5">
          <Undo2Icon className="size-4" aria-hidden="true" />
          元に戻す
          <kbd className="hidden font-normal font-sans text-xs opacity-60 pointer-fine:inline">
            Z
          </kbd>
        </span>
      ),
      onClick: onUndo,
    },
    onDismiss: onClose,
  });
}

export function hideUndo(id: number | string) {
  toast.dismiss(`undo-${id}`);
}

/**
 * メールサーバーへ反映できなかった操作の知らせ。やり直すか破棄するまで出し続ける
 * (スワイプや時間では消えない)。
 */
export function showFailures(
  summary: string,
  onRetry: () => void,
  onDetails: () => void,
) {
  toast.error(summary, {
    id: FAILURES_ID,
    duration: Number.POSITIVE_INFINITY,
    dismissible: false,
    // 押しても知らせは閉じない (片付いたら hideFailures で消す) ので、
    // sonner のボタンではなく、自前のボタンを並べる。
    action: (
      <div className="ml-auto flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" onClick={onDetails}>
          詳細
        </Button>
        <Button variant="outline" size="sm" onClick={onRetry}>
          再試行
        </Button>
      </div>
    ),
  });
}

export function hideFailures() {
  toast.dismiss(FAILURES_ID);
}
