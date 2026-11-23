/**
 * スマホ幅で画面の下から出るシート (メニュー、ピッカー、ダイアログ) を、
 * 指で下へ払って閉じる操作の判定。画面の部品は components/ui/menu-sheet.tsx。
 */

/** シートとして出す画面の幅の上限 (Tailwind の sm 未満)。 */
export const SHEET_MAX_WIDTH = 639.98;
export const SHEET_QUERY = `(max-width: ${SHEET_MAX_WIDTH}px)`;

/** この長さ (px) を動かすまでは、押しただけ (タップ) として扱う。 */
export const SHEET_SLOP_PX = 8;
/** これ以上の速さ (px / ms) で下へ払ったら、短い動きでも閉じる。 */
export const SHEET_FLING_VELOCITY = 0.5;
/** 速さによらず閉じる長さの上限 (px)。背の高いシートでも、ここまで引けば閉じる。 */
export const SHEET_DISMISS_MAX_PX = 160;

/**
 * 動き始めの向きから、シートを引き下ろす操作として扱うかを決める。
 * まだ決められない (ほとんど動いていない) ときは null。
 * 上向きや横向きの動きは、中身のスクロールやタブの横送りに任せる。
 */
export function sheetDragIntent(dx: number, dy: number): boolean | null {
  if (Math.abs(dx) < SHEET_SLOP_PX && Math.abs(dy) < SHEET_SLOP_PX) return null;
  return dy > 0 && dy > Math.abs(dx);
}

/** 指の動きに合わせたシートの位置 (px)。上へは動かさない。 */
export function sheetOffset(dy: number): number {
  return Math.max(0, dy);
}

/**
 * 指を離したあと、シートを閉じるか。高さの 3 分の 1 (上限あり) より下げたか、
 * 素早く下へ払ったときに閉じる。velocity は px / ms (下向きが正)。
 */
export function sheetDismisses(
  offset: number,
  height: number,
  velocity: number,
): boolean {
  if (offset <= 0) return false;
  if (velocity >= SHEET_FLING_VELOCITY) return true;
  // 上へ戻しながら離したときは、閉じない。
  if (velocity <= -SHEET_FLING_VELOCITY) return false;
  return offset >= Math.min(height / 3, SHEET_DISMISS_MAX_PX);
}
