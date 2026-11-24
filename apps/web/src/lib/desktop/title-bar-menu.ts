import { useSyncExternalStore } from "react";

/**
 * デスクトップ版のタイトルバーの左端に出す、ハンバーガーメニューのボタンの中身。
 * タイトルバーは画面の外側 (app/layout.tsx) にあるので、メールの画面がここへ登録する。
 * 登録が無い画面 (ログイン、作成専用のウィンドウなど) ではボタンを出さない。
 */
export type TitleBarMenu = {
  /** ボタンの説明。 */
  label: string;
  /** 説明に添えるショートカットキー。 */
  shortcut?: string;
  /** サイドバーが見えているか (読み上げ用)。 */
  expanded: boolean;
  onClick: () => void;
};

let current: TitleBarMenu | null = null;
const listeners = new Set<() => void>();

export function setTitleBarMenu(next: TitleBarMenu | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTitleBarMenu(): TitleBarMenu | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

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
