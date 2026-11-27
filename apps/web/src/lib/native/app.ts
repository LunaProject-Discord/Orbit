/**
 * スマホアプリ (Capacitor) の中で動いているときだけ使う、端末側の機能への入口。
 * Capacitor のプラグインは、アプリの中でだけ読み込む (Web 版の読み込みを重くしない)。
 */

import { backLog, enableBackLog, locationSummary } from "@/lib/back-log";
import { closeTopSheet, sheetSummary } from "@/lib/sheet-back";

type CapacitorWindow = {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
  };
};

/** スマホアプリ (Android / iOS) の中で動いているか。 */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window as unknown as CapacitorWindow).Capacitor?.isNativePlatform?.() ===
    true
  );
}

export type ThemeMode = "light" | "dark" | "system";

/** next-themes の theme の値を、端末へ伝える 3 つの値にそろえる。 */
export function toThemeMode(theme: string | undefined): ThemeMode {
  return theme === "light" || theme === "dark" ? theme : "system";
}

/**
 * 戻るボタン (Android) を押したときの動き。
 * 画面内で戻れるなら 1 つ戻り、戻れなければアプリを閉じずに裏へ回す
 * (メールアプリは開いたままにしておくほうが、通知から戻るのが速い)。
 */
export function backAction(canGoBack: boolean): "back" | "minimize" {
  return canGoBack ? "back" : "minimize";
}

/** 起動画面を隠す。画面の最初の描画が済んだら呼ぶ。 */
export async function hideSplash(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // 隠せなくても、端末側が数秒後に自動で隠す。
  }
}

type AppShell = {
  setTheme(options: { mode: ThemeMode }): Promise<void>;
  isPushConfigured(): Promise<{ configured: boolean }>;
  /** 端末に入っているフォント (apps/mobile の FontCatalog)。形は lib/local-fonts.ts で確かめる。 */
  listFonts(): Promise<{ fonts: unknown }>;
  /** 接続先とログインを、ほかの Orbit のアプリが引き継げるように保存する (lib/native/shared-config.ts)。 */
  publishSharedConfig(options: {
    serverUrl: string;
    sessionToken: string;
  }): Promise<void>;
  /** Android の自動入力を許すかどうか (lib/app-autofill.ts)。 */
  setAutofillAllowed(options: { allowed: boolean }): Promise<void>;
  /** ほかの Orbit のアプリの接続先とログインを探す。 */
  findSharedConfig(): Promise<{
    found: boolean;
    serverUrl?: unknown;
    sessionToken?: unknown;
  }>;
  /*
   * 添付ファイルの保存と、別のアプリで開く (lib/native/files.ts)。
   * beginFile で一時ファイルを作り、appendFile で中身 (base64、元データで 512KB 以下ずつ) を順に足し、
   * saveFile (保存先を選ぶ画面を出す。やめたら false) か openFile (開けるアプリが無ければ false) を呼ぶ。
   */
  beginFile(): Promise<{ id: string }>;
  appendFile(options: { id: string; data: string }): Promise<void>;
  saveFile(options: {
    id: string;
    name: string;
    mimeType: string;
  }): Promise<{ saved: boolean }>;
  openFile(options: {
    id: string;
    name: string;
    mimeType: string;
  }): Promise<{ opened: boolean }>;
};

// Capacitor のプラグインは、どんな名前のメソッドも端末側へ取り次ぐ Proxy になっている。
// Promise の結果としてそのまま返すと、Promise が then を呼ぼうとして失敗するので、
// 必ずオブジェクトに包んで受け渡す。
let shell: Promise<{ AppShell: AppShell }> | null = null;

/** このアプリ専用のプラグイン (apps/mobile の AppShellPlugin)。 */
export function loadAppShell(): Promise<{ AppShell: AppShell }> {
  shell ??= import("@capacitor/core").then(({ registerPlugin }) => ({
    AppShell: registerPlugin<AppShell>("AppShell"),
  }));
  return shell;
}

