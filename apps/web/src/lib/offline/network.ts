import { useSyncExternalStore } from "react";

/**
 * サーバーに届くかどうか。ブラウザーの申告 (navigator.onLine) だけでは、
 * 電波はあるがサーバーに届かない場合が分からないので、実際の通信の結果も使う。
 */

let reachable = true;
const listeners = new Set<() => void>();

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function notify() {
  for (const listener of listeners) listener();
}

/** API との通信の結果を伝える (届いたら true、届かなかったら false)。 */
export function reportReachable(ok: boolean): void {
  if (reachable === ok) return;
  reachable = ok;
  notify();
}

export function isOnline(): boolean {
  return reachable && browserOnline();
}

/** 接続の状態が変わったときに呼ばれる処理を登録する。戻り値の関数で解除する。 */
export function subscribeOnline(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("online", notify);
    window.addEventListener("offline", notify);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("online", notify);
      window.removeEventListener("offline", notify);
    }
  };
}

/** サーバーに届く状態かどうか。変わると描画し直す。 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}
