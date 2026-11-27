/**
 * 本文の入力欄 (contentEditable) の書式のうち、ブラウザーの編集機能 (execCommand) に任せると
 * ブラウザーごとに結果が違うもの (引用、インデント、文字色の解除、行頭の記号での書式) を、
 * DOM を直接操作して行う。どれもブラウザーでのみ動く。
 */

/** 1 行分のかたまりとして扱う要素。 */
const LINE_BLOCKS = new Set([
  "DIV",
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "LI",
]);
/** 行を入れ子に持てる要素 (これ自体は 1 行ではない)。 */
const CONTAINERS = new Set([
  "BLOCKQUOTE",
  "UL",
  "OL",
  "TABLE",
  "TBODY",
  "THEAD",
  "TFOOT",
  "TR",
  "TD",
  "TH",
]);

/** インデント 1 段分の幅 (px)。 */
export const INDENT_STEP = 40;
/** インデントの上限 (px)。 */
export const MAX_INDENT = INDENT_STEP * 8;

function isBlock(node: Node): node is HTMLElement {
  return (
    node.nodeType === 1 &&
    (LINE_BLOCKS.has((node as Element).tagName) ||
      CONTAINERS.has((node as Element).tagName) ||
      (node as Element).tagName === "HR")
  );
}

/** 選択範囲を、ノードを動かしたあとで選び直せる形で覚える。 */
type SavedRange = {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
};

function save(range: Range): SavedRange {
  return {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  };
}

function restore(editor: HTMLElement, saved: SavedRange): void {
  const selection = editor.ownerDocument.getSelection();
  if (!selection) return;
  const { startContainer, endContainer } = saved;
  if (!editor.contains(startContainer) || !editor.contains(endContainer)) {
    return;
  }
  const range = editor.ownerDocument.createRange();
  try {
    range.setStart(
      startContainer,
      Math.min(saved.startOffset, lengthOf(startContainer)),
    );
    range.setEnd(
      endContainer,
      Math.min(saved.endOffset, lengthOf(endContainer)),
    );
  } catch {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function lengthOf(node: Node): number {
  return node.nodeType === 3
    ? (node.nodeValue ?? "").length
    : node.childNodes.length;
}

/** 本文の中の、今の選択範囲。本文の外を選んでいれば null。 */
export function editorRange(editor: HTMLElement): Range | null {
  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return range;
}

/**
 * 行のかたまりに入っていない文字 (本文や引用の直下の文字) を、1 行ずつ div に包む。
 * 改行 (br) で区切られた文字も、それぞれ別の行にする。
 */
function wrapLooseLines(parent: HTMLElement): void {
  const doc = parent.ownerDocument;
  let run: Node[] = [];
  const flush = (before: Node | null, br: Node | null) => {
    if (run.length === 0 && !br) return;
    const div = doc.createElement("div");
    parent.insertBefore(div, before);
    for (const node of run) div.appendChild(node);
    if (br) div.appendChild(br);
    else if (!div.textContent && !div.querySelector("br")) {
      div.appendChild(doc.createElement("br"));
    }
    run = [];
  };
  for (const node of [...parent.childNodes]) {
    if (isBlock(node)) {
      flush(node, null);
      continue;
    }
    if (node.nodeType === 1 && (node as Element).tagName === "BR") {
      // 空の行 (br だけ) も 1 行として残す。
      flush(node.nextSibling, node);
      continue;
    }
    run.push(node);
  }
  // 末尾に残った文字。空白だけのテキストは包まない。
  if (run.some((node) => node.nodeType !== 3 || node.nodeValue?.trim())) {
    flush(null, null);
  } else {
    run = [];
  }
}

/** 範囲に掛かっているノードの、最も近い行のかたまり (無ければ包んでから)。 */
function lineOf(editor: HTMLElement, node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (
      current.nodeType === 1 &&
      LINE_BLOCKS.has((current as Element).tagName)
    ) {
      return current as HTMLElement;
    }
    current = current.parentNode;
  }
  return null;
}

/** 範囲の端の位置にあるノード。要素の中の位置なら、その位置の子 (無ければ要素自体)。 */
function boundaryNode(container: Node, offset: number): Node {
  if (container.nodeType === 3) return container;
  return (
    container.childNodes[offset] ??
    container.childNodes[offset - 1] ??
    container
  );
}

/** 範囲に掛かっている行 (上から順、重複なし)。行に入っていない文字は先に包む。 */
export function selectedLines(
  editor: HTMLElement,
  range: Range,
): HTMLElement[] {
  const saved = save(range);
  // 本文と引用の直下にある文字を、行のかたまりに包む。
  wrapLooseLines(editor);
  for (const quote of editor.querySelectorAll("blockquote")) {
    wrapLooseLines(quote as HTMLElement);
  }
  restore(editor, saved);
  const current = editorRange(editor) ?? range;
  const lines: HTMLElement[] = [];
  const add = (line: HTMLElement | null) => {
    if (line && !lines.includes(line)) lines.push(line);
  };
  add(
    lineOf(editor, boundaryNode(current.startContainer, current.startOffset)),
  );
  const walker = editor.ownerDocument.createTreeWalker(editor, 1 | 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!current.intersectsNode(node)) continue;
    if (node.nodeType === 3 || (node as Element).tagName === "BR") {
      add(lineOf(editor, node));
    }
  }
  add(lineOf(editor, boundaryNode(current.endContainer, current.endOffset)));
  // 外側の行 (中に行を持つもの) は除く。中の行をそれぞれ扱う。
  return lines
    .filter(
      (line) => !lines.some((other) => other !== line && line.contains(other)),
    )
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
}

