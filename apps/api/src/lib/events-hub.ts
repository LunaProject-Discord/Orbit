import {
  type AttachmentFetchError,
  type AttachmentReadyNotification,
  CHANNEL_ATTACHMENT_READY,
  CHANNEL_CHANGES,
  CHANNEL_NEW_MAIL,
  type ChangeNotification,
  type NewMailNotification,
  type PushMessage,
  toPushMessages,
} from "@mail/core";
import pg from "pg";

/** 端末へ伝える内容。change は変更があったこと、mail は新着メールの通知。 */
export type HubEvent =
  | { type: "change"; seq: string }
  | { type: "mail"; notifications: PushMessage[] };

type Listener = (event: HubEvent) => void;
type AttachmentWaiter = (error: AttachmentFetchError | null) => void;

/**
 * 同期ワーカーが NOTIFY で知らせる変更と新着メールを受け取り、該当する利用者の
 * SSE 接続へ配る。LISTEN 用に専用の接続を 1 本持ち、切れたら張り直す。
 * 添付ファイルの取得が終わった知らせも、同じ接続で受け取る。
 */
export class EventsHub {
  private listeners = new Map<string, Set<Listener>>();
  private attachmentWaiters = new Map<string, Set<AttachmentWaiter>>();
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
      if (!message.payload) return;
      if (message.channel === CHANNEL_ATTACHMENT_READY) {
        try {
          const { attachmentId, error } = JSON.parse(
            message.payload,
          ) as AttachmentReadyNotification;
          for (const waiter of this.attachmentWaiters.get(attachmentId) ?? []) {
            waiter(error ?? null);
          }
        } catch {
          // 形式の違う通知は無視する。
        }
        return;
      }
      try {
        if (message.channel === CHANNEL_NEW_MAIL) {
          const payload = JSON.parse(message.payload) as NewMailNotification;
          const event: HubEvent = {
            type: "mail",
            notifications: toPushMessages(payload),
          };
          for (const listener of this.listeners.get(payload.userId) ?? []) {
            listener(event);
          }
          return;
        }
        if (message.channel !== CHANNEL_CHANGES) return;
        const { userId, seq } = JSON.parse(
          message.payload,
        ) as ChangeNotification;
        for (const listener of this.listeners.get(userId) ?? []) {
          listener({ type: "change", seq });
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
    await client.query(`LISTEN ${CHANNEL_NEW_MAIL}`);
    await client.query(`LISTEN ${CHANNEL_ATTACHMENT_READY}`);
    this.client = client;
    // 切れていた間の通知は失われるので、接続中の全端末に再取得を促す。
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) {
        listener({ type: "change", seq: "resync" });
      }
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

  /**
   * 添付ファイルの取得が終わるのを待つ。先に待ち受けを始めてから request (同期ワーカーへの
   * 依頼) を呼ぶので、すぐに終わった場合も取りこぼさない。時間切れなら "timeout" を返す。
   */
  async waitForAttachment(
    attachmentId: string,
    request: () => Promise<void>,
    timeoutMs: number,
  ): Promise<AttachmentFetchError | "timeout" | null> {
    let waiter: AttachmentWaiter | undefined;
    let timer: NodeJS.Timeout | undefined;
    const set = this.attachmentWaiters.get(attachmentId) ?? new Set();
    this.attachmentWaiters.set(attachmentId, set);
    try {
      const result = new Promise<AttachmentFetchError | "timeout" | null>(
        (resolve) => {
          waiter = resolve;
          set.add(resolve);
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        },
      );
      await request();
      return await result;
    } finally {
      clearTimeout(timer);
      if (waiter) set.delete(waiter);
      if (set.size === 0) this.attachmentWaiters.delete(attachmentId);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
