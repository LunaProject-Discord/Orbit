/**
 * スマホアプリやデスクトップ版から Google / Microsoft アカウントを追加するときの行き来。
 *
 * ログイン画面はアプリの外のブラウザーで開く (WebView の中では Google がログインを断るため)。
 * ログイン後の戻り先は Web 版の URL (https://<サーバー>/oauth/google など) に決まっているので、
 * いったん Web 版のページへ戻り、そこからアプリ専用の URL でアプリへ引き渡す。
 *
 *   アプリ → ブラウザーでログイン → Web 版 /oauth/google?code=…&state=app~…
 *        → jp.lunaproject.orbit.mail://oauth/google?code=…&state=app~… → アプリが受け取って追加
 *
 * アプリから始めたログインかどうかは、state の先頭の目印 (app~) で見分ける。目印はサーバーが付ける。
 * code と state を受け取っても、アカウントの追加にはログインを始めた本人のセッションが要るので、
 * ほかのアプリがこの URL を横取りしても悪用はできない。
 * Orbit 自体へのログイン (IdP、/oauth/sso) は、ログインを始めた端末だけが知る合言葉を
 * サーバーが照合するので、こちらも横取りした code と state だけではログインできない。
 */

import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";

/**
 * ログイン画面を外のブラウザーで開き、アプリ専用の URL で戻ってくる方式を使うか
 * (スマホアプリとデスクトップ版)。ブラウザーで開いた Web 版では false。
 */
export function usesAppOAuth(): boolean {
  return isNativeApp() || isDesktopApp();
}

/** アプリ専用の URL のスキーム。Android のアプリ ID と同じ (AndroidManifest.xml、デスクトップ版の tauri.conf.json と合わせる)。 */
export const APP_URL_SCHEME = "jp.lunaproject.orbit.mail";
/** アプリから始めたログインの state に付く目印。サーバー (apps/api) と合わせる。 */
export const APP_STATE_PREFIX = "app~";

const PROVIDERS = new Set(["google", "microsoft", "sso"]);

/** ログイン画面から戻ってきた URL の state が、アプリから始めたものか。 */
export function isAppOAuthReturn(search: string): boolean {
  return (
    new URLSearchParams(search).get("state")?.startsWith(APP_STATE_PREFIX) ===
    true
  );
}

/** Web 版のページからアプリへ引き渡す URL。 */
export function appOAuthUrl(provider: string, search: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return `${APP_URL_SCHEME}://oauth/${provider}${query ? `?${query}` : ""}`;
}

/**
 * アプリが受け取った URL を、アプリの中で開く画面のパスに変える。
 * このアプリの OAuth の戻り以外は null (何もしない)。
 */
export function routeForAppUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_URL_SCHEME}:` || parsed.host !== "oauth") {
    return null;
  }
  const provider = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!PROVIDERS.has(provider)) return null;
  return `/oauth/${provider}${parsed.search}`;
}
