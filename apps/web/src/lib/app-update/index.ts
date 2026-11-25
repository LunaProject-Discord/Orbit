/**
 * アプリ (デスクトップ版、スマホアプリ) の画面の自動更新。
 * 起動したら「問題なく起動した」とアプリ側へ伝え、しばらくしてから接続先のサーバーの
 * /app-update/manifest.json を確かめる。新しい版があれば裏で取得し、次に起動したときに切り替わる。
 * しくみは docs/app-update.md。
 */

import { useSyncExternalStore } from "react";
import { apiUrl } from "@/lib/server-url";
import {
  BUILD_VERSION,
  isNewerVersion,
  MIN_NATIVE_API,
  verifyManifest,
} from "./manifest";
import { type NativeUpdateInfo, nativeUpdater } from "./native";

export type UpdateStatus =
  /** 確かめていない */
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: number }
  | { kind: "downloading"; version: string }
  /** 取得済み。次に起動したときに切り替わる */
  | { kind: "ready"; version: string }
  /** 新しい画面はアプリ本体の更新が要る */
  | { kind: "native-required"; version: string }
  /** このビルドでは画面を更新しない (公開鍵が埋め込まれていない) */
  | { kind: "disabled" }
  | { kind: "error"; message: string };

export type AppUpdateState = {
  /** アプリ側の情報。ブラウザー、または読み込む前は null。 */
  native: NativeUpdateInfo | null;
  /** アプリ側の機能が、この画面の必要とする版より古い (画面の更新を確かめられない)。 */
  nativeTooOld: boolean;
  status: UpdateStatus;
};

/** 起動してから最初に確かめるまでの時間と、その後の間隔 (デスクトップ版のアプリ本体の更新と同じ)。 */
const FIRST_CHECK_MS = 20_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let state: AppUpdateState = {
  native: null,
  nativeTooOld: false,
  status: { kind: "idle" },
};
const listeners = new Set<() => void>();

function setState(next: Partial<AppUpdateState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const serverState: AppUpdateState = {
  native: null,
  nativeTooOld: false,
  status: { kind: "idle" },
};

/** いまの状態 (テスト用)。 */
export function appUpdateState(): AppUpdateState {
  return state;
}

/** 設定の「バージョン情報」で使う。 */
export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => serverState,
  );
}

/** 一覧の URL。画面とサーバーは同じ場所から配信している (deploy/Caddyfile)。 */
export function manifestUrl(server: string): string {
  return new URL("/app-update/manifest.json", server).toString();
}

/**
 * 一覧のファイルを取得する場所 (末尾は /)。画面と同じファイルを、HTML として扱われない形で配信している。
 * 通常の URL の HTML には、Cloudflare などの途中のサービスがスクリプトを差し込むことがあり、
 * 一覧の SHA-256 と一致しなくなるため (deploy/Caddyfile の /app-update/files/)。
 */
export function filesBaseUrl(server: string): string {
  return new URL("/app-update/files/", server).toString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "不明なエラー";
}

async function refreshInfo(): Promise<NativeUpdateInfo | null> {
  const updater = nativeUpdater();
  if (!updater) return null;
  try {
    const native = await updater.info();
    setState({ native, nativeTooOld: native.nativeApi < MIN_NATIVE_API });
    return native;
  } catch {
    // アプリ側に機能が無い (この仕組みより前のアプリ) ときは、何もしない。
    return null;
  }
}

let checking: Promise<void> | null = null;

/** 新しい画面があるか確かめ、あれば取得する。manual は設定から押したとき。 */
export function checkForAppUpdate(): Promise<void> {
  checking ??= runCheck().finally(() => {
    checking = null;
  });
  return checking;
}

async function runCheck(): Promise<void> {
  const updater = nativeUpdater();
  if (!updater) return;
  const native = await refreshInfo();
  if (!native) return;
  if (!native.publicKey) {
    setState({ status: { kind: "disabled" } });
    return;
  }
  setState({ status: { kind: "checking" } });
  try {
    const server = apiUrl();
    const text = await updater.fetchManifest(manifestUrl(server));
    const result = await verifyManifest(text, native.publicKey);
    if (!result.ok) {
      setState({
        status: {
          kind: "error",
          message:
            result.reason === "unsupported"
              ? "この端末では、更新の署名を確かめられません。"
              : result.reason === "signature"
                ? "更新の署名が正しくありません。"
                : "更新の情報を読み取れませんでした。",
        },
      });
      return;
    }
    const { manifest } = result;
    // いま動いている画面の版と比べる (取得済みの版があれば、それより新しいときだけ取り直す)。
    const current = native.pending ?? BUILD_VERSION;
    if (!isNewerVersion(manifest.version, current)) {
      setState({
        status: native.pending
          ? { kind: "ready", version: native.pending }
          : { kind: "up-to-date", checkedAt: Date.now() },
      });
      return;
    }
    if (manifest.minNativeApi > native.nativeApi) {
      setState({
        status: { kind: "native-required", version: manifest.version },
      });
      return;
    }
    setState({ status: { kind: "downloading", version: manifest.version } });
    await updater.download({
      version: manifest.version,
      baseUrl: filesBaseUrl(server),
      files: manifest.files,
    });
    await refreshInfo();
    setState({ status: { kind: "ready", version: manifest.version } });
  } catch (error) {
    setState({ status: { kind: "error", message: errorMessage(error) } });
  }
}

/** 取得済みの画面にすぐ切り替える。 */
export async function applyAppUpdate(): Promise<void> {
  await nativeUpdater()?.apply();
}

/** 取得した画面を消し、次に起動したときから同梱の画面に戻す。 */
export async function resetAppUpdate(): Promise<void> {
  const updater = nativeUpdater();
  if (!updater) return;
  await updater.reset();
  await refreshInfo();
  setState({ status: { kind: "idle" } });
}

let started = false;

/**
 * 起動時に一度だけ呼ぶ。画面が問題なく起動したことをアプリ側へ伝え、更新の確認を始める。
 * 戻り値の関数で止める。
 */
export function startAppUpdates(): () => void {
  const updater = nativeUpdater();
  if (!updater || started) return () => {};
  started = true;
  void updater
    .ready()
    .catch(() => {})
    .then(refreshInfo)
    .then((native) => {
      if (native?.pending) {
        setState({ status: { kind: "ready", version: native.pending } });
      }
    });
  const first = window.setTimeout(() => {
    void checkForAppUpdate();
  }, FIRST_CHECK_MS);
  const interval = window.setInterval(() => {
    void checkForAppUpdate();
  }, CHECK_INTERVAL_MS);
  return () => {
    started = false;
    window.clearTimeout(first);
    window.clearInterval(interval);
  };
}