/** アプリのテーマを端末へ伝え、ステータスバーなどの色をそろえる。 */
export async function applyNativeTheme(mode: ThemeMode): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { AppShell } = await loadAppShell();
    await AppShell.setTheme({ mode });
  } catch {
    // 伝えられなくても、バーの色が端末の設定のままになるだけ。
  }
}

/**
 * アプリ専用の URL (jp.lunaproject.orbit.mail://…) で開かれたときに、その URL を受け取る。
 * 外のブラウザーでのログインから戻るときに使う。戻り値の関数で解除する。
 */
export function listenAppUrl(listener: (url: string) => void): () => void {
  if (!isNativeApp()) return () => {};
  let cancelled = false;
  let remove: (() => void) | null = null;
  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("appUrlOpen", ({ url }) =>
        listener(url),
      );
      if (cancelled) void handle.remove();
      else remove = () => void handle.remove();
    } catch {
      // 受け取れなければ、ログイン後にアプリへ戻っても追加されない (Web 版で追加できる)。
    }
  })();
  return () => {
    cancelled = true;
    remove?.();
  };
}

/**
 * 戻るボタンで、画面の中の 1 つ上の表示へ戻る処理 (メールを閉じるなど)。閉じたら true。
 * 画面左上の「←」と同じ閉じ方をする。Android の WebView では、URL の履歴を戻す
 * (history.back) が何も起こさないことがあるため、履歴には頼らない。
 */
let appBack: (() => boolean) | null = null;

/** 画面の中で戻る処理を登録する。戻り値の関数で解除する。 */
export function setAppBackHandler(handler: () => boolean): () => void {
  appBack = handler;
  return () => {
    if (appBack === handler) appBack = null;
  };
}

/** history.back() のあと、戻れたか (popstate) を待つ長さ (ミリ秒)。戻れなければアプリを裏へ回す。 */
const HISTORY_BACK_TIMEOUT_MS = 500;

/** 戻るボタンの処理を登録する。戻り値の関数で解除する。 */
export function listenBackButton(): () => void {
  if (!isNativeApp()) return () => {};
  enableBackLog();
  const onPopState = () => backLog(`popstate ${locationSummary()}`);
  window.addEventListener("popstate", onPopState);
  let cancelled = false;
  let remove: (() => void) | null = null;
  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("backButton", ({ canGoBack }) => {
        backLog(
          `戻るボタン canGoBack=${canGoBack} ${locationSummary()} シート=[${sheetSummary()}]`,
        );
        // 下から出るシートが開いていれば、画面は戻さずにシートだけを閉じる。
        if (closeTopSheet()) return;
        // 開いているメールや設定のページなどは、画面の中で閉じる。
        if (appBack?.()) {
          backLog("画面の中で戻る");
          return;
        }
        if (backAction(canGoBack) === "back") {
          backLog("history.back()");
          // 戻れなかったとき (popstate が来ない) は、端末の既定と同じくアプリを裏へ回す。
          let moved = false;
          const onMoved = () => {
            moved = true;
          };
          window.addEventListener("popstate", onMoved, { once: true });
          window.history.back();
          window.setTimeout(() => {
            window.removeEventListener("popstate", onMoved);
            if (moved) return;
            backLog("履歴を戻せなかったので、アプリを裏へ回す");
            void App.minimizeApp();
          }, HISTORY_BACK_TIMEOUT_MS);
        } else {
          backLog("アプリを裏へ回す");
          void App.minimizeApp();
        }
      });
      if (cancelled) void handle.remove();
      else {
        remove = () => void handle.remove();
        backLog("戻るボタンの受け取りを登録");
      }
    } catch (error) {
      backLog(`戻るボタンの受け取りを登録できない: ${String(error)}`);
      // 登録できなければ、端末の既定の動き (画面内で戻る) になる。
    }
  })();
  return () => {
    cancelled = true;
    remove?.();
    window.removeEventListener("popstate", onPopState);
  };
}
