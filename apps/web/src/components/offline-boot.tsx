"use client";

import { useEffect } from "react";

/**
 * サービスワーカーを登録し、アプリ本体を端末に保存させる (オフラインでも画面を開けるようにする)。
 * 画面を開くたびに、新しい版が配置されていないかも確かめさせる。
 */
export function OfflineBoot() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
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