/** 選択範囲が引用 (blockquote) の中か。 */
export function quoteAt(
  editor: HTMLElement,
  range: Range | null,
): HTMLElement | null {
  if (!range) return null;
  let node: Node | null = range.startContainer;
  while (node && node !== editor) {
    if (node.nodeType === 1 && (node as Element).tagName === "BLOCKQUOTE") {
      return node as HTMLElement;
    }
    node = node.parentNode;
  }
  return null;
}

/**
 * 引用を付ける・外す。選んだ行が引用の中なら、いちばん内側の引用を外す。
 * そうでなければ、選んだ行をまとめて 1 つの引用にする。
 * 戻り値は、引用を付けたら true、外したら false。
 */
export function toggleQuote(editor: HTMLElement): boolean | null {
  const range = editorRange(editor);
  if (!range) return null;
  const quote = quoteAt(editor, range);
  if (quote) {
    unwrapQuote(editor, quote, range);
    return false;
  }
  wrapInQuote(editor, range);
  return true;
}

function unwrapQuote(editor: HTMLElement, quote: HTMLElement, range: Range) {
  const saved = save(range);
  wrapLooseLines(quote);
  const parent = quote.parentNode;
  if (!parent) return;
  while (quote.firstChild) parent.insertBefore(quote.firstChild, quote);
  quote.remove();
  restore(editor, saved);
}

function wrapInQuote(editor: HTMLElement, range: Range) {
  const lines = selectedLines(editor, range);
  const saved = save(editorRange(editor) ?? range);
  const doc = editor.ownerDocument;
  if (lines.length === 0) {
    // 空の本文。空行を 1 つ作って引用にする。
    const quote = doc.createElement("blockquote");
    const line = doc.createElement("div");
    line.appendChild(doc.createElement("br"));
    quote.appendChild(line);
    editor.appendChild(quote);
    placeCaret(line, 0);
    return;
  }
  const first = lines[0] as HTMLElement;
  const last = lines[lines.length - 1] as HTMLElement;
  // 選んだ行の共通の親の直下で、最初の行から最後の行までをまとめる。
  // 箇条書きの項目は、リスト全体を引用に入れる。
  let container: Node = first.parentNode ?? editor;
  while (container !== editor && !container.contains(last)) {
    container = container.parentNode ?? editor;
  }
  while (
    container !== editor &&
    (container.nodeName === "UL" ||
      container.nodeName === "OL" ||
      container.nodeName === "LI")
  ) {
    container = container.parentNode ?? editor;
  }
  const childOf = (node: Node): Node => {
    let current = node;
    while (current.parentNode && current.parentNode !== container) {
      current = current.parentNode;
    }
    return current;
  };
  const start = childOf(first);
  const end = childOf(last);
  const quote = doc.createElement("blockquote");
  container.insertBefore(quote, start);
  let node: Node | null = start;
  while (node) {
    const next: Node | null = node === end ? null : node.nextSibling;
    quote.appendChild(node);
    node = next;
  }
  restore(editor, saved);
}

