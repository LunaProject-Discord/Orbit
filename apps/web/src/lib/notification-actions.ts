import { useSyncExternalStore } from "react";
import {
  getSettings,
  type NotificationAction,
  saveNotificationActions,
} from "@/lib/api";

/**
 * 新着メールの通知に付けるボタン。押すと、画面を開かずにそのメールを操作する。
 * どのボタンを出すかは利用者が設定で選び、サーバーに保存してどの端末でも同じにする
 * (通知を組み立てるのがサーバーなので、端末ごとには変えられない)。
 */

/** 設定で選べるボタンと、その呼び名、説明。 */
export const NOTIFICATION_ACTIONS: readonly {
  id: NotificationAction;
  label: string;
  description: string;
}[] = [
  { id: "read", label: "既読にする", description: "開かずに既読にします。" },
  {
    id: "star",
    label: "スターを付ける",
    description: "後で見返す印を付けます。",
  },
  {
    id: "archive",
    label: "アーカイブ",
    description: "受信トレイから片付けます。",
  },
  { id: "delete", label: "削除", description: "ごみ箱へ移します。" },
  {
    id: "junk",
    label: "迷惑メール",
    description: "迷惑メールのフォルダへ移します。",
  },
];

/** 通知に付けられるボタンの数の上限。 */
export const MAX_NOTIFICATION_ACTIONS = 3;

/** 何も保存していないときの設定。 */
export const DEFAULT_NOTIFICATION_ACTIONS: readonly NotificationAction[] = [
  "read",
  "archive",
  "delete",
];

const ids = new Set<string>(NOTIFICATION_ACTIONS.map((action) => action.id));

/** 保存してあった設定を読む。知らないボタンと重複は捨てる。 */
export function parseNotificationActions(saved: unknown): NotificationAction[] {
  if (!Array.isArray(saved)) return [...DEFAULT_NOTIFICATION_ACTIONS];
  const actions: NotificationAction[] = [];
  for (const value of saved) {
    if (
      typeof value === "string" &&
      ids.has(value) &&
      !actions.includes(value as NotificationAction)
    ) {
      actions.push(value as NotificationAction);
    }
  }
  return actions.slice(0, MAX_NOTIFICATION_ACTIONS);
}

/**
 * ボタンを選ぶ / 外す。選んだものは最後に足す (選んだ順が、通知に並ぶ順になる)。
 * 上限まで選んでいるときは足せないので、同じ内容を返す。
 */
export function toggleNotificationAction(
  actions: readonly NotificationAction[],
  id: NotificationAction,
  on: boolean,
): NotificationAction[] {
  const rest = actions.filter((action) => action !== id);
  if (!on) return rest;
  if (rest.length >= MAX_NOTIFICATION_ACTIONS) return [...actions];
  return [...rest, id];
}

// ---------------------------------------------------------------------------
// 設定の保持 (サーバーに保存し、前回の内容を端末にも残す)
// ---------------------------------------------------------------------------

const CACHE_KEY = "mail.notification-actions.v1";
const INITIAL: NotificationAction[] = [...DEFAULT_NOTIFICATION_ACTIONS];

let current: NotificationAction[] | null = null;
/** 保存の途中で届いた取得結果に、選んだばかりの設定を上書きされないようにする。 */
let saving = 0;
const listeners = new Set<() => void>();

function read(): NotificationAction[] {
  if (current) return current;
  try {
    current = parseNotificationActions(
      JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null"),
    );
  } catch {
    current = INITIAL;
  }
  return current;
}

function set(next: NotificationAction[]) {
  const previous = read();
  if (
    previous.length === next.length &&
    previous.every((action, index) => action === next[index])
  ) {
    return;
  }
  current = next;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
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

/** いま通知に付けるボタン。変わると、使っている部品を描き直す。 */
export function useNotificationActions(): NotificationAction[] {
  return useSyncExternalStore(subscribe, read, () => INITIAL);
}

/** サーバーから設定を取得し直す (設定画面を開いたときと、ほかの端末で変えたとき)。 */
export async function refreshNotificationActions(
  load: () => Promise<{ notificationActions?: unknown }> = getSettings,
): Promise<void> {
  try {
    const { notificationActions } = await load();
    if (saving === 0) set(parseNotificationActions(notificationActions));
  } catch {
    // 取得できない間 (オフラインなど) は、前回の内容を使う。
  }
}

/**
 * 設定を変える。画面にはすぐ反映し、サーバーに保存できなければ元に戻す。
 * 保存できたかを返す。
 */
export async function changeNotificationActions(
  next: NotificationAction[],
  save: (
    actions: NotificationAction[],
  ) => Promise<void> = saveNotificationActions,
): Promise<boolean> {
  const previous = read();
  set(next);
  saving += 1;
  try {
    await save(next);
    return true;
  } catch {
    // この後に選び直していなければ、保存できていた内容へ戻す。
    if (current === next) set(previous);
    return false;
  } finally {
    saving -= 1;
  }
}

/** テスト用: 保持している設定を捨てる。 */
export function resetNotificationActionsForTest() {
  current = null;
  saving = 0;
}
