"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import {
  applyNativeTheme,
  hideSplash,
  listenBackButton,
  toThemeMode,
} from "@/lib/native/app";

/**
 * スマホアプリ (Capacitor) の中で動いているときの、端末側とのつなぎ込み。
 * ブラウザーでは何もしない。
 */
export function NativeBoot() {
  const { theme } = useTheme();

  useEffect(() => {
    // 最初の描画が済んだので、起動画面を外す。
    void hideSplash();
    return listenBackButton();
  }, []);

  useEffect(() => {
    void applyNativeTheme(toThemeMode(theme));
  }, [theme]);

  return null;
}
