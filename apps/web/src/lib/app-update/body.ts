/**
 * 接続先のサーバーの情報 (/v1/server-info) と、アプリ本体の自動更新 (docs/updates.md)。
 * - サーバーは自分と同じ版のアプリ本体を配り、更新のしかた (auto / notify / off) も決める。
 *   サーバーの版を固定すれば、アプリも同じ版に揃う。
 * - デスクトップ版: 問い合わせ先と更新のしかたを Tauri 側 (src-tauri/src/updater.rs) へ渡し、
 *   取得とダイアログは Tauri 側が行う。
 * - Android: APK で入れたアプリだけ。新しい APK があれば知らせ (auto なら先に取得しておく)、
 *   利用者が「入れる」を押すと OS の確認画面を出す。Google Play から入れたアプリは Play に任せる。
 * - iOS: 本体はストアからしか更新できないので、ここでは何もしない。
 */

import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";

/** この画面が話せる API の版の範囲。サーバーの範囲 (api.minVersion〜api.version) と重なれば使える。 */
export const CLIENT_API_MIN = 1;
export const CLIENT_API_MAX = 1;

export type AppUpdateMode = "auto" | "notify" | "off";

export type ServerInfo = {
  version: string;
  commit: string | null;
  api: { version: number; minVersion: number };
  updates: {
    channel: "stable" | "beta" | "edge";
    pinnedVersion: string | null;
    serverAutoUpdate: boolean;
    appUpdate: AppUpdateMode;
  };
};

export type Compatibility = "ok" | "client-too-old" | "server-too-old";

export function parseServerInfo(value: unknown): ServerInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const api = v.api as Record<string, unknown> | undefined;
  const updates = v.updates as Record<string, unknown> | undefined;
  if (
    v.name !== "orbit" ||
    typeof v.version !== "string" ||
    typeof api?.version !== "number" ||
    typeof api?.minVersion !== "number" ||
    typeof updates !== "object" ||
    updates === null
  ) {
    return null;
  }
  const channel = updates.channel;
  const mode = updates.appUpdate;
  return {
    version: v.version,
    commit: typeof v.commit === "string" ? v.commit : null,
    api: { version: api.version, minVersion: api.minVersion },
    updates: {
      channel:
        channel === "beta" || channel === "edge"
          ? channel
          : ("stable" as const),
      pinnedVersion:
        typeof updates.pinnedVersion === "string"
          ? updates.pinnedVersion
          : null,
      serverAutoUpdate: updates.serverAutoUpdate === true,
      appUpdate: mode === "auto" || mode === "off" ? mode : "notify",
    },
  };
}

/** サーバーとこの画面の API の版の範囲が重なるか。 */
export function compatibility(
  server: ServerInfo["api"],
  client = { min: CLIENT_API_MIN, max: CLIENT_API_MAX },
): Compatibility {
  if (server.minVersion > client.max) return "client-too-old";
  if (server.version < client.min) return "server-too-old";
  return "ok";
}

/** サーバーの情報を取得する。古いサーバー (/v1/server-info が無い) では null。 */
export async function fetchServerInfo(
  server: string,
  fetcher: typeof fetch = fetch,
): Promise<ServerInfo | null> {
  try {
    const response = await fetcher(`${server}/v1/server-info`, {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return parseServerInfo(await response.json());
  } catch {
    return null;
  }
}

export type AndroidRelease = {
  version: string;
  versionCode: number;
  url: string;
  sha256: string;
  size: number;
  mode: AppUpdateMode;
};

function parseAndroidRelease(value: unknown): AndroidRelease | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.version !== "string" ||
    typeof v.versionCode !== "number" ||
    typeof v.url !== "string" ||
    typeof v.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.sha256) ||
    typeof v.size !== "number"
  ) {
    return null;
  }
  return {
    version: v.version,
    versionCode: v.versionCode,
    url: v.url,
    sha256: v.sha256,
    size: v.size,
    mode: v.mode === "auto" || v.mode === "off" ? v.mode : "notify",
  };
}

/** Android の新しい APK の情報。新しいものが無ければ null。 */
export async function fetchAndroidRelease(
  server: string,
  versionCode: number,
  fetcher: typeof fetch = fetch,
): Promise<AndroidRelease | null> {
  const response = await fetcher(
    `${server}/v1/app-update/android?versionCode=${versionCode}`,
    { cache: "no-store", credentials: "omit" },
  );
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const release = parseAndroidRelease(await response.json());
  return release && release.versionCode > versionCode ? release : null;
}

// --- アプリ側の機能 ---

export type DesktopBodyStatus = {
  configured: boolean;
  version: string;
  mode: AppUpdateMode | null;
  pending: string | null;
  installed: string | null;
};

export type AndroidBodyInfo = {
  versionCode: number;
  versionName: string;
  fromPlayStore: boolean;
  canInstall: boolean;
};

async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(
      typeof error === "string" ? error : "アプリ側でエラーが起きました。",
    );
  }
}

export const desktopBody = {
  configure: (serverUrl: string, mode: AppUpdateMode) =>
    invoke<void>("native_update_configure", { serverUrl, mode }),
  status: () => invoke<DesktopBodyStatus>("native_update_status"),
  check: () => invoke<void>("native_update_check"),
  installNow: () => invoke<void>("native_update_install_now"),
};

type AppBodyUpdatePlugin = {
  info(): Promise<AndroidBodyInfo>;
  download(options: {
    url: string;
    sha256: string;
    versionCode: number;
  }): Promise<void>;
  install(options: { versionCode: number }): Promise<{ status: string }>;
};

// Capacitor のプラグインは Proxy なので、Promise の結果として直接返さずオブジェクトに包む (lib/native/app.ts と同じ)。
let plugin: Promise<{ AppBodyUpdate: AppBodyUpdatePlugin }> | null = null;
function loadPlugin() {
  plugin ??= import("@capacitor/core").then(({ registerPlugin }) => ({
    AppBodyUpdate: registerPlugin<AppBodyUpdatePlugin>("AppBodyUpdate"),
  }));
  return plugin;
}

function androidPlatform(): boolean {
  if (!isNativeApp()) return false;
  const capacitor = (
    window as unknown as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  return capacitor?.getPlatform?.() === "android";
}

export const androidBody = {
  available: androidPlatform,
  info: async () => {
    const info = await (await loadPlugin()).AppBodyUpdate.info();
    // Android は真偽値などをそのまま返すが、念のため形をそろえる。
    return {
      versionCode: Number(info.versionCode),
      versionName: String(info.versionName ?? ""),
      fromPlayStore: info.fromPlayStore === true,
      canInstall: info.canInstall === true,
    } satisfies AndroidBodyInfo;
  },
  download: async (release: AndroidRelease) =>
    (await loadPlugin()).AppBodyUpdate.download({
      url: release.url,
      sha256: release.sha256,
      versionCode: release.versionCode,
    }),
  install: async (release: AndroidRelease) =>
    (await (
      await loadPlugin()
    ).AppBodyUpdate.install({
      versionCode: release.versionCode,
    })) as { status: string },
};

export function bodyPlatform(): "desktop" | "android" | null {
  if (isDesktopApp()) return "desktop";
  if (androidPlatform()) return "android";
  return null;
}
