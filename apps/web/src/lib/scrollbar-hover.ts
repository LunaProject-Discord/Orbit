/** スクロールする要素の位置と大きさ。getBoundingClientRect と client* / offset* の値。 */
export type ScrollBox = {
  left: number;
  top: number;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  offsetHeight: number;
};

/**
 * カーソルが要素のスクロールバーの上にあるか。
 * スクロールバーは要素の中身 (client 領域) の外、枠線の内側にあるので、その帯に入っているかで判定する。
 * 左から右へ書く文書 (縦のバーが右側) だけを想定している。
 */
export function overScrollbar(
  point: { clientX: number; clientY: number },
  box: ScrollBox,
): boolean {
  const hasVertical =
    box.offsetWidth - box.clientLeft * 2 - box.clientWidth > 0;
  const hasHorizontal =
    box.offsetHeight - box.clientTop * 2 - box.clientHeight > 0;
  const contentRight = box.left + box.clientLeft + box.clientWidth;
  const contentBottom = box.top + box.clientTop + box.clientHeight;
  return (
    (hasVertical && point.clientX >= contentRight) ||
    (hasHorizontal && point.clientY >= contentBottom)
  );
}

/** スクロールバーにカーソルが乗っている要素に付ける属性。globals.css がこれを見て太くする。 */
export const SCROLLBAR_HOVER_ATTRIBUTE = "data-scrollbar-hover";

/** スクロールしている要素に付ける属性。止まってから少しの間は残し、その後つまみを隠す。 */
export const SCROLLING_ATTRIBUTE = "data-scrolling";

/** スマホアプリで html に付ける属性。globals.css がパソコン向けのバーの指定を外し、OS のバーのままにする。 */
export const OS_SCROLLBARS_ATTRIBUTE = "data-os-scrollbars";

/** スクロールが止まってから、つまみを隠し始めるまでの時間 (ミリ秒)。 */
export const SCROLLBAR_HIDE_DELAY = 800;
