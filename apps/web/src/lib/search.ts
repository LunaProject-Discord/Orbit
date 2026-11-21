import type { SearchFilters, SearchParams } from "@/lib/api";

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
 * 文字列を、検索した語に当たる部分とそれ以外に分ける (大文字と小文字は区別しない)。
 * 語が重なるときは、先に現れるもの、同じ位置なら長いものを優先する。
 */
export function highlightParts(text: string, terms: string[]): HighlightPart[] {
  const needles = terms
    .map((term) => term.toLowerCase())
    .filter((term) => term !== "");
  if (needles.length === 0 || text === "") return [{ text, match: false }];
  const lower = text.toLowerCase();
  // 小文字にすると長さが変わる文字があると位置がずれるので、その場合は目立たせない。
  if (lower.length !== text.length) return [{ text, match: false }];

  const parts: HighlightPart[] = [];
  let index = 0;
  while (index < text.length) {
    let start = -1;
    let length = 0;
    for (const needle of needles) {
      const found = lower.indexOf(needle, index);
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
    if (start > index) {
      parts.push({ text: text.slice(index, start), match: false });
    }
    parts.push({ text: text.slice(start, start + length), match: true });
    index = start + length;
  }
  if (index < text.length) {
    parts.push({ text: text.slice(index), match: false });
  }
  return parts;
}
