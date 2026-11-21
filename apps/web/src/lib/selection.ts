import type { MessageSummary } from "@/lib/api";

/** 一覧の複数選択。選択は行 (会話) の ID の集合で持つ。 */

/** 1 行の選択を切り替えた結果を返す。 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Shift を押しながらの選択。起点 (anchor) から id までの行をすべて選択に加える。
 * 起点が一覧に無ければ、id の行だけを加える。
 */
export function selectRange(
  order: readonly string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  id: string,
): Set<string> {
  const next = new Set(selected);
  const to = order.indexOf(id);
  if (to === -1) return next;
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from === -1) {
    next.add(id);
    return next;
  }
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const item = order[i];
    if (item !== undefined) next.add(item);
  }
  return next;
}

/** サーバーが 1 回の操作で受け付けるメッセージの上限。 */
export const ACTION_LIMIT = 100;

/**
 * 選択した行を、サーバーへ送る操作の単位に分ける。
 * アカウントごとに分け (移動先のフォルダがアカウントごとに違うため)、
 * 1 回の上限を超えないようにする。会話は、上限を超えない限り 1 回にまとめる
 * (分かれると、会話全体が対象かどうかを画面側で判断できない)。
 */
export function actionBatches(
  rows: readonly Pick<MessageSummary, "accountId" | "threadMessageIds">[],
  limit = ACTION_LIMIT,
): string[][] {
  const byAccount = new Map<string, string[][]>();
  for (const row of rows) {
    const batches = byAccount.get(row.accountId) ?? [];
    byAccount.set(row.accountId, batches);
    const ids = row.threadMessageIds;
    const last = batches.at(-1);
    if (last && last.length + ids.length <= limit) {
      last.push(...ids);
      continue;
    }
    for (let i = 0; i < ids.length; i += limit) {
      batches.push(ids.slice(i, i + limit));
    }
  }
  return [...byAccount.values()].flat();
}
