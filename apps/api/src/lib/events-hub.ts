import { CHANNEL_CHANGES, type ChangeNotification } from "@mail/core";
import pg from "pg";

type Listener = (seq: string) => void;

/**
 * 同期ワーカーが NOTIFY で知らせる変更を受け取り、該当する利用者の
 * SSE 接続へ配る。LISTEN 用に専用の接続を 1 本持ち、切れたら張り直す。
 */
export class EventsHub {
  private listeners = new Map<string, Set<Listener>>();
  private client: pg.Client | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly connectionString: string) {}

  async start() {
    await this.connect().catch((error) => {
      console.error("変更通知の待ち受けに失敗しました。再試行します。", error);
      this.scheduleReconnect();
    });
  }

  private async connect() {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", (message) => {
      if (message.channel !== CHANNEL_CHANGES || !message.payload) return;
      try {
        const { userId, seq } = JSON.parse(
          message.payload,
        ) as ChangeNotification;
        for (const listener of this.listeners.get(userId) ?? []) {
          listener(seq);
        }
      } catch {
        // 形式の違う通知は無視する。
      }
    });
    const onLost = () => {
      if (this.client !== client) return;
      this.client = null;
      client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on("error", onLost);
    client.on("end", onLost);
    await client.connect();
    await client.query(`LISTEN ${CHANNEL_CHANGES}`);
    this.client = client;
    // 切れていた間の通知は失われるので、接続中の全端末に再取得を促す。
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener("resync");
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, 3_000);
  }

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
