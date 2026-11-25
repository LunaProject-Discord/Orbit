"use client";

import { useEffect } from "react";
import { startAppUpdates } from "@/lib/app-update";

/**
 * アプリ (デスクトップ版、スマホアプリ) の画面の自動更新を始める。ブラウザーでは何もしない。
 * 画面が描けたところで「問題なく起動した」とアプリ側へ伝えるので、レイアウトの最後に置く。
 */
export function AppUpdateBoot() {
  useEffect(() => startAppUpdates(), []);
  return null;
}