function placeCaret(node: Node, offset: number) {
  const doc = node.ownerDocument;
  const selection = doc?.getSelection();
  if (!doc || !selection) return;
  const range = doc.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function indentOf(element: HTMLElement): number {
  const value = Number.parseFloat(element.style.marginLeft || "0");
  return Number.isFinite(value) ? value : 0;
}

/**
 * 選んだ行のインデントを 1 段増やす (direction = 1) か減らす (-1)。
 * 箇条書きの中はブラウザーの機能 (リストの入れ子) に任せるので、ここでは扱わない。
 */
export function indentLines(editor: HTMLElement, direction: 1 | -1): boolean {
  const range = editorRange(editor);
  if (!range) return false;
  const lines = selectedLines(editor, range).filter(
    (line) => line.tagName !== "LI",
  );
  if (lines.length === 0) return false;
  let changed = false;
  for (const line of lines) {
    const next = Math.max(
      0,
      Math.min(MAX_INDENT, indentOf(line) + direction * INDENT_STEP),
    );
    if (next === indentOf(line)) continue;
    line.style.marginLeft = next > 0 ? `${next}px` : "";
    if (!line.getAttribute("style")) line.removeAttribute("style");
    changed = true;
  }
  return changed;
}

/** 選択範囲が箇条書き (番号付きを含む) の項目の中か。 */
export function inListItem(editor: HTMLElement, range: Range | null): boolean {
  if (!range) return false;
  let node: Node | null = range.startContainer;
  while (node && node !== editor) {
    if (node.nodeName === "LI") return true;
    node = node.parentNode;
  }
  return false;
}

/**
 * 目印にした値 (sentinel) を付けた部分から、その指定を取り除く。
 * 「標準の色に戻す」「標準の大きさに戻す」は、ブラウザーの機能では指定を外せないので、
 * いったん目印の値を付けてから外す。font 要素で付いた場合 (CSS を使わないブラウザー) も外す。
 */
export function stripSentinel(
  editor: HTMLElement,
  property: "color" | "background-color" | "font-size",
  sentinel: string,
  fontAttribute?: { name: "color" | "size"; value: string },
): void {
  const targets = [
    ...editor.querySelectorAll<HTMLElement>("[style]"),
    ...editor.querySelectorAll<HTMLElement>("font"),
  ];
  for (const element of new Set(targets)) {
    if (element.tagName === "FONT" && fontAttribute) {
      const value = element.getAttribute(fontAttribute.name) ?? "";
      if (
        value &&
        (fontAttribute.name === "color"
          ? sameColor(value, fontAttribute.value)
          : value === fontAttribute.value)
      ) {
        element.removeAttribute(fontAttribute.name);
      }
    }
    const value = element.style.getPropertyValue(property);
    if (
      value &&
      (property === "font-size"
        ? value.trim().toLowerCase() === sentinel
        : sameColor(value, sentinel))
    ) {
      element.style.removeProperty(property);
    }
    if (element.getAttribute("style") === "") element.removeAttribute("style");
    // 何も付いていない span / font は、中身だけにする。
    if (
      (element.tagName === "SPAN" || element.tagName === "FONT") &&
      element.attributes.length === 0
    ) {
      const parent = element.parentNode;
      if (!parent) continue;
      while (element.firstChild)
        parent.insertBefore(element.firstChild, element);
      element.remove();
    }
  }
}

function sameColor(a: string, b: string): boolean {
  return normalizeColor(a) === normalizeColor(b);
}

/** #rrggbb と rgb(r, g, b) を同じ形にそろえる。 */
export function normalizeColor(value: string): string {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(text);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text);
  if (rgb) return `${rgb[1]},${rgb[2]},${rgb[3]}`;
  return text;
}

/** 行頭に打つと書式に変わる記号。 */
export type LineMarker = "quote" | "orderedList" | "unorderedList";

