import { useSyncExternalStore } from "react";

/**
 * Orbit のアプリ (メール・カレンダー) の切り替え。Web は 1 つのページなので、
 * URL のパスだけを変えて、表示するアプリを選び直す (読み込み直さない)。
 */
const EVENT = "orbit:navigate";

export function navigateApp(path: string) {
  if (`${window.location.pathname}${window.location.search}` === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** いまのパス。アプリの切り替えと「戻る」で変わる。 */
export function usePathnameStore(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
}
