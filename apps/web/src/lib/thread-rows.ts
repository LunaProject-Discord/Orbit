import type { MessageAction, MessageSummary, ThreadMessage } from "@/lib/api";

/**
 * 一覧で会話の行を広げたときの、中のメールの並び。
 * 一覧の 1 行は会話 1 つで、広げるとその下に会話のメールを 1 通ずつ並べる。
 */

/** 広げた会話の中身。行の ID から、会話のメール (古い順) か、取得の失敗を引く。未取得なら入っていない。 */
export type ThreadRows = ReadonlyMap<string, ThreadMessage[] | "error">;

/** 一覧に並べる 1 行。 */
export type ListItem =
  /** 会話 (または 1 通だけのメール) の行。index は会話の並びの中での位置。 */
  | { kind: "row"; message: MessageSummary; index: number }
  /** 広げた会話の中の 1 通。 */
  | { kind: "child"; parent: MessageSummary; child: ThreadMessage }
  /** 広げた会話の中身を取得中、または取得に失敗した。 */
  | { kind: "status"; parent: MessageSummary; status: "loading" | "error" };

/** 会話の行と、広げた会話の中のメールを、画面に並ぶ順に並べる。中のメールは新しい順。 */
export function flattenRows(
  messages: readonly MessageSummary[],
  expandedIds: ReadonlySet<string>,
  threads: ThreadRows,
): ListItem[] {
  const items: ListItem[] = [];
  messages.forEach((message, index) => {
    items.push({ kind: "row", message, index });
    if (message.threadCount <= 1 || !expandedIds.has(message.id)) return;
    const thread = threads.get(message.id);
    if (thread === undefined || thread === "error") {
      items.push({
        kind: "status",
        parent: message,
        status: thread === "error" ? "error" : "loading",
      });
      return;
    }
    for (let at = thread.length - 1; at >= 0; at--) {
      const child = thread[at];
      if (child) items.push({ kind: "child", parent: message, child });
    }
  });
  return items;
}

/** 行を見分ける値 (描画のキー)。 */
export function itemKey(item: ListItem): string {
  if (item.kind === "row") return item.message.id;
  if (item.kind === "child") return `${item.parent.id}:${item.child.id}`;
  return `${item.parent.id}:status`;
}

/** いま開いているもの。childId があれば、会話の中のその 1 通だけを開いている。 */
export type OpenItem = { rowId: string; childId: string | null };

/** 開いているものの、並びの中での位置。無ければ -1。 */
export function indexOfOpen(
  items: readonly ListItem[],
  open: OpenItem | null,
): number {
  if (!open) return -1;
  return items.findIndex((item) =>
    open.childId === null
      ? item.kind === "row" && item.message.id === open.rowId
      : item.kind === "child" &&
        item.parent.id === open.rowId &&
        item.child.id === open.childId,
  );
}

/**
 * 次 (step = 1) や前 (step = -1) の、開ける行を返す。取得中の表示は飛ばす。
 * from が -1 なら先頭から探す。
 */
export function stepItem(
  items: readonly ListItem[],
  from: number,
  step: 1 | -1,
): ListItem | null {
  for (
    let at = from === -1 ? 0 : from + step;
    at >= 0 && at < items.length;
    at += step
  ) {
    const item = items[at];
    if (item && item.kind !== "status") return item;
  }
  return null;
}

/**
 * 操作 (既読、スター、移動、削除) を、広げた会話の中身にもすぐ反映する。
 * 移動や削除をしたメールは、取得し直すまでの間、並びから外す。
 */
export function applyActionToThreads(
  threads: ThreadRows,
  action: MessageAction,
): ThreadRows {
  const ids = new Set(action.messageIds);
  let changed = false;
  const next = new Map<string, ThreadMessage[] | "error">();
  for (const [rowId, thread] of threads) {
    if (thread === "error" || !thread.some((item) => ids.has(item.id))) {
      next.set(rowId, thread);
      continue;
    }
    changed = true;
    next.set(
      rowId,
      action.action === "set_flags"
        ? thread.map((item) =>
            ids.has(item.id)
              ? {
                  ...item,
                  seen: action.seen ?? item.seen,
                  flagged: action.flagged ?? item.flagged,
                }
              : item,
          )
        : thread.filter((item) => !ids.has(item.id)),
    );
  }
  return changed ? next : threads;
}
