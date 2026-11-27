import type { MessageAction, MessageSummary } from "@/lib/api";
import type {
  PendingShare,
  SharedAction,
  SharedSent,
} from "@/lib/pending-share";
import type { PendingMarkRead } from "@/lib/unified-match";

/**
 * 画面に重ねる、まだサーバーの値に表れていない操作をまとめて持つ。
 *
 * - このウィンドウの送信待ちの操作と、操作したときの行の控え。
 * - ほかのウィンドウの送信待ちの操作 (PendingShare で受け取る)。
 * - サーバーが受け付けたが、まだ取得し直していない操作 (settled)。受け付けた直後に重ねるのを
 *   やめると、サーバーから取り直すまでの間、未読数などが操作の前の値に一瞬戻ってしまう。
 *   受け付けた後に始めた取得が終わったら捨てる。
 */

/** 重ねる先。一覧、フォルダの未読数、統合フォルダの未読数で、取り直す時機が違う。 */
export type OverlayTarget = "list" | "mailboxes" | "unified";

type Settled = {
  /** サーバーが受け付けたのを知った時刻。 */
  at: number;
  /** その後に始めたフォルダ・統合フォルダの取得が終わった。 */
  mailboxes: boolean;
  unified: boolean;
} & (
  | { kind: "action"; shared: SharedAction }
  | { kind: "markRead"; entry: PendingMarkRead }
);

/** サーバーが受け付けた操作を、取り直しが済んでいなくても捨てるまでの時間。 */
const SETTLED_MAX_MS = 20_000;

export type OverlaySources = {
  actions: MessageAction[];
  snapshots: Map<string, readonly MessageSummary[]>;
  origins: Map<string, string>;
  markRead: PendingMarkRead[];
};

export class PendingOverlay {
  /** このウィンドウの操作ごとの、操作したときの行の控え。 */
  readonly snapshots = new Map<string, readonly MessageSummary[]>();
  /** このウィンドウの操作ごとの、控えを取った統合フォルダ。 */
  readonly origins = new Map<string, string>();
  /** このウィンドウで「すべて既読にする」の応答を待っているフォルダ。 */
  private markReads: PendingMarkRead[] = [];
  private settled: Settled[] = [];
  /** 次に知らせる、サーバーが受け付けたもの。 */
  private sentBuffer: SharedSent = { actions: [], markRead: [] };

  constructor(private readonly share: PendingShare | null) {}

  /** 操作したときの行を控える。 */
  record(
    key: string,
    rows: readonly MessageSummary[],
    origin: string | null,
  ): void {
    if (rows.length > 0) this.snapshots.set(key, rows);
    if (origin) this.origins.set(key, origin);
  }

  /** このウィンドウの操作をサーバーが受け付けた。 */
  sent(action: MessageAction): void {
    const shared: SharedAction = {
      action,
      rows: this.snapshots.get(action.idempotencyKey) ?? [],
      origin: this.origins.get(action.idempotencyKey) ?? null,
    };
    this.settle({ kind: "action", shared });
    this.sentBuffer.actions.push(shared);
  }

  /** ほかのウィンドウの操作をサーバーが受け付けた。 */
  remoteSent(sent: SharedSent): void {
    for (const shared of sent.actions) this.settle({ kind: "action", shared });
    for (const entry of sent.markRead) this.settle({ kind: "markRead", entry });
  }

  /** 「すべて既読にする」を始めた。 */
  startMarkRead(entry: PendingMarkRead): void {
    this.markReads = [
      ...this.markReads.filter((item) => item.mailboxId !== entry.mailboxId),
      entry,
    ];
  }

  /** 「すべて既読にする」が終わった。ok が false なら、重ねるのをやめる。 */
  finishMarkRead(mailboxId: string, ok: boolean): void {
    const entry = this.markReads.find((item) => item.mailboxId === mailboxId);
    if (!entry) return;
    this.markReads = this.markReads.filter((item) => item !== entry);
    if (ok) {
      this.settle({ kind: "markRead", entry });
      this.sentBuffer.markRead.push(entry);
    }
  }

  private settle(
    item:
      | { kind: "action"; shared: SharedAction }
      | { kind: "markRead"; entry: PendingMarkRead },
  ): void {
    this.settled.push({
      ...item,
      at: Date.now(),
      mailboxes: false,
      unified: false,
    });
  }

