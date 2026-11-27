/**
 * デスクトップ版の自前のタイトルバー (components/desktop/title-bar.tsx) の高さ (px)。
 * 高さは globals.css の --titlebar-height (rem か px で書く)。ブラウザーとスマホアプリでは 0。
 */
export function titleBarHeight(): number {
  if (typeof document === "undefined") return 0;
  const root = document.documentElement;
  if (!root.hasAttribute("data-desktop")) return 0;
  const style = getComputedStyle(root);
  return parseCssLength(
    style.getPropertyValue("--titlebar-height"),
    Number.parseFloat(style.fontSize) || 16,
  );
}

/** "2rem" や "36px" を px に直す。読めなければ 0。 */
export function parseCssLength(value: string, rootFontSize: number): number {
  const match = /^\s*(-?\d*\.?\d+)(px|rem)?\s*$/.exec(value);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount)) return 0;
  return match[2] === "rem" ? amount * rootFontSize : amount;
}

/**
 * メニューやポップオーバーが画面の端からあける余白。デスクトップ版では、上端の
 * タイトルバーの分も空けて、タイトルバーに重ならない位置へ出す。
 */
export function popupCollisionPadding(padding = 8) {
  return {
    top: padding + titleBarHeight(),
    right: padding,
    bottom: padding,
    left: padding,
  };
}
