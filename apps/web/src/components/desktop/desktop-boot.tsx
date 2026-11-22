"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { APP_URL_EVENT, listenDesktop } from "@/lib/desktop/app";
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

  return null;
}
