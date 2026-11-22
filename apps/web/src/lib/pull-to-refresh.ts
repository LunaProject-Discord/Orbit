/**
 * 一覧を下へ引っ張って更新する操作 (pull to refresh) の、指の動きの判定。
 * 画面の部品は components/mail/pull-to-refresh.tsx。
 */

/** 指を離したときに更新を始める、印を引き下げた量 (px)。 */
export const PULL_THRESHOLD = 64;
/** 印を引き下げられる量の上限 (px)。 */
export const PULL_MAX = 96;
/** これだけ動くまでは、引っ張りかどうかを決めない (px)。 */
const PULL_SLOP = 8;

/**
 * 指の動きを、印を引き下げる量に直す。指の動きの半分だけ動かし、
 * 上限に近づくほど重くする (引っ張っている手応え)。
 */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  const half = dy * 0.5;
  if (half <= PULL_THRESHOLD) return half;
  const over = half - PULL_THRESHOLD;
  const room = PULL_MAX - PULL_THRESHOLD;
  return PULL_THRESHOLD + room * (1 - 1 / (1 + over / room));
}

/**
 * 指の動きが「下へ引っ張っている」か。まだ決められなければ null。
 * 横の動き (行のスワイプ) や、上への動き (ふつうのスクロール) は引っ張りではない。
 */
export function pullIntent(dx: number, dy: number): boolean | null {
  if (Math.abs(dx) < PULL_SLOP && Math.abs(dy) < PULL_SLOP) return null;
  return dy > 0 && dy > Math.abs(dx) * 1.5;
}

/** 指を離したときに更新を始めるか。 */
export function shouldRefresh(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}
