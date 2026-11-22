"use client";

import { useLayoutEffect } from "react";
import { appFontFamily, usePreferences } from "@/lib/preferences";

/** 設定したフォント、文字の大きさ、動きの有無を、画面全体に反映する。 */
export function PreferencesEffect() {
  const { font, customFont, fontSize, motion } = usePreferences();
  useLayoutEffect(() => {
    const root = document.documentElement;
    const family = appFontFamily({ font, customFont });
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
  }, [font, customFont, fontSize, motion]);
  return null;
}
