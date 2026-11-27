import type { MessageAction, MessageSummary } from "@/lib/api";
import type { PendingMarkRead } from "@/lib/unified-match";
import { randomUuid } from "@/lib/uuid";

/**
 * 同じ端末で開いているほかのウィンドウ (タブ) と、まだサーバーへ届いていない操作を伝え合う。
 *
 * 操作はウィンドウごとの送信待ちに入り、ほかのウィンドウはサーバーからの変更通知を受けて
 * 取得し直すまで古い表示のままになる。操作したときの内容 (操作と、操作したときの行の控え) を
 * BroadcastChannel で送り、受け取ったウィンドウは自分の操作と同じように一覧と未読数に重ねる。
 */

/** 1 つの操作と、操作したときの行の控え。 */
export type SharedAction = {
  action: MessageAction;
  rows: readonly MessageSummary[];
  /** 控えを取った統合フォルダ。 */
  origin: string | null;
};

/** サーバーが受け付けて、送信待ちから外れたもの。 */
export type SharedSent = {
  actions: SharedAction[];
  markRead: PendingMarkRead[];
};

/** あるウィンドウの、いまの送信待ちの内容。 */
export type SharedState = {
  actions: SharedAction[];
  markRead: PendingMarkRead[];
};

type Message =
  | { type: "state"; from: string; state: SharedState; sent: SharedSent }
  | { type: "hello"; from: string }
  | { type: "bye"; from: string }
  /** 取り消した (元に戻した・拒否された) ので、表示を取り直してほしい。 */
  | { type: "reload"; from: string };

const CHANNEL = "orbit.pending-actions";
/** 知らせが途絶えたウィンドウの操作を捨てるまでの時間。 */
const STALE_MS = 2 * 60_000;

/** ほかのウィンドウから届いた知らせ。 */
export type ShareEvent =
  /** 内容が変わった。sent はサーバーが受け付けて送信待ちから外れたもの。 */
  { type: "change"; sent: SharedSent } | { type: "reload" };

export type PendingShare = {
  /** このウィンドウの内容を知らせる。sent はサーバーが受け付けた操作。 */
  publish: (state: SharedState, sent?: SharedSent) => void;
  /** 表示を取り直すよう知らせる。 */
  requestReload: () => void;
  /** ほかのウィンドウの送信待ちの操作 (古い順)。 */
  actions: () => SharedAction[];
  markRead: () => PendingMarkRead[];
  subscribe: (listener: (event: ShareEvent) => void) => () => void;
  close: () => void;
};

const empty: SharedState = { actions: [], markRead: [] };
const nothing: SharedSent = { actions: [], markRead: [] };
/** 送信待ちがある間、届いていることを知らせ直す間隔。 */
const HEARTBEAT_MS = 30_000;

export function createPendingShare(): PendingShare {
  const self = randomUuid();
  const others = new Map<string, { state: SharedState; at: number }>();
  const listeners = new Set<(event: ShareEvent) => void>();
  let current: SharedState = empty;
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CHANNEL);

  const emit = (event: ShareEvent) => {
    for (const listener of listeners) listener(event);
  };
  const post = (message: Message) => {
    try {
      channel?.postMessage(message);
    } catch {
      // 送れない内容 (大きすぎるなど) は、サーバーからの変更通知に任せる。
    }
  };
  const prune = () => {
    const now = Date.now();
    for (const [from, entry] of others) {
      if (now - entry.at > STALE_MS) others.delete(from);
    }
  };

  if (channel) {
    channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (!message || typeof message !== "object" || message.from === self) {
        return;
      }
      switch (message.type) {
        case "hello":
          others.delete(message.from);
          if (current.actions.length > 0 || current.markRead.length > 0) {
            post({ type: "state", from: self, state: current, sent: nothing });
          }
          return;
        case "bye":
          if (others.delete(message.from)) {
            emit({ type: "change", sent: nothing });
          }
          return;
        case "reload":
          emit({ type: "reload" });
          return;
        case "state":
          others.set(message.from, { state: message.state, at: Date.now() });
          prune();
          emit({ type: "change", sent: message.sent });
          return;
      }
    };
    post({ type: "hello", from: self });
  }
  const onPageHide = () => post({ type: "bye", from: self });
  const heartbeat = channel
    ? setInterval(() => {
        if (current.actions.length > 0 || current.markRead.length > 0) {
          post({ type: "state", from: self, state: current, sent: nothing });
        }
      }, HEARTBEAT_MS)
    : null;
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }

  return {
    publish(state, sent = nothing) {
      current = state;
      post({ type: "state", from: self, state, sent });
    },
    requestReload() {
      post({ type: "reload", from: self });
    },
    actions() {
      prune();
      return [...others.values()].flatMap((entry) => entry.state.actions);
    },
    markRead() {
      prune();
      return [...others.values()].flatMap((entry) => entry.state.markRead);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      post({ type: "bye", from: self });
      if (heartbeat) clearInterval(heartbeat);
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
      channel?.close();
      listeners.clear();
    },
  };
}
