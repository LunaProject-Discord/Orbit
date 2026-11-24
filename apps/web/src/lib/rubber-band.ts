/**
 * 一覧のドラッグによる範囲選択 (ラバーバンド選択)。PC のデスクトップやエクスプローラーと同じく、
 * マウスで四角を描き、その四角に掛かった行を選ぶ。ここには画面に依存しない計算だけを置く。
 */

/** ドラッグとみなすまでに動かす距離 (px)。これより小さければクリックとして扱う。 */
export const BAND_THRESHOLD = 4;

/**
 * ドラッグを始めたときに押していたキーで決まる、選び方。
 * - replace: 掛かった行だけを選ぶ (何も押していない)。
 * - add: 元の選択に、掛かった行を加える (Shift)。
 * - toggle: 掛かった行の選択を反転する (Ctrl / ⌘)。
 */
export type BandMode = "replace" | "add" | "toggle";

export function bandMode(keys: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): BandMode {
  if (keys.ctrlKey || keys.metaKey) return "toggle";
  if (keys.shiftKey) return "add";
  return "replace";
}

/** 一覧の 1 行の縦の位置 (スクロールする中身の先頭からの距離)。 */
export type BandRow = { id: string; start: number; end: number };

/** 縦の範囲 [top, bottom] に掛かる行の ID を、並び順のまま返す。 */
export function rowsInBand(
  rows: readonly BandRow[],
  top: number,
  bottom: number,
): string[] {
  const from = Math.min(top, bottom);
  const to = Math.max(top, bottom);
  const hit: string[] = [];
  for (const row of rows) {
    // 端がちょうど接しているだけの行は含めない。
    if (row.end > from && row.start < to) hit.push(row.id);
  }
  return hit;
}

/** ドラッグを始めたときの選択 (base) と、四角に掛かった行から、新しい選択を作る。 */
export function combineBand(
  base: ReadonlySet<string>,
  hit: readonly string[],
  mode: BandMode,
): Set<string> {
  if (mode === "replace") return new Set(hit);
  const next = new Set(base);
  for (const id of hit) {
    if (mode === "toggle" && base.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** 選択が同じ中身かどうか (同じなら描画し直さないため)。 */
export function sameSelection(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** 自動スクロールを始める、枠の上下の端からの距離 (px)。 */
export const AUTO_SCROLL_EDGE = 40;
/** 自動スクロールの 1 フレームあたりの最大の移動量 (px)。 */
export const AUTO_SCROLL_MAX = 24;

/**
 * カーソルが枠の上下の端に近づいたときの、1 フレームあたりのスクロール量。
 * 端に近いほど (枠の外へ出るほど) 速くし、上ならマイナス、下ならプラスを返す。
 */
export function autoScrollStep(
  pointerY: number,
  viewTop: number,
  viewBottom: number,
  edge = AUTO_SCROLL_EDGE,
  max = AUTO_SCROLL_MAX,
): number {
  const ratio = (distance: number) =>
    Math.min(1, Math.max(0, (edge - distance) / edge));
  if (pointerY < viewTop + edge) {
    return -Math.ceil(max * ratio(pointerY - viewTop));
  }
  if (pointerY > viewBottom - edge) {
    return Math.ceil(max * ratio(viewBottom - pointerY));
  }
  return 0;
}

/** 四角の、スクロールする中身の中での位置と大きさ。 */
export type BandRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** 始点と今の点から四角を作る。 */
export function bandRect(
  start: { x: number; y: number },
  current: { x: number; y: number },
): BandRect {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}
