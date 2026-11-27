/**
 * 画面の自動更新で使う、アプリ側 (デスクトップ版の Tauri、スマホアプリの Android) の機能。
 * - デスクトップ版: apps/desktop/src-tauri/src/web_bundle.rs のコマンド
 * - スマホアプリ: apps/mobile の AppUpdatePlugin
 * ブラウザーでは使わない (Web 版はサービスワーカーが新しい版を取得する)。
 */

import { isDesktopApp, listenDesktop } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";
import type { ManifestFile } from "./manifest";

export type NativeUpdateInfo = {
  /** アプリ本体の版 (例: 0.1.0)。 */
  nativeVersion: string;
  /** アプリ側の機能の版。画面の一覧の minNativeApi と比べる。 */
  nativeApi: number;
  /** 一覧の署名を確かめる公開鍵。無ければ、このビルドでは画面を更新しない。 */
  publicKey: string | null;
  /** いま使っている、取得した画面の版。同梱の画面なら null。 */
  running: string | null;
  /** 取得済みで、次に起動したときに切り替わる版。 */
  pending: string | null;
};

/** 画面の取得の進み具合。done と total は、一覧のファイルの大きさの合計 (バイト)。 */
export type DownloadProgress = { version: string; done: number; total: number };

/** アプリ側が取得の進み具合を送るイベント (web_bundle.rs、AppUpdatePlugin.java と合わせる)。 */
export const DOWNLOAD_PROGRESS_EVENT = "app-update://progress";

function isProgress(value: unknown): value is DownloadProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "string" &&
    typeof v.done === "number" &&
    typeof v.total === "number"
  );
}

export type NativeUpdater = {
  platform: "desktop" | "android";
  info(): Promise<NativeUpdateInfo>;
  /** 一覧を取得する (アプリ側が取得するので、サーバーの CORS の設定は要らない)。 */
  fetchManifest(url: string): Promise<string>;
  /** 一覧のファイルを取得して確かめ、次に起動したときに使う版として置く。 */
  download(options: {
    version: string;
    baseUrl: string;
    files: ManifestFile[];
  }): Promise<void>;
  /**
   * 取得の進み具合 (バイト数) を受け取る。戻り値の関数で解除する。
   * 古いアプリは送らないので、届かないこともある。
   */
  onProgress(listener: (progress: DownloadProgress) => void): () => void;
  /** いまの画面が問題なく起動したことを伝える (伝えないまま終わると、次は前の版に戻す)。 */
  ready(): Promise<void>;
  /** 取得済みの版にすぐ切り替える (デスクトップ版は再起動、スマホアプリは画面を読み込み直す)。 */
  apply(): Promise<void>;
};

function isInfo(value: unknown): value is NativeUpdateInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const optionalString = (x: unknown) => x === null || typeof x === "string";
  return (
    typeof v.nativeVersion === "string" &&
    typeof v.nativeApi === "number" &&
    optionalString(v.publicKey) &&
    optionalString(v.running) &&
    optionalString(v.pending)
  );
}

/** アプリ側の結果を、空文字は null にそろえて受け取る (Android は null を空文字で返す)。 */
function normalizeInfo(value: unknown): NativeUpdateInfo {
  if (typeof value === "object" && value !== null) {
    const v = { ...(value as Record<string, unknown>) };
    for (const key of ["publicKey", "running", "pending"]) {
      if (v[key] === "" || v[key] === undefined) v[key] = null;
    }
    if (isInfo(v)) return v;
  }
  throw new Error("アプリ側の情報を読み取れませんでした。");
}

class DesktopError extends Error {}

async function desktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  // lib/desktop/app.ts の invokeDesktop は失敗を null にするので、ここでは直接呼んで理由を受け取る。
  if (!isDesktopApp()) throw new DesktopError("デスクトップ版ではありません。");
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new DesktopError(
      typeof error === "string" ? error : "アプリ側でエラーが起きました。",
    );
  }
}

const desktopUpdater: NativeUpdater = {
  platform: "desktop",
  info: async () => normalizeInfo(await desktop("app_update_info")),
  fetchManifest: (url) => desktop<string>("app_update_fetch_manifest", { url }),
  download: (options) => desktop("app_update_download", options),
  onProgress: (listener) =>
    listenDesktop<unknown>(DOWNLOAD_PROGRESS_EVENT, (payload) => {
      if (isProgress(payload)) listener(payload);
    }),
  ready: () => desktop("app_update_ready"),
  apply: () => desktop("app_update_apply"),
};

type AppUpdatePlugin = {
  info(): Promise<unknown>;
  fetchManifest(options: { url: string }): Promise<{ text: string }>;
  download(options: {
    version: string;
    baseUrl: string;
    files: ManifestFile[];
  }): Promise<void>;
  ready(): Promise<void>;
  apply(): Promise<void>;
  addListener(
    event: "progress",
    listener: (progress: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
};

// Capacitor のプラグインは Proxy なので、Promise の結果として直接返さずオブジェクトに包む (lib/native/app.ts と同じ)。
let plugin: Promise<{ AppUpdate: AppUpdatePlugin }> | null = null;
function loadPlugin() {
  plugin ??= import("@capacitor/core").then(({ registerPlugin }) => ({
    AppUpdate: registerPlugin<AppUpdatePlugin>("AppUpdate"),
  }));
  return plugin;
}

const androidUpdater: NativeUpdater = {
  platform: "android",
  info: async () => normalizeInfo(await (await loadPlugin()).AppUpdate.info()),
  fetchManifest: async (url) =>
    (await (await loadPlugin()).AppUpdate.fetchManifest({ url })).text,
  download: async (options) => (await loadPlugin()).AppUpdate.download(options),
  onProgress: (listener) => {
    let cancelled = false;
    let remove: (() => void) | null = null;
    void loadPlugin()
      .then(({ AppUpdate }) =>
        AppUpdate.addListener("progress", (payload) => {
          if (isProgress(payload)) listener(payload);
        }),
      )
      .then((handle) => {
        if (cancelled) void handle.remove();
        else remove = () => void handle.remove();
      })
      .catch(() => {
        // 受け取れなければ、進み具合のバーを出さないだけ。
      });
    return () => {
      cancelled = true;
      remove?.();
    };
  },
  ready: async () => (await loadPlugin()).AppUpdate.ready(),
  apply: async () => (await loadPlugin()).AppUpdate.apply(),
};

function nativePlatform(): string | null {
  const capacitor = (
    window as unknown as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  return capacitor?.getPlatform?.() ?? null;
}

/** このアプリの更新の機能。ブラウザー、または対応していない古いアプリでは null。 */
export function nativeUpdater(): NativeUpdater | null {
  if (isDesktopApp()) return desktopUpdater;
  if (isNativeApp() && nativePlatform() === "android") return androidUpdater;
  return null;
}
