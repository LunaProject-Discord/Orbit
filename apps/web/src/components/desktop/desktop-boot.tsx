"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  APP_URL_EVENT,
  desktopPlatform,
  isDesktopApp,
  listenDesktop,
} from "@/lib/desktop/app";
import { startBrowserGuard } from "@/lib/desktop/browser-keys";
import { routeForAppUrl } from "@/lib/native/oauth";

/**
 * デスクトップ版 (Tauri) の中で動いているときの、アプリ側とのつなぎ込み。
 * ブラウザーでは何もしない。
 */
export function DesktopBoot() {
  const router = useRouter();

  // 外のブラウザーでの Google / Microsoft のログインから戻ってきたら、アカウントを追加する画面へ進む。
  useEffect(
    () =>
      listenDesktop<string>(APP_URL_EVENT, (url) => {
        const route = routeForAppUrl(url);
        if (route) router.push(route);
      }),
    [router],
  );

  // ブラウザー標準のキー操作 (再読み込み、印刷、ページ内検索、ズームなど)、マウスの戻るボタン、
  // 画像やリンクのドラッグを止める (lib/desktop/browser-keys.ts)。
  useEffect(() => {
    if (!isDesktopApp()) return;
    return startBrowserGuard(window, { mac: desktopPlatform() === "macos" });
  }, []);

  return null;
}
