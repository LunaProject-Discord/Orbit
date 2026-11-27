import { useSyncExternalStore } from "react";

/**
 * Orbit のアプリ (メール・カレンダー・設定) の切り替え。Web は 1 つのページなので、
 * URL のパスだけを変えて、表示するアプリを選び直す (読み込み直さない)。
 *
 * ページの構成: メール /mail/*、カレンダー /calendar/*、連絡先 /contacts/* (アプリはまだ無い)、
 * 設定 /settings/* (どのアプリの上にも出すダイアログ)、管理画面 /admin (別のページ)。
 */
const EVENT = "orbit:navigate";

/** メールの画面の URL の先頭。"/" を開いたときもここへ移る。 */
export const MAIL_PATH = "/mail";

export function navigateApp(path: string) {
  if (`${window.location.pathname}${window.location.search}` === path) return;
  window.history.pushState(null, "", path);
  notifyNavigation();
}

/** history.pushState / replaceState で URL を変えたことを、表示するアプリを選ぶ部品へ知らせる。 */
export function notifyNavigation() {
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
