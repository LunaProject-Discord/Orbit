"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import {
  installAndroidRelease,
  setAndroidReleaseListener,
  startAppUpdates,
} from "@/lib/app-update";

/**
 * アプリ (デスクトップ版、スマホアプリ) の画面と本体の自動更新を始める。ブラウザーでは何もしない。
 * 画面が描けたところで「問題なく起動した」とアプリ側へ伝えるので、レイアウトの最後に置く。
 * Android で接続先のサーバーが新しい APK を配っていれば、入れるかを知らせる
 * (デスクトップ版は、アプリ側 (Tauri) がダイアログで尋ねる)。
 */
export function AppUpdateBoot() {
  useEffect(() => {
    setAndroidReleaseListener((release) => {
      toast.info(`Orbit Mail ${release.version} を入れられます。`, {
        id: "app-body-update",
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        action: {
          label: "入れる",
          onClick: () => void installAndroidRelease(),
        },
      });
    });
    const stop = startAppUpdates();
    return () => {
      setAndroidReleaseListener(null);
      stop();
    };
  }, []);
  return null;
}
