/**
 * 検索での文字のそろえ方。DB の mail_search_normalize (マイグレーション 0037) と同じく、
 * NFKC (全角英数・半角カナなどをそろえる) → 小文字 → 空白・ゼロ幅文字・制御文字を除く。
 *
 * apps/api/src/lib/search-fold.ts の写し (オフラインの検索と、一覧で語を目立たせるのに使う)。
 * 変えるときは両方と DB の関数 (mail_search_normalize) を合わせて直すこと。
 */

/** 除く文字 (空白、ゼロ幅文字、制御文字)。DB の mail_search_normalize と同じ。 */
const IGNORED =
  /[\s\p{Cc}\u00ad\u200b-\u200f\u2028-\u202f\u205f-\u2064\ufeff]/u;
const IGNORED_ALL = new RegExp(IGNORED.source, "gu");

/** 検索用にそろえた文字列。 */
export function foldForSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(IGNORED_ALL, "");
}

/** 直後の文字と合わせてそろえる文字 (結合文字と、半角の濁点・半濁点)。 */
const COMBINING = /[\p{M}\uff9e\uff9f]/u;

/**
 * そろえた文字列と、その各位置 (UTF-16) が元の文字列のどこからどこまでに当たるか。
 * 文字ごと (結合文字は前の文字とまとめて) にそろえるので、文字列全体をそろえた結果と
 * ごくまれに違うことがある (目立たせる位置や抜粋に使うだけなので、ずれても害は小さい)。
 */
export function foldWithMap(text: string): {
  folded: string;
  start: number[];
  end: number[];
} {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  const chars = Array.from(text);
  let offset = 0;
  for (let i = 0; i < chars.length; ) {
    let cluster = chars[i] as string;
    let j = i + 1;
    while (j < chars.length && COMBINING.test(chars[j] as string)) {
      cluster += chars[j];
      j += 1;
    }
    const piece = foldForSearch(cluster);
    for (let k = 0; k < piece.length; k++) {
      start.push(offset);
      end.push(offset + cluster.length);
    }
    folded += piece;
    offset += cluster.length;
    i = j;
  }
  return { folded, start, end };
}

/**
 * text の中で needle (そろえる前の語) が現れる範囲 (元の文字列の位置)。
 * 最初に現れたものを返し、無ければ null。
 */
export function findFolded(
  text: string,
  needle: string,
  mapped = foldWithMap(text),
): { start: number; end: number } | null {
  const target = foldForSearch(needle);
  if (target === "") return null;
  const index = mapped.folded.indexOf(target);
  if (index === -1) return null;
  return {
    start: mapped.start[index] as number,
    end: mapped.end[index + target.length - 1] as number,
  };
}
