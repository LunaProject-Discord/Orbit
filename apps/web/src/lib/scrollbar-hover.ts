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

/**
 * パソコン向けのスクロールバー (重ねて描くバーと、ダイアログなどの中の細いバー) を使うときに
 * html に付ける属性。globals.css はこの属性があるときだけバーの見た目を変える。
 */
export const DESKTOP_SCROLLBARS_ATTRIBUTE = "data-desktop-scrollbars";

type ScrollbarEnvironment = {
  Capacitor?: { isNativePlatform?: () => boolean };
  navigator: {
    userAgent: string;
    maxTouchPoints?: number;
    userAgentData?: { mobile?: boolean };
  };
};

/**
 * パソコン向けのスクロールバーを使うか。スマホとタブレット (Android / iOS / iPadOS) と
 * スマホアプリでは使わず、OS のバーのままにする。
 *
 * タッチ操作かどうか (pointer / hover) では決めない。Windows のタブレットモードでは
 * タッチ操作の判定になり、Windows の太いバーが出てしまう。逆に Android には、
 * マウスで指せると答える端末がある。
 *
 * 描画前に html へ属性を付けるため、layout.tsx がこの関数の中身をそのまま head で動かす。
 * 外の変数や import を使わないこと。
 */
export function usesDesktopScrollbars(w: ScrollbarEnvironment): boolean {
  if (w.Capacitor?.isNativePlatform?.() === true) return false;
  const nav = w.navigator;
  if (nav.userAgentData?.mobile === true) return false;
  const ua = nav.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return false;
  // iPadOS の Safari は Mac と同じ名乗り方をするので、タッチの点の数で見分ける。
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return false;
  return true;
}

/** layout.tsx の head で動かす、html に属性を付けるスクリプト。 */
export const DESKTOP_SCROLLBARS_SCRIPT = `try{if((${usesDesktopScrollbars.toString()})(window))document.documentElement.setAttribute("${DESKTOP_SCROLLBARS_ATTRIBUTE}","")}catch(e){}`;

/** スクロールが止まってから、つまみを隠し始めるまでの時間 (ミリ秒)。 */
export const SCROLLBAR_HIDE_DELAY = 800;
