/**
 * Android アプリの戻るボタンの記録。戻るボタンが効かないことがある原因を実機で
 * 調べるためのもの。押したときの画面の状態 (URL、履歴の数、開いているシート) と、
 * そのあとの動き (シートを閉じた、履歴を戻した、popstate) を、この端末のメモリーに残す。
 * 端末の外へは送らない。設定の「バージョン情報」からコピーできる。
 */

import { useSyncExternalStore } from "react";

/** 残す件数。古いものから消す。 */
const LIMIT = 300;

let enabled = false;
let entries: string[] = [];
let version = 0;
const listeners = new Set<() => void>();

/** 記録を始める (アプリの中でだけ呼ぶ)。 */
export function enableBackLog() {
  enabled = true;
}

export function backLogEnabled(): boolean {
  return enabled;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/** 1 行を残す。記録していなければ何もしない。 */
export function backLog(message: string) {
  if (!enabled) return;
  entries.push(`${stamp()} ${message}`);
  if (entries.length > LIMIT) entries = entries.slice(-LIMIT);
  version++;
  for (const listener of listeners) listener();
}

/** いまの URL と履歴の数。 */
export function locationSummary(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search} len=${window.history.length}`;
}

export function backLogText(): string {
  return entries.join("\n");
}

export function clearBackLog() {
  entries = [];
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 記録の件数 (表示用)。 */
export function useBackLogCount(): number {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return entries.length;
}

/** テスト用。 */
export function resetBackLogForTest() {
  enabled = false;
  entries = [];
  version = 0;
}
