"use client";

import { useEffect, useLayoutEffect } from "react";
import { preloadLocalFonts, useFontFaceCss } from "@/lib/local-fonts";
import { isNativeApp } from "@/lib/native/app";
import { appFontFamily, usePreferences } from "@/lib/preferences";

/** 設定したフォント、文字の大きさ、動きの有無を、画面全体に反映する。 */
export function PreferencesEffect() {
  const { font, customFont, sansFont, serifFont, monoFont, fontSize, motion } =
    usePreferences();
  useLayoutEffect(() => {
    const root = document.documentElement;
    const family = appFontFamily({
      font,
      customFont,
      sansFont,
      serifFont,
      monoFont,
    });
    // 等幅 (font-mono) は、等幅のフォントを設定しているときだけ差し替える。
    if (monoFont) root.style.setProperty("--app-font-mono", family.mono);
    else root.style.removeProperty("--app-font-mono");
    if (font === "default") {
      root.style.removeProperty("--app-font");
      root.style.removeProperty("--app-font-heading");
    } else {
      root.style.setProperty("--app-font", family.sans);
      root.style.setProperty("--app-font-heading", family.heading);
    }
    // 大きさは rem で決めているので、基準を変えると画面全体が同じ比率で変わる。
    root.style.fontSize = fontSize === 100 ? "" : `${fontSize}%`;
    if (motion === "off") root.dataset.motion = "off";
    else delete root.dataset.motion;
  }, [font, customFont, sansFont, serifFont, monoFont, fontSize, motion]);
  return <NativeFontFaces />;
}

/**
 * Android アプリでは、端末のフォントを名前で指定しても使えないことが多いので、
 * フォントのファイルを読み込む @font-face の規則を置く (実際に使うフォントのファイルだけが読み込まれる)。
 * ほかの環境では何も置かない。
 */
function NativeFontFaces() {
  const css = useFontFaceCss();
  useEffect(() => {
    // 控えの一覧をすぐに使い、裏で調べ直す。
    if (isNativeApp()) void preloadLocalFonts();
  }, []);
  useLayoutEffect(() => {
    if (!css) return;
    const style = document.createElement("style");
    style.dataset.nativeFonts = "";
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  }, [css]);
  return null;
}
