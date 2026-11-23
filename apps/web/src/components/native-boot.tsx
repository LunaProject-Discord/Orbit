"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import {
  handlesExternalLinks,
  interceptExternalLinks,
} from "@/lib/external-links";
import {
  applyNativeTheme,
  hideSplash,
  listenAppUrl,
  listenBackButton,
  toThemeMode,
} from "@/lib/native/app";
import { routeForAppUrl } from "@/lib/native/oauth";

/**
 * スマホアプリ (Capacitor) の中で動いているときの、端末側とのつなぎ込み。
 * ブラウザーでは何もしない。外部へのリンクの扱いだけは、デスクトップ版でも行う。
 */
export function NativeBoot() {
  const { theme } = useTheme();
  const router = useRouter();

  useEffect(() => {
    // 最初の描画が済んだので、起動画面を外す。
    void hideSplash();
    return listenBackButton();
  }, []);

  // 画面上の外部へのリンク (ヘルプなど) を、既定のブラウザーで開く。メール本文の中は BodyFrame が受け持つ。
  useEffect(() => {
    if (handlesExternalLinks()) return interceptExternalLinks(document);
  }, []);

  useEffect(() => {
    void applyNativeTheme(toThemeMode(theme));
  }, [theme]);

  // 外のブラウザーでの Google / Microsoft のログインから戻ってきたら、アカウントを追加する画面へ進む。
  useEffect(
    () =>
      listenAppUrl((url) => {
        const route = routeForAppUrl(url);
        if (route) router.push(route);
      }),
    [router],
  );

  return null;
}
