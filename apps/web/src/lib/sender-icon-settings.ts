import { useSyncExternalStore } from "react";
import { getSettings, saveSenderIconSettings } from "@/lib/api";

// ---------------------------------------------------------------------------
// 差出人のアイコンを Gravatar で探すかどうか。取得はサーバーが代わりに行うので、
// 端末ごとではなくサーバーに保存してどの端末でも同じにし、前回の内容を端末にも残す。
// アイコンを一覧や詳細に表示するかどうかは、端末ごとの設定 (preferences.ts)。
// ---------------------------------------------------------------------------

const CACHE_KEY = "mail.sender-icon-gravatar.v1";

let current: boolean | null = null;
/** 保存の途中で届いた取得結果に、選んだばかりの設定を上書きされないようにする。 */
let saving = 0;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): boolean {
  if (current !== null) return current;
  current = storage()?.getItem(CACHE_KEY) === "true";
  return current;
}

function set(next: boolean) {
  if (current === next) return;
  current = next;
  try {
    storage()?.setItem(CACHE_KEY, String(next));
  } catch {
    // 保存できなくても、このページを開いている間は有効。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 差出人のアイコンを Gravatar で探すか。変わると、使っている部品を描き直す。 */
export function useSenderIconGravatar(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

/** 差出人のアイコンを Gravatar で探すか (部品の外で使うとき用)。 */
export function currentSenderIconGravatar(): boolean {
  return read();
}

/** サーバーから設定を取得し直す (起動時と、ほかの端末で変えたとき)。 */
export async function refreshSenderIconSettings(
  load: () => Promise<{ senderIconGravatar?: boolean }> = getSettings,
): Promise<void> {
  try {
    const { senderIconGravatar } = await load();
    if (saving > 0) return;
    set(senderIconGravatar === true);
  } catch {
    // 取得できない間 (オフラインなど) は、前回の内容を使う。
  }
}

/**
 * 設定を変える。画面にはすぐ反映し、サーバーに保存できなければ元に戻す。
 * 保存できたかを返す。
 */
export async function changeSenderIconGravatar(
  gravatar: boolean,
  save: (settings: {
    gravatar: boolean;
  }) => Promise<void> = saveSenderIconSettings,
): Promise<boolean> {
  const previous = read();
  set(gravatar);
  saving += 1;
  try {
    await save({ gravatar });
    return true;
  } catch {
    if (current === gravatar) set(previous);
    return false;
  } finally {
    saving -= 1;
  }
}

/** テスト用: 保持している設定を捨てる。 */
export function resetSenderIconSettingsForTest() {
  current = null;
  saving = 0;
}
