import {
  ApiError,
  NetworkError,
  type SendMailInput,
  type UploadedAttachment,
} from "@/lib/api";
import type { LocalStore } from "@/lib/offline/store";

/**
 * 接続後に送るメールの待ち行列 (端末内)。
 * サーバーに届かないときに送信したメールを預かり、届くようになったら古い順に送る。
 * 送信ごとの ID (idempotencyKey) をそのまま使うので、送り直しても二重には送られない。
 */

export type QueuedSend = {
  /** 送信ごとの ID (input.idempotencyKey と同じ)。 */
  id: string;
  input: SendMailInput;
  /** 添付ファイルの名前と大きさ (表示と、編集に戻すときに使う)。 */
  attachments: UploadedAttachment[];
  createdAt: string;
  /**
   * サーバーに断られた理由 (API のエラーコード)。断られたメールは自動では送り直さず、
   * 編集するか破棄するまで残す。まだ送っていなければ null。
   */
  error: string | null;
};

export type OutboxOptions = {
  send: (input: SendMailInput) => Promise<void>;
  /** サーバーに届かなかったときに、やり直すまでの時間 (回数ごとに倍にする)。 */
  retryMs?: number;
  maxRetryMs?: number;
};

export class SendOutbox {
  private list: QueuedSend[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly sentListeners = new Set<(item: QueuedSend) => void>();
  private flushing: Promise<void> | null = null;
  private inFlight: string | null = null;
  private stopped = false;
  private delay: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: LocalStore,
    private readonly options: OutboxOptions,
  ) {
    this.delay = options.retryMs ?? 2_000;
  }

  /** 再読み込みしても残る保存先でだけ、メールを預かれる。 */
  get available(): boolean {
    return this.store.persistent;
  }

  /** 端末に残っている送信待ちを読み込む。 */
  async load(): Promise<void> {
    const saved = await this.store.list<QueuedSend>("outbox");
    this.list = saved.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    this.notify();
  }

  /** 送信待ちのメール (古い順)。中身が変わるまで同じ配列を返す。 */
  items(): QueuedSend[] {
    return this.list;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 預かっていたメールをサーバーへ渡せたときに呼ばれる処理を登録する。 */
  onSent(listener: (item: QueuedSend) => void): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  async enqueue(
    input: SendMailInput,
    attachments: UploadedAttachment[],
  ): Promise<void> {
    const item: QueuedSend = {
      id: input.idempotencyKey,
      input,
      attachments,
      createdAt: new Date().toISOString(),
      error: null,
    };
    await this.store.write([
      { type: "put", table: "outbox", key: item.id, value: item },
    ]);
    this.list = [...this.list.filter((other) => other.id !== item.id), item];
    this.notify();
  }

  /**
   * 送信待ちから取り除く (取り消し、または編集に戻すとき)。
   * ちょうど送っている最中で取り除けなければ false。
   */
  async remove(id: string): Promise<boolean> {
    if (this.inFlight === id) return false;
    await this.store.write([{ type: "delete", table: "outbox", key: id }]);
    this.list = this.list.filter((item) => item.id !== id);
    this.notify();
    return true;
  }

  /** 送信待ちを古い順に送る。届かなければ、時間を置いてやり直す。 */
  flush(): Promise<void> {
    this.flushing ??= this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** 接続が戻ったときに呼ぶ。待ち時間を戻して、すぐに送る。 */
  retryNow(): void {
    this.delay = this.options.retryMs ?? 2_000;
    void this.flush();
  }

  private async run(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (;;) {
      const item = this.list.find((candidate) => candidate.error === null);
      if (!item || this.stopped) return;
      this.inFlight = item.id;
      try {
        await this.options.send(item.input);
      } catch (error) {
        this.inFlight = null;
        const retryable =
          error instanceof NetworkError ||
          (error instanceof ApiError &&
            (error.status === 429 || error.status >= 500));
        if (retryable) {
          if (!this.stopped) {
            this.timer = setTimeout(() => void this.flush(), this.delay);
            this.delay = Math.min(
              this.delay * 2,
              this.options.maxRetryMs ?? 60_000,
            );
          }
          return;
        }
        // ログアウトした場合は、次にログインしたときに送り直す。
        if (error instanceof ApiError && error.status === 401) return;
        // サーバーに断られた。送り直しても通らないので、理由を添えて残す。
        const rejected: QueuedSend = {
          ...item,
          error:
            error instanceof ApiError ? (error.code ?? "rejected") : "rejected",
        };
        await this.store
          .write([
            { type: "put", table: "outbox", key: item.id, value: rejected },
          ])
          .catch(() => {});
        this.list = this.list.map((other) =>
          other.id === item.id ? rejected : other,
        );
        this.notify();
        continue;
      }
      this.inFlight = null;
      this.delay = this.options.retryMs ?? 2_000;
      await this.store
        .write([{ type: "delete", table: "outbox", key: item.id }])
        .catch(() => {});
      this.list = this.list.filter((other) => other.id !== item.id);
      this.notify();
      for (const listener of this.sentListeners) listener(item);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
