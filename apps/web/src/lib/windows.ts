import { invokeDesktop, isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";

/**
 * メールや作成画面を、新しいウィンドウで開く。
 * デスクトップ版は 1 つのアプリで複数のウィンドウを開く (apps/desktop の open_window)。
 * ブラウザーでは新しいウィンドウ (またはタブ) を開く。スマホアプリでは使えない。
 */

/** 新しいウィンドウを開けるか。開けない環境では、メニューやボタンを出さない。 */
export function canOpenWindows(): boolean {
  if (typeof window === "undefined") return false;
  return !isNativeApp();
}

/** 新しいウィンドウで開けるパスか (アプリの画面のパスだけ。外の URL は開かない)。 */
export function isWindowPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

/**
 * path (lib/route.ts の buildRoute が作る、パスと ? 以降) を新しいウィンドウで開く。
 * 開けなかったら false。
 */
export async function openWindow(path: string): Promise<boolean> {
  if (!canOpenWindows() || !isWindowPath(path)) return false;
  if (isDesktopApp()) {
    // 開けなかったとき (上限、呼び出しの失敗) は null が返る。
    return (await invokeDesktop<boolean>("open_window", { path })) === true;
  }
  return window.open(path, "_blank", "popup,width=1000,height=720") !== null;
}
