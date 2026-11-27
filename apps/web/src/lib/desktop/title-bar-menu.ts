import { useSyncExternalStore } from "react";

/**
 * タイトルバーに出す、開いている内容の名前 (作成専用のウィンドウの件名など)。
 * 「名前 ― Orbit Mail」の形で出し、OS のウィンドウの名前 (タスクバー) にも使う。
 */
let currentTitle: string | null = null;
const titleListeners = new Set<() => void>();

export function setTitleBarTitle(next: string | null): void {
  if (next === currentTitle) return;
  currentTitle = next;
  for (const listener of titleListeners) listener();
}

function subscribeTitle(listener: () => void): () => void {
  titleListeners.add(listener);
  return () => titleListeners.delete(listener);
}

export function useTitleBarTitle(): string | null {
  return useSyncExternalStore(
    subscribeTitle,
    () => currentTitle,
    () => null,
  );
}

export const APP_NAME = "Orbit Mail";

/** タイトルバーとウィンドウに出す名前。 */
export function windowTitle(title: string | null): string {
  return title ? `${title} ― ${APP_NAME}` : APP_NAME;
}
