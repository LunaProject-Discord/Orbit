import type { MessageSummary } from "@/lib/api";

/**
 * 条件で絞り込んだ一覧 (検索結果、スター付き、統合フォルダ) で、既読やスターの操作をした行を
 * 一覧に残す。未読だけの一覧で既読にすると、その行は条件から外れてサーバーの一覧に出なくなるが、
 * 操作した直後に行が消えると、どれを操作したのかが分からなくなる。
 * フォルダを切り替える、検索を変える、引っ張って更新するまでは、操作後の姿のまま置いておく。
 */

/**
 * 取得し直した一覧 (next) に、残すことにした行 (keptIds) のうち無くなったものを戻す。
 * 戻す行は、直前の一覧 (previous) にあった姿 (操作を反映済み) を使い、並び順 (compare) に合う位置へ入れる。
 * 同じ会話が別の行として next にあるとき (会話に新しいメールが届いて行の ID が変わった) は戻さない。
 */
export function keepRows(
  previous: readonly MessageSummary[],
  next: MessageSummary[],
  keptIds: ReadonlySet<string>,
  compare: (a: MessageSummary, b: MessageSummary) => number,
): MessageSummary[] {
  if (keptIds.size === 0) return next;
  const present = new Set<string>();
  for (const row of next) {
    present.add(row.id);
    for (const id of row.threadMessageIds) present.add(id);
  }
  const missing = previous.filter(
    (row) =>
      keptIds.has(row.id) &&
      !present.has(row.id) &&
      !row.threadMessageIds.some((id) => present.has(id)),
  );
  if (missing.length === 0) return next;
  return [...next, ...missing].sort(compare);
}
