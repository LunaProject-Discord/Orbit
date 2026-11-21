import {
  ApiError,
  type MessageAction,
  type MessageSummary,
  NetworkError,
  sendMessageAction,
} from "@/lib/api";

/**
 * メッセージへの操作 (既読、スター、移動、削除) の送信待ちキュー。
 * 操作はまず画面に反映し、サーバーへはここから順番に送る。通信できないときは
 * 端末に残しておき、繋がったら送り直す (操作ごとの ID で二重実行を防ぐ)。
 */

/** 操作の内容 (対象と、操作ごとの ID を除いたもの)。 */
export type MessageActionInput =
  | { action: "set_flags"; seen?: boolean; flagged?: boolean }
  | { action: "move"; mailboxId: string }
  | { action: "move"; destination: "inbox" | "archive" | "trash" | "junk" }
  | { action: "delete" };

const STORAGE_KEY = "mail.pending-actions";
const MIN_DELAY = 2_000;
const MAX_DELAY = 60_000;
/** 端末に残す操作の上限。超えた分は古いものから捨てる。 */
const MAX_PENDING = 500;

/**
 * まだサーバーへ送れていない操作を、取得した一覧に重ねる。
 * 一覧を取得し直しても、送信待ちの操作が画面から消えないようにする。
 */
export function applyActions(
  messages: MessageSummary[],
  actions: MessageAction[],
): MessageSummary[] {
  let result = messages;
  for (const action of actions) {
    const ids = new Set(action.messageIds);
    if (action.action === "set_flags") {
      result = result.map((message) =>
        ids.has(message.id)
          ? {
              ...message,
              ...(action.seen === undefined ? {} : { seen: action.seen }),
              ...(action.flagged === undefined
                ? {}
                : { flagged: action.flagged }),
            }
          : message,
      );
    } else {
      // 移動と削除では、いま見ているフォルダから無くなる。
      // 移動先がそのメッセージのあるフォルダ自身なら、何も起きない。
      result = result.filter(
        (message) =>
          !ids.has(message.id) ||
          (action.action === "move" && action.mailboxId === message.mailboxId),
      );
    }
  }
  return result;
}

function isAction(value: unknown): value is MessageAction {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.idempotencyKey === "string" &&
    Array.isArray(record.messageIds) &&
    (record.action === "set_flags" ||
      record.action === "move" ||
      record.action === "delete")
  );
}

function load(): MessageAction[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.filter(isAction) : [];
  } catch {
    return [];
  }
}

export type ActionQueue = {
  /** まだサーバーへ送れていない操作 (古い順)。 */
  pending: () => MessageAction[];
  enqueue: (action: MessageAction) => void;
  /** サーバーに拒否されて取り消された操作を受け取る。戻り値の関数で解除する。 */
  onRejected: (listener: (action: MessageAction) => void) => () => void;
  stop: () => void;
};

export function createActionQueue(
  send: (action: MessageAction) => Promise<void> = sendMessageAction,
): ActionQueue {
  let items = load();
  let flushing = false;
  let stopped = false;
  let delay = MIN_DELAY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(action: MessageAction) => void>();

  const save = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // 保存できなくても、このページを開いている間は送り続ける。
    }
  };

  const flush = async () => {
    if (flushing || stopped) return;
    flushing = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      for (;;) {
        const action = items[0];
        if (!action || stopped) return;
        try {
          await send(action);
        } catch (error) {
          const retryable =
            error instanceof NetworkError ||
            (error instanceof ApiError && error.status >= 500);
          if (retryable) {
            // 順番を保つため、先頭が送れるまで後続も送らない。
            timer = setTimeout(() => void flush(), delay);
            delay = Math.min(delay * 2, MAX_DELAY);
            return;
          }
          // ログアウトした場合は、次にログインしたときに送り直す。
          if (error instanceof ApiError && error.status === 401) return;
          // サーバーに拒否された (対象が無いなど)。送り直しても通らないので捨てる。
          for (const listener of listeners) listener(action);
        }
        delay = MIN_DELAY;
        items = items.filter(
          (item) => item.idempotencyKey !== action.idempotencyKey,
        );
        save();
      }
    } finally {
      flushing = false;
    }
  };

  const onOnline = () => {
    delay = MIN_DELAY;
    void flush();
  };
  window.addEventListener("online", onOnline);
  void flush();

  return {
    pending: () => items,
    enqueue(action) {
      items = [...items, action].slice(-MAX_PENDING);
      save();
      void flush();
    },
    onRejected(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    },
  };
}
