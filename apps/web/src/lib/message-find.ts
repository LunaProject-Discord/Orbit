/**
 * 開いているメールの中の検索 (ページ内検索)。
 *
 * 本文は iframe (同じオリジン扱い) の中にあるので、iframe の文書の文字に <mark> を差し込んで
 * 目立たせる。iframe の文書はこのアプリの React が描いたものではないので、書き換えても壊れない。
 * 件名や見出しなど、React が描いた部分 ([data-find-scope]) は書き換えられないので、
 * 使える環境では CSS Custom Highlight API で色を付ける (使えなければ数えて移動するだけ)。
 */

const MARK_ATTR = "data-orbit-find";
const STYLE_ID = "orbit-find-style";
export const FIND_HIGHLIGHT = "orbit-find";
export const FIND_ACTIVE_HIGHLIGHT = "orbit-find-active";
/** 数えすぎて固まらないよう、目立たせる数の上限。 */
export const MAX_FIND_MATCHES = 1000;

export type FindMatch = {
  range: Range;
  /** iframe の中なら、差し込んだ印。 */
  mark: HTMLElement | null;
};

const MARK_STYLE = `mark[${MARK_ATTR}]{background:#fde68a;color:#1c1917;border-radius:2px;box-shadow:0 0 0 1px #fde68a}mark[${MARK_ATTR}][data-active]{background:#f97316;color:#fff;box-shadow:0 0 0 1px #f97316}`;

/**
 * 件名などに色を付ける ::highlight() の指定。CSS の変換 (Lightning CSS) が ::highlight() を
 * 落としてしまうので、globals.css ではなくここから差し込む。
 */
const PAGE_STYLE_ID = "orbit-find-page-style";
const PAGE_STYLE = `::highlight(${FIND_HIGHLIGHT}){background-color:#fde68a;color:#1c1917}::highlight(${FIND_ACTIVE_HIGHLIGHT}){background-color:#f97316;color:#fff}`;

function ensurePageStyle() {
  if (document.getElementById(PAGE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PAGE_STYLE_ID;
  style.textContent = PAGE_STYLE;
  document.head.appendChild(style);
}

/** 文字列の中で語の現れる位置 (大文字と小文字、全角と半角の英数字は区別しない)。 */
export function findOffsets(text: string, query: string): number[] {
  const needle = foldCase(query);
  if (needle === "") return [];
  const haystack = foldCase(text);
  // 長さが変わる文字があると位置がずれるので、そのときは区別して探す。
  const exact = haystack.length !== text.length;
  const source = exact ? text : haystack;
  const target = exact ? query : needle;
  const offsets: number[] = [];
  let index = source.indexOf(target);
  while (index !== -1) {
    offsets.push(index);
    index = source.indexOf(target, index + target.length);
  }
  return offsets;
}

function foldCase(text: string): string {
  return text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .toLowerCase();
}

function textNodes(root: Node, doc: Document): Text[] {
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script,style,noscript,template,head")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** iframe の文書。読めなければ null。 */
function frameDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument?.body ? frame.contentDocument : null;
  } catch {
    return null;
  }
}

/** iframe に差し込んだ印を取り除く。 */
function unmark(doc: Document) {
  const marks = doc.querySelectorAll(`mark[${MARK_ATTR}]`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(doc.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
}

type HighlightRegistry = {
  set(name: string, value: unknown): void;
  delete(name: string): void;
};
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): {
  registry: HighlightRegistry;
  Highlight: HighlightConstructor;
} | null {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry };
  const Highlight = (globalThis as { Highlight?: HighlightConstructor })
    .Highlight;
  return css?.highlights && Highlight
    ? { registry: css.highlights, Highlight }
    : null;
}

/** 目立たせた印をすべて消す。 */
export function clearFind(root: HTMLElement) {
  for (const frame of root.querySelectorAll("iframe")) {
    const doc = frameDocument(frame);
    if (doc) unmark(doc);
  }
  const api = highlightApi();
  api?.registry.delete(FIND_HIGHLIGHT);
  api?.registry.delete(FIND_ACTIVE_HIGHLIGHT);
}

/**
 * root の中 (本文の iframe と [data-find-scope] の部分) から語を探して目立たせる。
 * 見つかった順 (画面の上から) に返す。
 */
export function runFind(root: HTMLElement, query: string): FindMatch[] {
  clearFind(root);
  const matches: FindMatch[] = [];
  if (query.trim() === "") return matches;
  const sources = root.querySelectorAll<HTMLElement>(
    "[data-find-scope], iframe",
  );
  const pageRanges: Range[] = [];
  for (const source of sources) {
    if (matches.length >= MAX_FIND_MATCHES) break;
    if (source instanceof HTMLIFrameElement) {
      const doc = frameDocument(source);
      if (!doc) continue;
      if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = MARK_STYLE;
        (doc.head ?? doc.body).appendChild(style);
      }
      for (const node of textNodes(doc.body, doc)) {
        const offsets = findOffsets(node.nodeValue ?? "", query);
        // 後ろから分けると、前の位置がずれない。
        const found: FindMatch[] = [];
        for (const offset of offsets.reverse()) {
          if (matches.length + found.length >= MAX_FIND_MATCHES) break;
          const range = doc.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + query.length);
          const mark = doc.createElement("mark");
          mark.setAttribute(MARK_ATTR, "");
          try {
            range.surroundContents(mark);
          } catch {
            continue;
          }
          const markRange = doc.createRange();
          markRange.selectNodeContents(mark);
          found.unshift({ range: markRange, mark });
        }
        matches.push(...found);
      }
      continue;
    }
    for (const node of textNodes(source, document)) {
      for (const offset of findOffsets(node.nodeValue ?? "", query)) {
        if (matches.length >= MAX_FIND_MATCHES) break;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + query.length);
        pageRanges.push(range);
        matches.push({ range, mark: null });
      }
    }
  }
  const api = highlightApi();
  if (api && pageRanges.length > 0) {
    ensurePageStyle();
    api.registry.set(FIND_HIGHLIGHT, new api.Highlight(...pageRanges));
  }
  return matches;
}

