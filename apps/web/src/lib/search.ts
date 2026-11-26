import type { SearchFilters, SearchParams } from "@/lib/api";
import { foldForSearch, foldWithMap } from "@/lib/search-fold";

export const emptyFilters: SearchFilters = {
  from: "",
  to: "",
  subject: "",
  since: "",
  until: "",
  hasAttachment: false,
  unread: false,
  flagged: false,
};

/** 指定されている絞り込み条件の数 (期間は始まりと終わりで 1 つと数える)。 */
export function countFilters(filters: SearchFilters): number {
  return [
    filters.from.trim() !== "",
    filters.to.trim() !== "",
    filters.subject.trim() !== "",
    filters.since !== "" || filters.until !== "",
    filters.hasAttachment,
    filters.unread,
    filters.flagged,
  ].filter(Boolean).length;
}

/** 検索する内容があるか。何も無ければ、通常の一覧を表示する。 */
export function isSearchActive(
  params: Pick<SearchParams, "text" | "filters">,
): boolean {
  return params.text.trim() !== "" || countFilters(params.filters) > 0;
}

export type HighlightPart = { text: string; match: boolean };

/**
 * 文字列を、検索した語に当たる部分とそれ以外に分ける (全角と半角・大文字と小文字・空白の有無は区別しない)。
 * 語が重なるときは、先に現れるもの、同じ位置なら長いものを優先する。
 */
export function highlightParts(text: string, terms: string[]): HighlightPart[] {
  // 検索と同じく、全角と半角・大文字と小文字・空白の有無を区別せずに探す。
  const needles = terms
    .map((term) => foldForSearch(term))
    .filter((term) => term !== "");
  if (needles.length === 0 || text === "") return [{ text, match: false }];
  const mapped = foldWithMap(text);
  const folded = mapped.folded;

  const parts: HighlightPart[] = [];
  // index はそろえた文字列での位置、done は元の文字列でどこまで出したか。
  let index = 0;
  let done = 0;
  while (index < folded.length) {
    let start = -1;
    let length = 0;
    for (const needle of needles) {
      const found = folded.indexOf(needle, index);
      if (found === -1) continue;
      if (
        start === -1 ||
        found < start ||
        (found === start && needle.length > length)
      ) {
        start = found;
        length = needle.length;
      }
    }
    if (start === -1) break;
    const from = Math.max(done, mapped.start[start] as number);
    const to = mapped.end[start + length - 1] as number;
    if (from > done) {
      parts.push({ text: text.slice(done, from), match: false });
    }
    if (to > from) {
      parts.push({ text: text.slice(from, to), match: true });
      done = to;
    }
    index = start + length;
  }
  if (done < text.length) {
    parts.push({ text: text.slice(done), match: false });
  }
  return parts;
}
