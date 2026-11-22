"use client";

import { useEffect } from "react";
import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";

/**
 * サービスワーカーを登録し、アプリ本体を端末に保存させる (オフラインでも画面を開けるようにする)。
 * 画面を開くたびに、新しい版が配置されていないかも確かめさせる。
 */
export function OfflineBoot() {
  useEffect(() => {
    // スマホアプリとデスクトップ版では、アプリ本体は端末に入っているので保存し直す必要がない
    // (保存すると、アプリを更新しても古い画面が出続けるおそれがある)。
    if (isNativeApp() || isDesktopApp() || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        registration.active?.postMessage({ type: "refresh-shell" });
      })
      .catch(() => {
        // 登録できない環境 (http での公開など) では、オンラインのときだけ使える。
      });
  }, []);
  return null;
}
