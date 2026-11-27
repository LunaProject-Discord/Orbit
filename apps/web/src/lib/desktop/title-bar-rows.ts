/**
 * デスクトップ版で、各アプリの上部の行 (ヘッダー、サイドバーのロゴの行) をタイトルバーとして使うための決まり。
 *
 * - 上部の行には data-titlebar を付ける。空き部分のドラッグでウィンドウを動かし、ダブルクリックで最大化し、
 *   右クリックでシステムメニューを出す (components/desktop/title-bar.tsx)。
 *   ボタン・入力欄・メニューなど操作できる部分では、ドラッグを始めない (isWindowDragTarget)。
 *   操作できる部分なのに button などではない要素 (検索欄の枠など) には data-titlebar-nodrag を付ける。
 * - data-titlebar-off を付けた要素の中の行は使わない (作成専用のウィンドウで、作成画面に覆われる一覧の見出しなど)。
 * - data-titlebar="drag" の行は、ドラッグだけ受け持ち、ボタンの分の余白は空けない
 *   (幅の狭い帯など、余白を空けても中身が避けられない行)。
 * - 画面の上端にある行のうち、キャプションボタン (Windows / Linux は右端) や信号機 (macOS は左端) に
 *   かかるものには、その分の余白を空ける (rowInsets)。余白は行の先頭と末尾に入れる空の要素
 *   (globals.css の [data-titlebar-start]::before / [data-titlebar-end]::after) で取る。
 */

export const TITLE_BAR_ROW_ATTRIBUTE = "data-titlebar";
export const TITLE_BAR_NO_DRAG_ATTRIBUTE = "data-titlebar-nodrag";

/** composedPath の要素のうち、ここで見る分だけ (テストで作りやすいように)。 */
export type DragPathElement = {
  nodeType: number;
  tagName: string;
  getAttribute(name: string): string | null;
};

const CLICKABLE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "LABEL",
  "SUMMARY",
  "IFRAME",
  // 検索欄 (components/search-field.tsx の外側)。枠の余白を押しても、ドラッグにはしない。
  "SEARCH",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "combobox",
  "searchbox",
  "textbox",
  "slider",
]);

/** 押すと何かが起きる要素か (Tauri の data-tauri-drag-region と同じ決まりに、入力欄の役割などを足したもの)。 */
function isInteractive(element: DragPathElement): boolean {
  if (CLICKABLE_TAGS.has(element.tagName.toUpperCase())) return true;
  const editable = element.getAttribute("contenteditable");
  if (editable !== null && editable !== "false") return true;
  const tabIndex = element.getAttribute("tabindex");
  if (tabIndex !== null && tabIndex !== "-1") return true;
  const role = element.getAttribute("role");
  return role !== null && INTERACTIVE_ROLES.has(role);
}

/**
 * 押した位置 (event.composedPath()) が、ウィンドウを動かす空き部分か。
 * 内側から順に見て、操作できる要素や data-titlebar-nodrag に先に当たれば false、
 * data-titlebar の行に当たれば true。
 */
export function isWindowDragTarget(path: readonly unknown[]): boolean {
  for (const item of path) {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as { nodeType?: unknown }).nodeType !== 1
    ) {
      continue;
    }
    const element = item as DragPathElement;
    if (element.getAttribute(TITLE_BAR_NO_DRAG_ATTRIBUTE) !== null)
      return false;
    if (isInteractive(element)) return false;
    const row = element.getAttribute(TITLE_BAR_ROW_ATTRIBUTE);
    if (row !== null) return row !== "false";
  }
  return false;
}

/** 行の位置と余白 (px)。 */
export type RowBox = {
  left: number;
  right: number;
  top: number;
  width: number;
  height: number;
  paddingLeft: number;
  paddingRight: number;
  /** 並べた中身の間隔 (flex の column-gap)。 */
  gap: number;
};

/** 窓の上端の、ボタンが占める範囲 (px)。 */
export type CaptionArea = {
  viewportWidth: number;
  /** 左端から、信号機ボタン (macOS) の右端まで。無ければ 0。 */
  reserveLeft: number;
  /** 右端から、キャプションボタン (Windows / Linux) の左端まで。無ければ 0。 */
  reserveRight: number;
  /** この高さより下から始まる行は、上端の行ではない。 */
  maxTop: number;
};

/** 画面の上端にある、見えている行か。 */
export function isTopRow(row: RowBox, area: CaptionArea): boolean {
  return (
    row.width > 0 &&
    row.height > 0 &&
    row.top >= -1 &&
    row.top <= area.maxTop + 1 &&
    row.right > 0 &&
    row.left < area.viewportWidth
  );
}

/**
 * 行の先頭 (start) と末尾 (end) に入れる余白の要素の幅 (px)。中身がボタンにかからない分だけ空ける。
 * 余白の要素も flex の並びに入り、その間隔 (gap) も空くので、gap の分は差し引く。
 * 余白が要らなければ null (要素を入れない。入れると gap の分だけ中身がずれる)。
 */
export function rowInsets(
  row: RowBox,
  area: CaptionArea,
): { start: number | null; end: number | null } {
  if (!isTopRow(row, area)) return { start: null, end: null };
  const spacer = (overlap: number) =>
    overlap > 0 ? Math.max(0, Math.ceil(overlap - row.gap)) : null;
  const start =
    area.reserveLeft > 0
      ? spacer(area.reserveLeft - (row.left + row.paddingLeft))
      : null;
  const end =
    area.reserveRight > 0
      ? spacer(
          row.right -
            row.paddingRight -
            (area.viewportWidth - area.reserveRight),
        )
      : null;
  return { start, end };
}
