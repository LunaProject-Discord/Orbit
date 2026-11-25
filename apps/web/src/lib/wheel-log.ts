/**
 * トラックパッドの横スクロール (wheel イベント) の記録。スワイプの反応を実機で
 * 調べるためのもの。設定画面でオンにすると、届いた動きと判定をこの端末のメモリーに
 * 残し、コピーして送れるようにする。端末の外へは送らない。
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "orbit.debug.wheelLog";
/** 残す件数。古いものから消す。 */
const LIMIT = 3000;

let enabled = readEnabled();
let entries: string[] = [];
let version = 0;
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  version++;
  for (const listener of listeners) listener();
}

export function wheelLogEnabled(): boolean {
  return enabled;
}

export function setWheelLogEnabled(next: boolean) {
  enabled = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 保存できなくても、開いている間は記録する。
  }
  notify();
}

export type WheelLogEntry = {
  /** 動きが作られた時刻 (ms)。 */
  at: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  /** 本文の iframe の中で受け取ったか。 */
  inFrame: boolean;
  /** 判定の結果 (ignored-momentum、start、move、commit など)。 */
  result: string;
};

export function logWheel(entry: WheelLogEntry) {
  if (!enabled) return;
  entries.push(
    [
      entry.at.toFixed(1),
      entry.deltaX.toFixed(2),
      entry.deltaY.toFixed(2),
      entry.deltaMode,
      entry.inFrame ? "frame" : "top",
      entry.result,
    ].join("\t"),
  );
  if (entries.length > LIMIT) entries = entries.slice(-LIMIT);
  // 件数の表示は、たまに更新すれば足りる。
  if (entries.length % 20 === 0) notify();
}

export function clearWheelLog() {
  entries = [];
  notify();
}

/** コピーして送る形 (タブ区切り)。 */
export function wheelLogText(): string {
  const header = [
    `# ${typeof navigator === "undefined" ? "" : navigator.userAgent}`,
    "at\tdeltaX\tdeltaY\tdeltaMode\tsurface\tresult",
  ];
  return [...header, ...entries].join("\n");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 記録のオン・オフと件数。設定画面で使う。 */
export function useWheelLog(): { enabled: boolean; count: number } {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return { enabled, count: entries.length };
}
