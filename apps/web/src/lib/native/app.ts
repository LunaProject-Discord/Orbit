/**
 * スマホアプリ (Capacitor) の中で動いているときだけ使う、端末側の機能への入口。
 * Capacitor のプラグインは、アプリの中でだけ読み込む (Web 版の読み込みを重くしない)。
 */

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

/** 戻るボタンの処理を登録する。戻り値の関数で解除する。 */
export function listenBackButton(): () => void {
  if (!isNativeApp()) return () => {};
  let cancelled = false;
  let remove: (() => void) | null = null;
  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("backButton", ({ canGoBack }) => {
        if (backAction(canGoBack) === "back") window.history.back();
        else void App.minimizeApp();
      });
      if (cancelled) void handle.remove();
      else remove = () => void handle.remove();
    } catch {
      // 登録できなければ、端末の既定の動き (画面内で戻る) になる。
    }
  })();
  return () => {
    cancelled = true;
    remove?.();
  };
}
