/**
 * デスクトップ版 (Tauri) の中で動いているときだけ使う、OS 側の機能への入口。
 * Tauri の API は、アプリの中でだけ読み込む (Web 版の読み込みを重くしない)。
 * 呼び先のコマンドとイベントは apps/desktop/src-tauri/src にある。
 */

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

export type DesktopPlatform = "windows" | "macos" | "linux";

/** デスクトップ版 (Windows / macOS / Linux) の中で動いているか。 */
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as TauriWindow).__TAURI_INTERNALS__ !== undefined;
}

/** html の data-desktop の値を OS の種類として読む。知らない値は null。 */
export function toDesktopPlatform(
  value: string | undefined,
): DesktopPlatform | null {
  return value === "windows" || value === "macos" || value === "linux"
    ? value
    : null;
}

/**
 * どの OS のデスクトップ版か。ブラウザーでは null。
 * アプリ側が、画面を描く前に html へ data-desktop を付けている。
 */
export function desktopPlatform(): DesktopPlatform | null {
  if (typeof document === "undefined") return null;
  return toDesktopPlatform(document.documentElement.dataset.desktop);
}

/** アプリ側のコマンドを呼ぶ。呼べなければ null (画面の操作は続けられる)。 */
export async function invokeDesktop<T = void>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isDesktopApp()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, args);
  } catch {
    return null;
  }
}

/**
 * ファイルを保存する。保存先は、アプリ側 (apps/desktop/src-tauri/src/browser.rs の save_file) が
 * OS の画面で利用者に選ばせる (WebView のダウンロードの一覧を出さない)。
 * 保存したら true、保存先を選ぶのをやめたら false、アプリ側に頼めなければ null (古いアプリ、ブラウザー)。
 */
export async function saveFileDesktop(
  blob: Blob,
  filename: string,
): Promise<boolean | null> {
  if (!isDesktopApp()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return await invoke<boolean>("save_file", bytes, {
      headers: { "x-file-name": encodeURIComponent(filename) },
    });
  } catch {
    return null;
  }
}

/** アプリ側からのイベントを受け取る。戻り値の関数で解除する。 */
export function listenDesktop<T>(
  event: string,
  listener: (payload: T) => void,
): () => void {
  if (!isDesktopApp()) return () => {};
  let cancelled = false;
  let remove: (() => void) | null = null;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<T>(event, ({ payload }) =>
        listener(payload),
      );
      if (cancelled) unlisten();
      else remove = unlisten;
    } catch {
      // 受け取れなくても、画面の操作は続けられる。
    }
  })();
  return () => {
    cancelled = true;
    remove?.();
  };
}

/** 通知が押されたときに届く。開くメールの ID (無ければ受信トレイを開くだけ)。 */
export const OPEN_MESSAGE_EVENT = "desktop://open-message";
/** アプリ専用の URL (外のブラウザーでのログインからの戻り) で開かれたときに届く。 */
export const APP_URL_EVENT = "desktop://app-url";

/**
 * 通知のボタンが押された、または返信欄から送られたときに届く (Windows のみ)。
 * action は "reply" かボタンの ID。text は返信欄に書いた文章。
 */
export const NOTIFICATION_ACTION_EVENT = "desktop://notification-action";

/**
 * 新着メールを OS の通知で知らせる。
 * Windows では、buttons (既読にする、アーカイブなど) と返信欄 (reply) も付ける。
 */
export function notifyNewMail(notification: {
  title: string;
  body: string;
  messageId: string | null;
  buttons?: { id: string; title: string }[];
  reply?: boolean;
}): Promise<null> {
  return invokeDesktop<null>("notify_new_mail", notification);
}

/** 指定したメールの通知を、通知センターから消す (Windows のみ。ほかの OS では何もしない)。 */
export function dismissDesktopNotifications(
  messageIds: string[],
): Promise<null> {
  return invokeDesktop<null>("dismiss_notifications", { messageIds });
}

/** 未読数を、通知領域とタスクバー (Dock) のアイコンに出す。 */
export function setDesktopUnreadCount(count: number): void {
  void invokeDesktop("set_unread_count", {
    count: Math.max(0, Math.min(Math.trunc(count), 99_999)),
  });
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** タイトルバーのボタンの操作。 */
export const desktopWindow = {
  async minimize() {
    await (await currentWindow()).minimize().catch(() => {});
  },
  async toggleMaximize() {
    await (await currentWindow()).toggleMaximize().catch(() => {});
  },
  /** 設定によっては、閉じずに通知領域へ入る (アプリ側が決める)。 */
  async close() {
    await (await currentWindow()).close().catch(() => {});
  },
  async isMaximized(): Promise<boolean> {
    try {
      return await (await currentWindow()).isMaximized();
    } catch {
      return false;
    }
  },
  /** マウスのボタンを押している間、ウィンドウを動かす (上部の行の空き部分を押したとき)。 */
  async startDragging() {
    await (await currentWindow()).startDragging().catch(() => {});
  },
  /**
   * 上部の行の空き部分をダブルクリックしたときの動き。macOS はシステム設定
   * (「タイトルバーをダブルクリックしたとき」) に従い、ほかの OS は最大化と元に戻すを切り替える
   * (apps/desktop の title_bar_double_click)。古いアプリで呼べなければ、最大化を切り替える。
   */
  async titleBarDoubleClick() {
    if (desktopPlatform() !== "macos") return desktopWindow.toggleMaximize();
    const done = await invokeDesktop<boolean>("title_bar_double_click");
    if (done !== true) await desktopWindow.toggleMaximize();
  },
  /** OS のウィンドウの名前 (タスクバーや Alt+Tab に出る) を変える。 */
  async setTitle(title: string) {
    await (await currentWindow()).setTitle(title).catch(() => {});
  },
  /**
   * ウィンドウが閉じられる直前に呼ぶ (タイトルバーの閉じる、システムメニュー、Alt+F4 など)。
   * handler が終わるのを待ってから閉じる。戻り値の関数で解除する。
   */
  onCloseRequested(handler: () => Promise<void>): () => void {
    let cancelled = false;
    let remove: (() => void) | null = null;
    void (async () => {
      try {
        const unlisten = await (await currentWindow()).onCloseRequested(
          async () => {
            await handler().catch(() => {});
          },
        );
        if (cancelled) unlisten();
        else remove = unlisten;
      } catch {
        // 受け取れなければ、閉じる前の後始末をせずに閉じるだけ。
      }
    })();
    return () => {
      cancelled = true;
      remove?.();
    };
  },
  /** ウィンドウの大きさが変わるたびに呼ぶ。戻り値の関数で解除する。 */
  onResized(listener: () => void): () => void {
    let cancelled = false;
    let remove: (() => void) | null = null;
    void (async () => {
      try {
        const unlisten = await (await currentWindow()).onResized(listener);
        if (cancelled) unlisten();
        else remove = unlisten;
      } catch {
        // 受け取れなければ、最大化のボタンの絵が切り替わらないだけ。
      }
    })();
    return () => {
      cancelled = true;
      remove?.();
    };
  },
};

/**
 * タイトルバーの右クリックで、OS のシステムメニュー (元のサイズに戻す・移動・最小化・最大化・閉じる) を出す。
 * Windows だけ (apps/desktop の show_system_menu)。at を渡すと、その位置 (画面の中の CSS ピクセル) に出す。
 * 渡さなければカーソルの位置に出す。
 */
export function showSystemMenu(at?: { x: number; y: number }): void {
  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  void invokeDesktop(
    "show_system_menu",
    at ? { x: at.x * scale, y: at.y * scale } : {},
  );
}
