/**
 * デスクトップ版 (Tauri) の右クリックメニュー。
 *
 * WebView (Windows の WebView2 など) が出す標準のメニューには「戻る」「最新の情報に更新」「印刷」
 * 「開発者ツール」など、アプリには要らない項目が並ぶ。デスクトップ版では標準のメニューを止め、
 * 文字を選んでいるとき・入力欄・リンクの上でだけ、アプリのメニュー
 * (components/desktop/text-context-menu.tsx) を出す。それ以外の場所では何も出さない。
 *
 * メール一覧やサイドバーのように独自の右クリックメニューを持つ場所は、
 * そちらが先に既定の動作を止めるので、ここでは何もしない。
 */

/** 右クリックした場所について、メニューに出す項目を決めるための情報。 */
export type TextMenuTarget = {
  /** 選んでいる文字。無ければ空文字。 */
  selectedText: string;
  /** 文字を入力できる欄 (input・textarea・contenteditable)。入力欄でなければ null。 */
  editable: EditableTarget | null;
  /** 外部へのリンクなどの URL。リンクの上でなければ null。 */
  linkUrl: string | null;
  /** 右クリックした文書。本文の枠 (iframe) の中のこともある。 */
  doc: Document;
};

export type EditableTarget = {
  element: HTMLElement;
  /** 書き換えられない (読み取り専用) 欄。コピーとすべて選択だけを出す。 */
  readOnly: boolean;
  /** input / textarea で選んでいた範囲。メニューを押した後に選び直すために覚えておく。 */
  range: { start: number; end: number } | null;
};

/** 文字を入力する種類の input。チェックボックスやボタンなどは入力欄として扱わない。 */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "",
]);

type ElementLike = {
  nodeType?: number;
  tagName?: string;
  parentElement?: ElementLike | null;
  closest?: (selector: string) => ElementLike | null;
};

/** 本文の枠の中の要素は別の文書のものなので、instanceof ではなく形で確かめる。 */
function asElement(target: EventTarget | null): HTMLElement | null {
  const node = target as ElementLike | null;
  if (!node || typeof node.nodeType !== "number") return null;
  // 文字そのもの (Text) を右クリックしたときは、それを含む要素を見る。
  const element = node.nodeType === 1 ? node : (node.parentElement ?? null);
  return element && typeof element.closest === "function"
    ? (element as unknown as HTMLElement)
    : null;
}

function editableOf(element: HTMLElement): EditableTarget | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "input") {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    if (
      tag === "input" &&
      !TEXT_INPUT_TYPES.has((field.getAttribute("type") ?? "").toLowerCase())
    ) {
      return null;
    }
    let range: EditableTarget["range"] = null;
    try {
      // number などは選択範囲を読めない (例外になる)。
      if (field.selectionStart !== null && field.selectionEnd !== null) {
        range = { start: field.selectionStart, end: field.selectionEnd };
      }
    } catch {
      range = null;
    }
    return {
      element: field,
      readOnly: field.readOnly || field.disabled,
      range,
    };
  }
  const host = element.closest<HTMLElement>(
    '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
  if (!host) return null;
  return { element: host, readOnly: false, range: null };
}

/** input / textarea で選んでいる文字。 */
function fieldSelection(editable: EditableTarget | null): string | null {
  if (!editable?.range) return null;
  const { element, range } = editable;
  if (!("value" in element)) return null;
  // パスワードの欄の文字はコピーさせない (ブラウザーの標準の動作と同じ)。
  if ((element.getAttribute("type") ?? "").toLowerCase() === "password") {
    return "";
  }
  return String(element.value).slice(range.start, range.end);
}

/**
 * 右クリックした場所の情報。
 * linkOf はリンクの URL を返す関数 (外部へのリンクだけを対象にするかどうかは呼ぶ側が決める)。
 */
export function describeTextMenuTarget(
  target: EventTarget | null,
  doc: Document,
  linkOf: (target: EventTarget | null) => string | null,
): TextMenuTarget {
  const element = asElement(target);
  const editable = element ? editableOf(element) : null;
  const selectedText =
    fieldSelection(editable) ?? doc.getSelection()?.toString() ?? "";
  return {
    selectedText,
    editable,
    linkUrl: editable ? null : linkOf(target),
    doc,
  };
}

/** メニューに出す項目。 */
export type TextMenuItem =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "openLink"
  | "copyLink";

/** 出す項目の並び。null は区切り線。何も出さないときは空の配列。 */
export function textMenuItems(target: TextMenuTarget): (TextMenuItem | null)[] {
  const items: (TextMenuItem | null)[] = [];
  const hasSelection = target.selectedText.length > 0;
  if (target.editable) {
    if (!target.editable.readOnly) items.push("undo", "redo", null, "cut");
    items.push("copy");
    if (!target.editable.readOnly) items.push("paste");
    items.push(null, "selectAll");
    return items;
  }
  if (target.linkUrl) items.push("openLink", "copyLink");
  if (hasSelection) {
    if (items.length > 0) items.push(null);
    items.push("copy");
  }
  return items;
}

/** 選んでいる文字が無いと押せない項目。 */
export function needsSelection(item: TextMenuItem): boolean {
  return item === "cut" || item === "copy";
}

/**
 * 右クリックされたら呼ぶ関数。座標はいちばん外側の画面の中での位置。
 * メニューを出す部品が登録する。
 */
type Opener = (target: TextMenuTarget, x: number, y: number) => void;

let opener: Opener | null = null;

export function setTextMenuOpener(next: Opener | null): void {
  opener = next;
}

/**
 * 文書の右クリックを受け取り、標準のメニューの代わりにアプリのメニューを出す。
 * frame を渡すと、その枠 (本文の iframe) の位置の分だけ座標をずらす。戻り値の関数で解除する。
 */
export function attachTextMenu(
  doc: Document,
  linkOf: (target: EventTarget | null) => string | null,
  frame?: HTMLIFrameElement,
): () => void {
  const onContextMenu = (event: MouseEvent) => {
    // 一覧やサイドバーの独自のメニューが受け取った右クリック。
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!opener) return;
    const target = describeTextMenuTarget(event.target, doc, linkOf);
    if (textMenuItems(target).length === 0) return;
    const offset = frame?.getBoundingClientRect();
    opener(
      target,
      event.clientX + (offset?.left ?? 0),
      event.clientY + (offset?.top ?? 0),
    );
  };
  doc.addEventListener("contextmenu", onContextMenu);
  return () => doc.removeEventListener("contextmenu", onContextMenu);
}
