/**
 * スマホ幅で、サイドバー (ドロワー) を指のスワイプで開閉する操作の判定。
 * 画面の部品は components/mail/drawer-swipe.ts。
 *
 * ほかのスワイプ操作 (一覧の行、開いているメール) とぶつからないよう、開く操作は
 * 画面の左端から始めた右向きの動きだけを受け付ける。一覧の行とメール表示の側は、
 * 同じ幅の左端から始まった動きを無視する。
 */

/** 開く操作を受け付ける、画面の左端からの幅 (px)。 */
export const DRAWER_EDGE_PX = 24;
/** ドロワーとして重ねて出す画面の幅の上限 (Tailwind の md 未満)。 */
export const DRAWER_MAX_WIDTH = 767.98;

/** いまの画面の幅で、サイドバーがドロワーになっているか。 */
export function drawerMode(viewportWidth: number): boolean {
  return viewportWidth <= DRAWER_MAX_WIDTH;
}

/** この位置から始めた動きを、ドロワーを開く操作として扱うか。 */
export function startsDrawerOpen(x: number, viewportWidth: number): boolean {
  return drawerMode(viewportWidth) && x <= DRAWER_EDGE_PX;
}

/**
 * 指の動きに合わせた、ドロワーの位置 (0 = 開ききった位置、-width = 閉じた位置)。
 * opening は、閉じた状態から開こうとしているか。
 */
export function drawerOffset(
  dx: number,
  width: number,
  opening: boolean,
): number {
  const offset = opening ? dx - width : dx;
  return Math.min(0, Math.max(-width, offset));
}

/**
 * 指を離したあと、開いた状態にするか。半分より開いていれば開き、
 * 素早く払ったときはその向きに従う。velocity は px / ms (右向きが正)。
 */
export function drawerSettlesOpen(
  offset: number,
  width: number,
  velocity: number,
): boolean {
  if (Math.abs(velocity) >= 0.5) return velocity > 0;
  return offset > -width / 2;
}
