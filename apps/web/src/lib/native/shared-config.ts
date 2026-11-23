import { adoptSessionToken, getToken } from "@/lib/api";
import { isNativeApp, loadAppShell } from "@/lib/native/app";
import { apiUrl, normalizeServerUrl, setServerUrl } from "@/lib/server-url";

/**
 * スマホの Orbit のアプリどうし (Mail、Calendar、Contacts) で、接続先サーバーとログインを共有する。
 * スマホでは機能ごとに別のアプリにするので、どれか 1 つでログインすれば、ほかでは入力を省ける。
 * 端末側のしくみ (同じ鍵で署名したアプリだけが読める) は apps/mobile の SharedConfig.java。
 */

/** ほかのアプリから受け取った内容を確かめる。使えなければ null。 */
export function readSharedConfig(value: {
  found: boolean;
  serverUrl?: unknown;
  sessionToken?: unknown;
}): { serverUrl: string; sessionToken: string } | null {
  if (!value.found) return null;
  const { serverUrl, sessionToken } = value;
  if (typeof serverUrl !== "string" || typeof sessionToken !== "string") {
    return null;
  }
  const url = normalizeServerUrl(serverUrl);
  if (!url || !sessionToken.trim()) return null;
  return { serverUrl: url, sessionToken };
}

/**
 * このアプリでログインしていなければ、ほかの Orbit のアプリの接続先とログインを引き継ぐ。
 * 引き継いだら true。ログインが有効かどうかは、呼び出し側が利用者を確かめて決める。
 */
export async function adoptSharedConfig(): Promise<boolean> {
  if (!isNativeApp() || getToken()) return false;
  try {
    const { AppShell } = await loadAppShell();
    const shared = readSharedConfig(await AppShell.findSharedConfig());
    if (!shared) return false;
    setServerUrl(shared.serverUrl);
    adoptSessionToken(shared.sessionToken);
    return true;
  } catch {
    // 引き継げなければ、いつもどおりログイン画面を出す。
    return false;
  }
}

/**
 * このアプリの接続先とログインを、ほかの Orbit のアプリが引き継げるように保存する。
 * ログインやログアウトで状態が変わるたびに呼ぶ (ログアウト後は、ログインを空にして保存する)。
 */
export async function publishSharedConfig(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { AppShell } = await loadAppShell();
    await AppShell.publishSharedConfig({
      serverUrl: apiUrl(),
      sessionToken: getToken() ?? "",
    });
  } catch {
    // 保存できなくても、このアプリは使える (ほかのアプリで入力が要るだけ)。
  }
}
