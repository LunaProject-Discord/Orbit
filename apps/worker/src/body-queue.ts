import type { BodyFetchPriority } from "@mail/core";

const RANK: Record<BodyFetchPriority, number> = {
  open: 0,
  hover: 1,
  visible: 2,
};

/**
 * 待たせておく hover の数。カーソルを次々に動かしても、取得するのは最後のいくつかだけにする
 * (古いものは、もう開かれそうにない)。
 */
const MAX_WAITING_HOVER = 2;

/**
 * 先に取得する本文の待ち行列。
 * - 開いたメール → カーソルを載せたメール → 画面に見えている行、の順に取り出す。
 * - 開いたメールとカーソルを載せたメールは新しい依頼から、見えている行は渡された順 (上から)。
 * - 見えている行は、新しい依頼が来たら前の依頼の待ち分を捨てる (もう画面に無い)。
 * - 同時に実行する数は concurrency まで。実行中や待っているメールへの依頼は重ねない。
 */
export class BodyQueue {
  /** 待っているメール。挿入順が依頼の順になる。 */
  private readonly waiting = new Map<string, BodyFetchPriority>();
  private readonly running = new Set<string>();
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly run: (messageId: string) => Promise<void>,
    private readonly concurrency = 1,
  ) {}

  request(messageIds: string[], priority: BodyFetchPriority) {
    if (priority === "visible") {
      for (const [id, waiting] of this.waiting) {
        if (waiting === "visible") this.waiting.delete(id);
      }
    }
    for (const id of messageIds) {
      if (this.running.has(id)) continue;
      const current = this.waiting.get(id);
      if (current !== undefined && RANK[current] < RANK[priority]) continue;
      // 入れ直して、同じ優先度の中で最も新しい依頼にする。
      this.waiting.delete(id);
      this.waiting.set(id, priority);
    }
    const hovers = [...this.waiting].filter(([, value]) => value === "hover");
    for (const [id] of hovers.slice(0, -MAX_WAITING_HOVER)) {
      this.waiting.delete(id);
    }
    this.pump();
  }

  /** 待ちも実行中も無くなったら解決する。 */
  idle(): Promise<void> {
    if (this.waiting.size === 0 && this.running.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private next(): string | undefined {
    let best: { id: string; rank: number } | undefined;
    for (const [id, priority] of this.waiting) {
      const rank = RANK[priority];
      // 見えている行は先に入れた方 (上の行) から、それ以外は後に入れた方 (新しい依頼) から。
      const wins =
        !best ||
        rank < best.rank ||
        (rank === best.rank && priority !== "visible");
      if (wins) best = { id, rank };
    }
    return best?.id;
  }

  private pump() {
    while (this.running.size < this.concurrency) {
      const id = this.next();
      if (id === undefined) break;
      this.waiting.delete(id);
      this.running.add(id);
      this.run(id)
        .catch(() => {})
        .finally(() => {
          this.running.delete(id);
          this.pump();
        });
    }
    if (this.waiting.size === 0 && this.running.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