  /**
   * target の取得 (started に始めたもの) が終わった。それより前に受け付けた操作は、
   * 取得した値に表れているので重ねない。
   */
  fresh(target: "mailboxes" | "unified", started: number): void {
    for (const item of this.settled) {
      if (item.at <= started) item[target] = true;
    }
    this.pruneSettled();
  }

  private pruneSettled(): void {
    const now = Date.now();
    this.settled = this.settled.filter(
      (item) =>
        !(item.mailboxes && item.unified) && now - item.at < SETTLED_MAX_MS,
    );
  }

  /** ほかのウィンドウへ、このウィンドウの送信待ちを知らせる。 */
  publish(pending: readonly MessageAction[]): void {
    if (!this.share) return;
    const sent = this.sentBuffer;
    this.sentBuffer = { actions: [], markRead: [] };
    this.share.publish(
      {
        actions: pending.map((action) => ({
          action,
          rows: this.snapshots.get(action.idempotencyKey) ?? [],
          origin: this.origins.get(action.idempotencyKey) ?? null,
        })),
        markRead: this.markReads,
      },
      sent,
    );
  }

  /** 送信待ちから外れた操作の控えを捨てる (受け付けた分は settled に移してある)。 */
  prune(pending: readonly MessageAction[]): void {
    const keys = new Set(pending.map((action) => action.idempotencyKey));
    for (const key of this.snapshots.keys()) {
      if (!keys.has(key)) this.snapshots.delete(key);
    }
    for (const key of this.origins.keys()) {
      if (!keys.has(key)) this.origins.delete(key);
    }
  }

  /**
   * target に重ねる操作。古いものから順に、受け付け済みの操作、ほかのウィンドウの操作、
   * このウィンドウの送信待ちの操作。同じ操作は 1 回だけ重ねる。
   */
  sources(
    pending: readonly MessageAction[],
    target: OverlayTarget,
  ): OverlaySources {
    this.prune(pending);
    this.pruneSettled();
    const actions: MessageAction[] = [];
    const snapshots = new Map<string, readonly MessageSummary[]>();
    const origins = new Map<string, string>();
    const markRead: PendingMarkRead[] = [];
    const seen = new Set<string>();
    const local = new Set(pending.map((action) => action.idempotencyKey));
    const remote = this.share?.actions() ?? [];
    const remoteKeys = new Set(
      remote.map((item) => item.action.idempotencyKey),
    );
    const add = (shared: SharedAction) => {
      const key = shared.action.idempotencyKey;
      if (seen.has(key)) return;
      seen.add(key);
      actions.push(shared.action);
      if (shared.rows.length > 0) snapshots.set(key, shared.rows);
      if (shared.origin) origins.set(key, shared.origin);
    };
    for (const item of this.settled) {
      if (target !== "list" && item[target]) continue;
      if (item.kind === "markRead") {
        markRead.push(item.entry);
        continue;
      }
      const key = item.shared.action.idempotencyKey;
      // まだどこかで送信待ちなら、そちらで重ねる。
      if (local.has(key) || remoteKeys.has(key)) continue;
      add(item.shared);
    }
    for (const shared of remote) {
      if (!local.has(shared.action.idempotencyKey)) add(shared);
    }
    for (const action of pending) {
      add({
        action,
        rows: this.snapshots.get(action.idempotencyKey) ?? [],
        origin: this.origins.get(action.idempotencyKey) ?? null,
      });
    }
    markRead.push(...(this.share?.markRead() ?? []), ...this.markReads);
    return { actions, snapshots, origins, markRead };
  }

  /** ほかのウィンドウに、先に重ねた分を戻すため表示を取り直してもらう。 */
  requestReload(): void {
    this.share?.requestReload();
  }

  close(): void {
    this.share?.close();
  }
}

/** 「すべて既読にする」の応答を待っているフォルダの行を、既読にして出す。 */
export function markRowsRead(
  rows: MessageSummary[],
  markRead: readonly PendingMarkRead[],
): MessageSummary[] {
  if (markRead.length === 0) return rows;
  const ids = new Set(markRead.map((entry) => entry.mailboxId));
  let changed = false;
  const result = rows.map((row) => {
    if (row.seen || !ids.has(row.mailboxId)) return row;
    changed = true;
    return { ...row, seen: true, unseenIds: [] };
  });
  return changed ? result : rows;
}
