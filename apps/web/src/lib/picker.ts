/**
 * 絵文字を選ぶ画面のような一覧 (components/picker-grid.tsx) のための、
 * 行の並べ方と「最近使ったもの」の保存。アイコンと絵文字で共通に使う。
 */

/** 最近使ったものを覚えておく数。 */
export const RECENT_LIMIT = 18;

/** 最近使ったもの (新しい順)。端末ごとに localStorage の key へ覚える。 */
export function readRecent(key: string): string[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((item): item is string => typeof item === "string")
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** 使ったものを、最近使ったものの先頭に加える。 */
export function addRecent(key: string, item: string): string[] {
  const next = [
    item,
    ...readRecent(key).filter((other) => other !== item),
  ].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // 保存できなくても、選ぶこと自体には影響しない。
  }
  return next;
}

/** 一覧の 1 行。見出しか、選ぶものの並び。 */
export type PickerRow =
  | { kind: "heading"; section: string; label: string }
  | {
      kind: "items";
      section: string;
      names: readonly string[];
      /** この行の先頭が、一覧全体で何番目か。 */
      offset: number;
    };

/** 見出し付きの区切りを、決まった列数の行に並べる。 */
export function layoutPickerRows(
  sections: readonly { id: string; label: string; items: readonly string[] }[],
  columns: number,
): { rows: PickerRow[]; count: number } {
  const rows: PickerRow[] = [];
  let offset = 0;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    rows.push({ kind: "heading", section: section.id, label: section.label });
    for (let start = 0; start < section.items.length; start += columns) {
      const names = section.items.slice(start, start + columns);
      rows.push({ kind: "items", section: section.id, names, offset });
      offset += names.length;
    }
  }
  return { rows, count: offset };
}
