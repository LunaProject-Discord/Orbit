/**
 * 接続先サーバー (API の URL) の決め方。
 * - Web: 配信元と同じサーバーなので、ビルド時の NEXT_PUBLIC_API_URL を使う。
 * - 同梱アプリ (Capacitor のスマホ版、Tauri のデスクトップ版): 画面のファイルはアプリの中にあり、
 *   どのサーバーにつなぐかは利用者が最初に入力する。端末ごとに localStorage へ覚えておく。
 *   ビルド時に NEXT_PUBLIC_API_URL を渡しておけば、それが初期値になり入力を省ける。
 */

import { resolveApiUrl } from "@/lib/api-url";

const STORAGE_KEY = "mail.server-url";
const BUILD_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
const DEV_URL = "http://localhost:8787";

type BundledWindow = {
  Capacitor?: { isNativePlatform?: () => boolean };
  __TAURI_INTERNALS__?: unknown;
};

/** 画面のファイルをアプリに同梱して動いているか (Capacitor / Tauri)。 */
export function isBundledApp(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as BundledWindow;
  return (
    w.Capacitor?.isNativePlatform?.() === true ||
    w.__TAURI_INTERNALS__ !== undefined
  );
}

/**
 * 入力されたサーバーのアドレスを、API の URL の形 (末尾の / 無し) に整える。
 * スキームが無ければ https:// を補う。使えない形なら null。
 * 平文の http:// は、同じ端末や LAN 内での確認用に許す (公開サーバーは https を使う)。
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password) return null;
  // 画面の URL (https://mail.example.com/login など) を貼り付けても通るよう、パス以降は捨てる。
  return url.origin;
}

function storedServerUrl(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value ? normalizeServerUrl(value) : null;
  } catch {
    return null;
  }
}

/** 利用者が選んだ接続先 (同梱アプリのみ)。無ければ null。 */
export function chosenServerUrl(): string | null {
  return isBundledApp() ? storedServerUrl() : null;
}

/** 接続先が決まっているか。false なら、先に接続先の設定画面を出す。 */
export function hasServerUrl(): boolean {
  if (!isBundledApp()) return true;
  return storedServerUrl() !== null || BUILD_URL !== "";
}

/** API の URL (末尾の / 無し)。 */
export function apiUrl(): string {
  return (
    chosenServerUrl() ??
    resolveApiUrl(
      BUILD_URL || DEV_URL,
      typeof window === "undefined" ? null : window.location,
    )
  );
}

/**
 * サービスワーカーを登録する URL。API の URL を付けて渡し、サービスワーカーは通知の出欠のボタンが
 * 合言葉を送る先を、この API の POST /v1/notification-actions/event だけに絞る
 * (public/sw.js の isEventActionUrl、段取り 9 のレビュー M4)。登録する所はすべてこれを使う
 * (URL が違うと、登録のたびにサービスワーカーが入れ替わる)。
 */
export function serviceWorkerScriptUrl(): string {
  return `/sw.js?api=${encodeURIComponent(apiUrl())}`;
}

/** 接続先を保存する。null で消す (ビルド時の初期値に戻る)。 */
export function setServerUrl(url: string | null) {
  try {
    if (url) window.localStorage.setItem(STORAGE_KEY, url);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できない環境では、次に開いたときにもう一度入力してもらう。
  }
}

export type ServerCheck =
  | { ok: true }
  /** 届かなかった (アドレスの間違い、オフライン、サーバー停止、許可されていないオリジン)。 */
  | { ok: false; reason: "unreachable" }
  /** 応答はあったが、このアプリのサーバーではなかった。 */
  | { ok: false; reason: "not_mail_server" };

/** そのアドレスでこのアプリのサーバーが動いているかを確かめる。 */
export async function checkServer(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<ServerCheck> {
  let response: Response;
  try {
    response = await fetcher(`${url}/v1`, {
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const data: unknown = await response.json().catch(() => null);
  const name = (data as { name?: unknown } | null)?.name;
  return response.ok && name === "mail-api"
    ? { ok: true }
    : { ok: false, reason: "not_mail_server" };
}