/** 行頭の記号 (打ったばかりの空白まで) を見分ける。 */
export function markerOf(text: string): LineMarker | null {
  const normalized = text.replace(/ /g, " ").replace(/　/g, " ");
  if (/^(>|＞) $/.test(normalized)) return "quote";
  if (/^(1|１)[.．)）] $/.test(normalized)) return "orderedList";
  if (/^[-*・＊－] $/.test(normalized)) return "unorderedList";
  return null;
}

/**
 * 空白を打った直後に呼ぶ。カーソルの行が「> 」「1. 」「- 」で始まっていれば、
 * その記号を消して、引用・番号付きリスト・箇条書きにする記号の種類を返す
 * (リストにするのは呼び出し側がブラウザーの機能で行う)。当てはまらなければ null。
 */
export function consumeLineMarker(editor: HTMLElement): LineMarker | null {
  const range = editorRange(editor);
  if (!range || !range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== 3) return null;
  // 行の頭からカーソルまでの文字を調べる。行の頭は、行のかたまりの先頭か直前の改行。
  const line = lineOf(editor, node);
  if (line?.tagName === "LI") return null;
  const head = editor.ownerDocument.createRange();
  head.setStart(line ?? editor, 0);
  let previous: Node | null = node.previousSibling;
  while (previous) {
    if (previous.nodeName === "BR" || isBlock(previous)) {
      head.setStartAfter(previous);
      break;
    }
    previous = previous.previousSibling;
  }
  head.setEnd(range.startContainer, range.startOffset);
  const marker = markerOf(head.toString());
  if (!marker) return null;
  // 記号は同じテキストの中にあるときだけ消す (書式の途中にまたがるものは扱わない)。
  // 文字を書き換えると選択範囲も動くので、位置は先に控えておく。
  const offset = range.startOffset;
  const text = node.nodeValue ?? "";
  const typed = head.toString().length;
  if (offset < typed) return null;
  node.nodeValue = text.slice(0, offset - typed) + text.slice(offset);
  const parent = node.parentNode;
  if (!node.nodeValue && parent) {
    // 空になった行は、ブラウザーが前の行の続きとして扱ってしまう (リストにすると前の行まで
    // 入る) ので、改行 (br) を置いて 1 行として残し、その前にカーソルを置く。
    const next = node.nextSibling;
    const br =
      next?.nodeName === "BR" ? next : editor.ownerDocument.createElement("br");
    if (br !== next) parent.insertBefore(br, next);
    const index = [...parent.childNodes].indexOf(br as ChildNode);
    node.remove();
    placeCaret(parent, index - 1);
  } else {
    placeCaret(node, offset - typed);
  }
  if (marker === "quote") toggleQuoteOn(editor);
  return marker;
}

/** 引用を付ける (すでに引用の中でも、もう 1 段入れる)。 */
function toggleQuoteOn(editor: HTMLElement) {
  const range = editorRange(editor);
  if (!range) return;
  wrapInQuote(editor, range);
}

/**
 * 引用の最後の空行で Enter を押したときに呼ぶ。その空行を引用の外 (すぐ後ろ) へ出して、
 * 引用を抜けられるようにする。抜けたら true (呼び出し側は Enter の既定の動きを止める)。
 */
export function exitQuoteFromEmptyLine(editor: HTMLElement): boolean {
  const range = editorRange(editor);
  if (!range?.collapsed) return false;
  const quote = quoteAt(editor, range);
  if (!quote) return false;
  const line = lineOf(
    editor,
    boundaryNode(range.startContainer, range.startOffset),
  );
  if (!line || line.parentNode !== quote || line.tagName === "LI") return false;
  if (line.textContent?.trim()) return false;
  if (
    [...line.childNodes].some(
      (node) => node.nodeType === 1 && node.nodeName !== "BR",
    )
  ) {
    return false;
  }
  let after = line.nextSibling;
  while (after && after.nodeType === 3 && !after.nodeValue?.trim()) {
    after = after.nextSibling;
  }
  if (after) return false;
  quote.parentNode?.insertBefore(line, quote.nextSibling);
  if (!quote.textContent?.trim() && !quote.querySelector("br,hr"))
    quote.remove();
  if (!line.firstChild)
    line.appendChild(editor.ownerDocument.createElement("br"));
  placeCaret(line, 0);
  return true;
}
