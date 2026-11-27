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
  actions: readonly MessageAction[],
): MessageSummary[] {
  let result = messages;
  for (const action of actions) {
    const ids = new Set(action.messageIds);
    result = result.flatMap((message) => {
      // 一覧の 1 行は会話 1 つ。会話のうち、操作の対象になった分を調べる。
      const members = message.threadMessageIds;
      const hits = members.filter((id) => ids.has(id)).length;
      if (hits === 0) return [message];
      const all = hits === members.length;
      const unseen = knownUnseen(message);
      if (action.action === "set_flags") {
        // 行の既読は「すべて既読」、スターは「どれかに付いている」を表す。
        // 一部だけが対象のときは、結果が確実に決まる向きだけを反映する
        // (どれが未読か分かっている会話では、既読も正しく決める)。
        let seen =
          action.seen === undefined || (action.seen && !all)
            ? message.seen
            : action.seen;
        let unseenIds = message.unseenIds;
        if (action.seen !== undefined && unseen) {
          const next =
            action.seen === true
              ? unseen.filter((id) => !ids.has(id))
              : members.filter((id) => ids.has(id) || unseen.includes(id));
          unseenIds = next;
          seen = next.length === 0;
        } else if (action.seen !== undefined && unseenIds !== undefined) {
          // 分からなくなった (古い内容と食い違う) 控えは捨てる。
          unseenIds = undefined;
        }
        const flagged =
          action.flagged === undefined || (!action.flagged && !all)
            ? message.flagged
            : action.flagged;
        const next: MessageSummary = { ...message, seen, flagged };
        if (unseenIds === undefined) delete next.unseenIds;
        else next.unseenIds = unseenIds;
        return [next];
      }
      // 移動と削除では、いま見ているフォルダから無くなる。
      // 移動先がそのメッセージのあるフォルダ自身なら、何も起きない。
      if (action.action === "move" && action.mailboxId === message.mailboxId) {
        return [message];
      }
      if (all) return [];
      const rest: MessageSummary = {
        ...message,
        threadMessageIds: members.filter((id) => !ids.has(id)),
        threadCount: Math.max(1, message.threadCount - hits),
      };
      if (unseen) {
        rest.unseenIds = unseen.filter((id) => !ids.has(id));
        rest.seen = rest.unseenIds.length === 0;
      }
      return [rest];
    });
  }
  return result;
}

/**
 * 行 (会話) のうち未読のメッセージ。分からなければ null。
 * サーバーが返した unseenIds があればそれを使い、無ければ既読の値から分かる範囲で決める。
 */
export function knownUnseen(row: MessageSummary): string[] | null {
  const members = row.threadMessageIds;
  if (row.seen) return [];
  const listed = row.unseenIds?.filter((id) => members.includes(id));
  if (listed && listed.length > 0) return listed;
  if (members.length === 1) return members.slice();
  return null;
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
  /**
   * 操作を送信待ちに入れる。hold を true にすると、release を呼ぶまでサーバーへ送らない
   * (「元に戻す」を受け付ける間、送るのを待つ)。待っている間にページを閉じた場合は、
   * 次に開いたときに送る。
   */
  enqueue: (action: MessageAction, options?: { hold?: boolean }) => void;
  /** 送るのを待たせていた操作を送る。 */
  release: (idempotencyKey: string) => void;
  /**
   * 送るのを待たせていた操作を取り消す。取り消せたら true。
   * すでに送ったか、送っている途中なら false。
   */
  cancel: (idempotencyKey: string) => boolean;
  /** サーバーに拒否されて取り消された操作を受け取る。戻り値の関数で解除する。 */
  onRejected: (listener: (action: MessageAction) => void) => () => void;
  /** サーバーが受け付けた操作を受け取る。戻り値の関数で解除する。 */
  onSent: (listener: (action: MessageAction) => void) => () => void;
  /** 送れていない操作の数が変わるたびに呼ぶ。戻り値の関数で解除する。 */
  onChange: (listener: (count: number) => void) => () => void;
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

  const changeListeners = new Set<(count: number) => void>();
  const sentListeners = new Set<(action: MessageAction) => void>();

  /** 「元に戻す」を受け付けている間、送るのを待たせている操作。 */
  const held = new Set<string>();

  const save = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // 保存できなくても、このページを開いている間は送り続ける。
    }
    // 待たせている操作は、まだ「送れていない」ものには数えない。
    const count = items.filter((item) => !held.has(item.idempotencyKey)).length;
    for (const listener of changeListeners) listener(count);
  };

  /**
   * 次に送る操作。待たせている操作と、それと同じメールを対象にする後ろの操作は飛ばす
   * (同じメールへの操作は、行った順に送る)。
   */
  const next = (): MessageAction | undefined => {
    const waiting = new Set<string>();
    for (const item of items) {
      if (
        held.has(item.idempotencyKey) ||
        item.messageIds.some((id) => waiting.has(id))
      ) {
        for (const id of item.messageIds) waiting.add(id);
        continue;
      }
      return item;
    }
    return undefined;
  };
  /** いまサーバーへ送っている操作。 */
  let sending: string | null = null;

  const flush = async () => {
    if (flushing || stopped) return;
    flushing = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      for (;;) {
        const action = next();
        if (!action || stopped) return;
        try {
          sending = action.idempotencyKey;
          await send(action);
          for (const listener of sentListeners) {
            try {
              listener(action);
            } catch {
              // 受け取る側の失敗で、送れた操作を送り直さない。
            }
          }
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
      sending = null;
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
    enqueue(action, options) {
      if (options?.hold) held.add(action.idempotencyKey);
      items = [...items, action].slice(-MAX_PENDING);
      save();
      void flush();
    },
    release(idempotencyKey) {
      if (!held.delete(idempotencyKey)) return;
      save();
      void flush();
    },
    cancel(idempotencyKey) {
      if (sending === idempotencyKey) return false;
      if (!items.some((item) => item.idempotencyKey === idempotencyKey)) {
        return false;
      }
      held.delete(idempotencyKey);
      items = items.filter((item) => item.idempotencyKey !== idempotencyKey);
      save();
      // この操作の後ろで待っていた操作があれば、送る。
      void flush();
      return true;
    },
    onRejected(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSent(listener) {
      sentListeners.add(listener);
      return () => sentListeners.delete(listener);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    },
  };
}