/** index 番目の一致を「いま見ている一致」にして、見える位置までスクロールする。 */
export function showMatch(matches: FindMatch[], index: number) {
  const api = highlightApi();
  api?.registry.delete(FIND_ACTIVE_HIGHLIGHT);
  for (const match of matches) match.mark?.removeAttribute("data-active");
  const match = matches[index];
  if (!match) return;
  if (match.mark) {
    match.mark.setAttribute("data-active", "");
    scrollFrameMatch(match.mark);
  } else {
    if (api) {
      api.registry.set(FIND_ACTIVE_HIGHLIGHT, new api.Highlight(match.range));
    }
    match.range.startContainer.parentElement?.scrollIntoView({
      block: "center",
    });
  }
}

/**
 * iframe の中の印が見えるよう、iframe を含むスクロールする枠を動かす。
 * 本文の iframe は中身の高さに合わせてあるので、多くの場合は外側の枠がスクロールする。
 */
function scrollFrameMatch(mark: HTMLElement) {
  const frame = mark.ownerDocument.defaultView?.frameElement;
  if (!(frame instanceof HTMLIFrameElement)) {
    mark.scrollIntoView({ block: "center" });
    return;
  }
  // iframe の中がスクロールする場合 (枠内スクロールに戻した本文) は、先に中を動かす。
  mark.scrollIntoView({ block: "center", inline: "nearest" });
  const markRect = mark.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  // 本文に zoom が掛かっていても、getBoundingClientRect は表示上の大きさを返す。
  const top = frameRect.top + markRect.top;
  const bottom = frameRect.top + markRect.bottom;
  let scroller: HTMLElement | null = frame.parentElement;
  while (scroller) {
    const style = getComputedStyle(scroller);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      scroller.scrollHeight > scroller.clientHeight
    ) {
      break;
    }
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  if (top >= view.top + 48 && bottom <= view.bottom - 48) return;
  scroller.scrollTop += (top + bottom) / 2 - (view.top + view.bottom) / 2;
}
