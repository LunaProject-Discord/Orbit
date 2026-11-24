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

/**
 * デスクトップ版で、作成画面だけを出すウィンドウ (新規作成・返信・転送は新しいウィンドウで書く)。
 * 開くときの URL に ?window=compose を付け、そのウィンドウの間は覚えておく
 * (URL は画面の状態に合わせて書き換わるので、読み込み直しても作成専用のままにする)。
 */
const COMPOSE_WINDOW_PARAM = "window";
const COMPOSE_WINDOW_VALUE = "compose";
/** 新しいウィンドウへ移すためだけに保存した下書き。何も書かずに閉じたら消す。 */
const FRESH_PARAM = "fresh";
const WINDOW_MODE_KEY = "orbit.window-mode";

/** path を作成専用のウィンドウの URL にする。fresh は、移すために保存したばかりの下書き。 */
export function composeWindowPath(path: string, fresh = false): string {
  const params = new URLSearchParams({
    [COMPOSE_WINDOW_PARAM]: COMPOSE_WINDOW_VALUE,
  });
  if (fresh) params.set(FRESH_PARAM, "1");
  return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/** 作成専用のウィンドウか。URL にあれば覚えておく。 */
export function readComposeWindow(params: URLSearchParams): {
  compose: boolean;
  fresh: boolean;
} {
  const fromUrl = params.get(COMPOSE_WINDOW_PARAM) === COMPOSE_WINDOW_VALUE;
  let compose = fromUrl;
  try {
    if (fromUrl) {
      window.sessionStorage.setItem(WINDOW_MODE_KEY, COMPOSE_WINDOW_VALUE);
    } else {
      compose =
        window.sessionStorage.getItem(WINDOW_MODE_KEY) === COMPOSE_WINDOW_VALUE;
    }
  } catch {
    // 覚えておけない環境では、読み込み直すと普通の画面に戻るだけ。
  }
  return { compose, fresh: fromUrl && params.get(FRESH_PARAM) === "1" };
}
