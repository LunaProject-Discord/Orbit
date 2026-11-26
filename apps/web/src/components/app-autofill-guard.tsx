"use client";

import { useEffect } from "react";
import { startAutofillGuard } from "@/lib/app-autofill";
import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp, loadAppShell } from "@/lib/native/app";

/** アプリ (デスクトップ版・スマホアプリ) で、ブラウザー標準の自動入力を出さない (lib/app-autofill.ts)。 */
export function AppAutofillGuard() {
  useEffect(() => {
    const native = isNativeApp();
    if (!native && !isDesktopApp()) return;
    return startAutofillGuard(document, (present) => {
      if (!native) return;
      void loadAppShell()
        .then(({ AppShell }) =>
          AppShell.setAutofillAllowed({ allowed: present }),
        )
        .catch(() => {
          // 古いアプリ (このメソッドがない) では、入力欄の autocomplete="off" だけで止める。
        });
    });
  }, []);

  return null;
}
