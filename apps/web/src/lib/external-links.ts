/**
 * アプリ (スマホアプリ、デスクトップ版) の中で、外部へのリンクを OS の既定のブラウザーで開く。
 *
 * ブラウザーで開いた Web 版では、リンクは新しいタブで開くので何もしなくてよい。
 * アプリの WebView には「新しいタブ」が無く、次のようになる。
 *
 * - Android: 新しいウィンドウを開く操作は、いちばん外側の画面の移動に置き換わる。
 *   メール本文の枠 (sandbox 付きの iframe) からは外側の画面を移動できないので、押しても何も起きない。
 * - デスクトップ版: 新しいウィンドウの要求をアプリ側で受けてブラウザーへ渡しているが、
 *   OS ごとの WebView の違いに左右される。
 *
 * そこで、リンクのクリックをこのアプリの側で受け取り、いちばん外側の画面から外部の URL へ移動する。
 * 外部の URL への移動は、アプリ側 (Capacitor の launchIntent、Tauri の on_navigation) が止めて、
 * 既定のブラウザーやメールソフトへ渡す (Google / Microsoft のログイン画面を開くのと同じ道筋)。
 */

import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";

/** リンクのクリックをアプリの側で受け取って、外のブラウザーへ渡す必要があるか。 */
export function handlesExternalLinks(): boolean {
  return isNativeApp() || isDesktopApp();
}

/**
 * 外のブラウザーやメールソフトで開く URL か。
 * このアプリ自身の画面 (同じオリジン) と、http(s) / mailto / tel 以外は対象にしない。
 */
export function externalUrl(href: string, appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:" || url.protocol === "tel:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin === appOrigin ? null : url.href;
}

type LinkLike = { href?: unknown };
type ClosestLike = { closest?: (selector: string) => LinkLike | null };

/**
 * クリックされた場所を含むリンクの、外部の URL。外部へのリンクでなければ null。
 * 本文の枠の中の要素は別の文書のものなので、instanceof ではなく形で確かめる。
 */
export function externalLinkOf(
  target: EventTarget | null,
  appOrigin: string,
): string | null {
  const element = target as ClosestLike | null;
  if (typeof element?.closest !== "function") return null;
  const link = element.closest("a[href], area[href]");
  return typeof link?.href === "string"
    ? externalUrl(link.href, appOrigin)
    : null;
}

/**
 * 文書の中のリンクのクリックを受け取り、外部へのリンクなら open へ渡す。
 * アプリの画面にも、メール本文の枠の中の文書にも使う。戻り値で解除する。
 */
export function interceptExternalLinks(
  doc: Document,
  open: (url: string) => void = openExternally,
  appOrigin: string = window.location.origin,
): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const url = externalLinkOf(event.target, appOrigin);
    if (!url) return;
    event.preventDefault();
    open(url);
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}

/** いちばん外側の画面から外部の URL へ移動する。アプリ側が止めて、既定のブラウザーで開く。 */
function openExternally(url: string): void {
  window.location.assign(url);
}
