import type { ComposeDraft } from "@/lib/compose";

/**
 * 下書き 1 回分の保存の結果。
 * - saved: 保存できた。revision はサーバーが付けた新しい番号。
 * - conflict: 他の端末が先に書き換えていた。revision はサーバーにある番号 (分からなければ null)。
 * - gone: 他の端末で送信または破棄されていた。
 * - retry: サーバーに届かなかった。時間を置いてやり直す。
 * - rejected: 内容に問題があって受け付けられなかった。やり直しても通らない。
 */
export type DraftSaveResult =
  | { status: "saved"; revision: number }
  | { status: "conflict"; revision: number | null }
  | { status: "gone" }
  | { status: "retry" }
  | { status: "rejected" };

export type DraftSaverEvent =
  /** 保存できた。settled は、この下書きにまだ保存していない変更が残っていないこと。 */
  | { type: "saved"; id: string; revision: number; settled: boolean }
  /**
   * 同じ ID では保存できなかったので、別の下書き (新しい ID) として保存し直す。
   * reason が conflict なら他の端末の内容も残っていて、gone なら残っていない。
   */
  | { type: "moved"; from: string; to: string; reason: "conflict" | "gone" }
  /** 保存できなかった。retrying なら時間を置いて自動でやり直し、違えば内容を直すまで保存できない。 */
  | { type: "error"; id: string; retrying: boolean };

export type DraftSaverOptions = {
  save: (
    draft: ComposeDraft,
    baseRevision: number | null,
  ) => Promise<DraftSaveResult>;
  onEvent: (event: DraftSaverEvent) => void;
  /** 入力が止まってから保存するまでの時間。 */
  delayMs?: number;
  /** サーバーに届かなかったときに、やり直すまでの時間 (回数ごとに倍にする)。 */
  retryMs?: number;
  maxRetryMs?: number;
  newId?: () => string;
};

/**
 * 下書きをサーバーへ保存する係。
 * 入力のたびに schedule を呼ぶと、入力が止まったところで保存する。
 * 保存は 1 件ずつ順に行い、同じ下書きの古い内容で新しい内容を上書きしない。
 * 他の端末と食い違ったときは、どちらの内容も失わないよう、別の下書きとして保存する。
 */
export class DraftSaver {
  private readonly pending = new Map<string, ComposeDraft>();
  /** サーバーにある revision。まだ保存していない下書きは入っていない。 */
  private readonly revisions = new Map<string, number>();
  /** 保存の途中で取り消された下書き。結果が返っても何もしない。 */
  private readonly dropped = new Set<string>();
  /** 別の下書きとして保存し直した下書きの、元の ID から新しい ID への対応。 */
  private readonly movedTo = new Map<string, string>();
  private inFlight: string | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private completed = 0;
  private stopped = false;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly newId: () => string;

  constructor(private readonly options: DraftSaverOptions) {
    this.delayMs = options.delayMs ?? 1_000;
    this.retryMs = options.retryMs ?? 5_000;
    this.maxRetryMs = options.maxRetryMs ?? 60_000;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** サーバーから受け取った下書きの revision を覚える。 */
  track(id: string, revision: number | null) {
    if (revision === null) this.revisions.delete(id);
    else this.revisions.set(id, revision);
  }

  /** サーバーにある revision。まだ保存していなければ null。 */
  revisionOf(id: string): number | null {
    return this.revisions.get(id) ?? null;
  }

  /** まだ保存していない変更があるか、保存の途中か。 */
  isBusy(id: string): boolean {
    return this.pending.has(id) || this.inFlight === id;
  }

  /** まだ保存していない内容。無ければ null。 */
  pendingDraft(id: string): ComposeDraft | null {
    return this.pending.get(id) ?? null;
  }

  /** 保存の結果を受け取った回数。途中で保存が挟まったかどうかの判定に使う。 */
  get version(): number {
    return this.completed;
  }

  /** 入力が止まったら保存する。 */
  schedule(draft: ComposeDraft) {
    if (this.stopped) return;
    // 保存し直したことが画面に伝わる前の入力は、元の ID のまま届く。
    const id = this.movedTo.get(draft.idempotencyKey) ?? draft.idempotencyKey;
    this.pending.set(id, { ...draft, idempotencyKey: id });
    this.dropped.delete(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** 待たずに保存する。保存が一通り終わる (または、やり直し待ちになる) と解決する。 */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * まだ保存していない変更を捨て、保存の途中なら終わるのを待つ。
   * 送信や破棄の前に呼び、あとから保存が届いて下書きが作り直されるのを防ぐ。
   */
  async cancel(id: string): Promise<void> {
    this.pending.delete(id);
    if (this.inFlight === id) this.dropped.add(id);
    while (this.inFlight === id && this.running) await this.running;
  }

  /** 送信または破棄した下書きを忘れる。 */
  async forget(id: string): Promise<void> {
    await this.cancel(id);
    this.revisions.delete(id);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.pending.entries().next().value;
      if (!next || this.stopped) return;
      const [id, draft] = next;
      this.pending.delete(id);
      const base = this.revisionOf(id);
      this.inFlight = id;
      let result: DraftSaveResult;
      try {
        result = await this.options.save(draft, base);
      } catch {
        result = { status: "retry" };
      }
      this.inFlight = null;
      this.completed++;
      if (this.dropped.delete(id)) continue;

      if (result.status === "saved") {
        this.retries = 0;
        this.revisions.set(id, result.revision);
        this.emit({
          type: "saved",
          id,
          revision: result.revision,
          settled: !this.pending.has(id),
        });
        continue;
      }
      if (
        result.status === "conflict" &&
        base === null &&
        result.revision !== null
      ) {
        // 作ったつもりの下書きがすでにあった (前回の保存の応答が届かなかった)。
        // 自分が作ったものなので、そのまま上書きする。
        this.revisions.set(id, result.revision);
        if (!this.pending.has(id)) this.pending.set(id, draft);
        continue;
      }
      if (result.status === "conflict" && result.revision === null) {
        result = { status: "retry" };
      }
      if (result.status === "conflict" || result.status === "gone") {
        // 同じ ID では保存できない。新しい ID の下書きとして保存し直す。
        const to = this.newId();
        const latest = this.pending.get(id) ?? draft;
        this.pending.delete(id);
        this.revisions.delete(id);
        this.pending.set(to, { ...latest, idempotencyKey: to });
        this.movedTo.set(id, to);
        this.emit({ type: "moved", from: id, to, reason: result.status });
        continue;
      }
      if (result.status === "retry") {
        // 新しい内容が来ていなければ、同じ内容でやり直す。
        if (!this.pending.has(id)) this.pending.set(id, draft);
        this.emit({ type: "error", id, retrying: true });
        const delay = Math.min(
          this.retryMs * 2 ** this.retries,
          this.maxRetryMs,
        );
        this.retries++;
        if (!this.stopped) {
          this.retryTimer = setTimeout(() => void this.flush(), delay);
        }
        return;
      }
      this.emit({ type: "error", id, retrying: false });
    }
  }

  private emit(event: DraftSaverEvent) {
    if (!this.stopped) this.options.onEvent(event);
  }
}
