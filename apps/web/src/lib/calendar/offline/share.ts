/**
 * 複数のウィンドウ・タブ (8 章)。送信待ちも控えも IndexedDB に置いて全ウィンドウで共有し、
 * 配るのは「変わった」という合図だけ。受けたウィンドウは、その部分を IndexedDB から読み直す。
 *
 * - 合図: BroadcastChannel "orbit.calendar"。
 * - 送る役: Web Locks ("orbit.calendar.flush:<利用者 ID>") を取れたウィンドウだけが送信待ちを送る。
 *   Web Locks が無ければ、どのウィンドウも送る (再送は冪等なので、結果は変わらない)。
 */

export type ChangeMessage = {
  type: "changed";
  /** 送ったウィンドウ (自分の合図は無視する)。 */
  from: string;
  /** 利用者 (同じ端末で別の利用者のウィンドウがあっても混ざらないように)。 */
  user: string;
  /** 変わった予定の ID。 */
  events: string[];
  /** カレンダー・送信待ち・通知と meta (cursor、競合の控え) が変わったか。 */
  calendars: boolean;
  queue: boolean;
  notices: boolean;
};

export type Share = {
  readonly windowId: string;
  post(message: Omit<ChangeMessage, "type" | "from" | "user">): void;
  onMessage(listener: (message: ChangeMessage) => void): () => void;
  /**
   * 送る役を取れたら fn を実行して true。ほかのウィンドウが持っていれば実行せずに false。
   */
  withFlushLock(fn: () => Promise<void>): Promise<boolean>;
  close(): void;
};

const CHANNEL = "orbit.calendar";

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
};

/** ブラウザーの BroadcastChannel と Web Locks を使う。無い環境では何もしない (送る役は常に自分)。 */
export function createBrowserShare(userId: string): Share {
  const windowId = randomId();
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CHANNEL);
  const listeners = new Set<(message: ChangeMessage) => void>();
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as ChangeMessage | null;
      if (
        !message ||
        message.type !== "changed" ||
        message.from === windowId ||
        message.user !== userId
      ) {
        return;
      }
      for (const listener of listeners) listener(message);
    };
  }
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return {
    windowId,
    post(message) {
      try {
        channel?.postMessage({
          type: "changed",
          from: windowId,
          user: userId,
          ...message,
        } satisfies ChangeMessage);
      } catch {
        // 閉じた後などは送らない。
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async withFlushLock(fn) {
      if (!locks) {
        await fn();
        return true;
      }
      const result = await locks.request(
        `orbit.calendar.flush:${userId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return false;
          await fn();
          return true;
        },
      );
      return result === true;
    },
    close() {
      listeners.clear();
      channel?.close();
    },
  };
}

/**
 * メモリー上でつながった Share (テスト用。同じ hub の Share どうしで合図とロックを共有する)。
 * 合図は非同期 (queueMicrotask) に届く。
 */
export function createMemoryShareHub(): { create(userId: string): Share } {
  const members = new Set<{
    windowId: string;
    deliver: (message: ChangeMessage) => void;
  }>();
  const held = new Set<string>();
  return {
    create(userId) {
      const windowId = randomId();
      const listeners = new Set<(message: ChangeMessage) => void>();
      const member = {
        windowId,
        deliver: (message: ChangeMessage) => {
          if (message.user !== userId) return;
          for (const listener of listeners) listener(message);
        },
      };
      members.add(member);
      return {
        windowId,
        post(message) {
          const full: ChangeMessage = {
            type: "changed",
            from: windowId,
            user: userId,
            ...message,
          };
          for (const other of members) {
            if (other.windowId === windowId) continue;
            queueMicrotask(() => other.deliver(full));
          }
        },
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async withFlushLock(fn) {
          const name = `flush:${userId}`;
          if (held.has(name)) return false;
          held.add(name);
          try {
            await fn();
          } finally {
            held.delete(name);
          }
          return true;
        },
        close() {
          listeners.clear();
          members.delete(member);
        },
      };
    },
  };
}
