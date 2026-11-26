/**
 * 接続先のサーバーの情報 (/v1/server-info) と、アプリ本体の自動更新 (docs/updates.md)。
 * - サーバーは自分と同じ版のアプリ本体を配り、更新のしかた (auto / notify / off) も決める。
 *   サーバーの版を固定すれば、アプリも同じ版に揃う。
 * - デスクトップ版: 問い合わせ先と更新のしかたを Tauri 側 (src-tauri/src/updater.rs) へ渡し、
 *   取得とダイアログは Tauri 側が行う。
 * - スマホアプリ (Android、iOS): 本体はアプリストアで更新する (端末によっては、ストア以外からの
 *   入れ替えが既定で制限されているため)。ここではサーバーとの互換性だけを確かめる。
 */

import { isDesktopApp } from "@/lib/desktop/app";

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

// --- アプリ側の機能 ---

export type DesktopBodyStatus = {
  configured: boolean;
  version: string;
  mode: AppUpdateMode | null;
  pending: string | null;
  installed: string | null;
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

export function bodyPlatform(): "desktop" | null {
  return isDesktopApp() ? "desktop" : null;
}
