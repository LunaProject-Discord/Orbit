import type { MessageSummary } from "@/lib/api";

/**
 * メール一覧の並び順。サーバー (apps/api/src/lib/list-order.ts) と同じ決まりで並べる。
 * 読み込み済みの一覧に新しいページや操作の結果を差し込むときに使う。
 */
export type ListSortKey = "date" | "subject" | "from" | "to";
export type ListSort = { key: ListSortKey; order: "asc" | "desc" };

/** 標準の並び順 (新しい順)。 */
export const DEFAULT_SORT: ListSort = { key: "date", order: "desc" };

export function isDefaultSort(sort: ListSort): boolean {
  return sort.key === DEFAULT_SORT.key && sort.order === DEFAULT_SORT.order;
}

/** 件名の先頭の返信・転送の印。サーバーの SUBJECT_PREFIX と同じ。 */
const SUBJECT_PREFIX =
  /^(\s*(re|fwd?|aw|wg|sv|vs|tr|rif|antw|返信|転送)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i;

type Sortable = Pick<MessageSummary, "subject" | "from" | "to">;

/** 並べるときに比べる値 (date 以外)。 */
export function sortText(message: Sortable, key: Exclude<ListSortKey, "date">) {
  if (key === "subject") {
    return (message.subject ?? "")
      .replace(SUBJECT_PREFIX, "")
      .trim()
      .toLowerCase();
  }
  const first = (key === "from" ? message.from : message.to)[0];
  return (first?.name?.trim() || first?.address || "").toLowerCase();
}

/** 文字コード順で比べる (サーバーの照合順序 "C" に合わせる)。 */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i]?.codePointAt(0) ?? 0;
    const y = right[i]?.codePointAt(0) ?? 0;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}

/** 新しい順で比べる。a が b より後ろ (古い) なら正。 */
function newestFirst(a: MessageSummary, b: MessageSummary): number {
  if (a.receivedAt !== b.receivedAt)
    return a.receivedAt < b.receivedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 並び順で比べる関数。a が b より後ろなら正。
 * 日時以外で値が同じメールは、サーバーと同じく向きにかかわらず新しい順に並べる。
 */
export function sortComparator(
  sort: ListSort,
): (a: MessageSummary, b: MessageSummary) => number {
  if (sort.key === "date") {
    return sort.order === "desc" ? newestFirst : (a, b) => newestFirst(b, a);
  }
  const key = sort.key;
  const sign = sort.order === "asc" ? 1 : -1;
  return (a, b) => {
    const result = compareCodePoints(sortText(a, key), sortText(b, key));
    return result === 0 ? newestFirst(a, b) : Math.sign(result) * sign;
  };
}
