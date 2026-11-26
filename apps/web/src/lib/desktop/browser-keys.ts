/**
 * デスクトップ版 (Tauri) のキー操作と、ブラウザー標準の動きの止め方。
 *
 * WebView (Windows の WebView2 など) には、ブラウザーとしてのショートカット (再読み込み、印刷、
 * ページ内検索、ズーム、ソースの表示など) がそのまま残っている。デスクトップ版ではそれらを止め、
 * 同じキーにアプリの操作を割り当てる。Windows はアプリ側でもブラウザーのキーを切っている
 * (apps/desktop/src-tauri/src/lib.rs の disable_browser_keys)。
 *
 * 割り当て (macOS は Ctrl の代わりに ⌘):
 * - Ctrl+R / F5: フォルダの更新
 * - Ctrl+Shift+R / Shift+F5: アカウントの更新
 * - Ctrl+Alt+R / Ctrl+Alt+F5: 画面の再読み込み
 * - Ctrl+Alt+Shift+R / Ctrl+Alt+Shift+F5: 強制再読み込み (保存した画面の控えを捨ててから読み込む)
 * - Ctrl+F / F3: 検索欄へ移る
 * - Ctrl+Shift+F / Shift+F3: 開いているメールの中を検索
 * - Ctrl+P: 開いているメールを印刷 (メールを開いていなければ何もしない)
 */

import { invokeDesktop } from "@/lib/desktop/app";

/** アプリの操作に割り当てたキー。 */
export type DesktopKeyCommand =
  | "refreshFolder"
  | "refreshAccount"
  | "reload"
  | "forceReload"
  | "focusSearch"
  | "findInMessage"
  | "print";

type KeyLike = {
  key: string;
  /** 押したキーの位置 (KeyR など)。Alt や Shift で key の文字が変わっても同じ値になる。 */
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
};

/** ズームのキー (Ctrl と一緒に押すと、ブラウザーが画面を拡大・縮小する)。 */
const ZOOM_KEYS = new Set(["+", "=", ";", "-", "_", "0"]);
const ZOOM_CODES = new Set([
  "Equal",
  "Minus",
  "Digit0",
  "NumpadAdd",
  "NumpadSubtract",
  "Numpad0",
]);

/** 文字の装飾などに使うことがあるので、入力欄では止めないキー (Ctrl と一緒に押す)。 */
const EDITING_LETTERS = new Set(["KeyU", "KeyS", "KeyG"]);

/** 修飾キーを除いた、押したキーの文字 (英字は小文字)。code があれば位置から決める。 */
function letterOf(event: KeyLike): string {
  if (event.code?.startsWith("Key")) return event.code.slice(3).toLowerCase();
  return event.key.length === 1 ? event.key.toLowerCase() : "";
}

/**
 * キー入力に割り当てたアプリの操作を返す。ブラウザー標準の動きを止めるだけのキーは "block"。
 * どちらでもなければ null (ふつうに処理させる)。
 * mac は macOS かどうか (⌘ を Ctrl の代わりに使う)。editable は入力欄の中で押したか。
 */
export function resolveDesktopKey(
  event: KeyLike,
  { mac = false, editable = false }: { mac?: boolean; editable?: boolean } = {},
): DesktopKeyCommand | "block" | null {
  if (event.isComposing) return null;
  const primary = mac ? event.metaKey : event.ctrlKey;
  // もう一方の修飾キー (Windows の Win キー、macOS の Control) を押しているときは、OS に任せる。
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other) return null;
  const { shiftKey: shift, altKey: alt } = event;

  if (event.key === "F5") {
    if (primary && alt) return shift ? "forceReload" : "reload";
    if (primary || alt) return "block";
    return shift ? "refreshAccount" : "refreshFolder";
  }
  if (event.key === "F3") {
    if (primary || alt) return "block";
    return shift ? "findInMessage" : "focusSearch";
  }
  // キャレットブラウズ (F7)、開発者ツール (F12) など、ブラウザーの機能のキー。
  if (event.key === "F7" || event.key === "F12") return "block";
  // キーボードの「戻る」「進む」「更新」などの専用キー。
  if (event.key.startsWith("Browser")) return "block";
  // Alt+← / Alt+→ は、ブラウザーの「戻る」「進む」。macOS の Option+← は単語単位の移動なので残す。
  if (
    !mac &&
    alt &&
    !primary &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    return "block";
  }
  if (!primary) return null;

  const letter = letterOf(event);
  if (letter === "r") {
    if (alt) return shift ? "forceReload" : "reload";
    return shift ? "refreshAccount" : "refreshFolder";
  }
  if (letter === "f") {
    if (alt) return "block";
    return shift ? "findInMessage" : "focusSearch";
  }
  if (letter === "p") return alt || shift ? "block" : "print";
  if (ZOOM_KEYS.has(event.key) || ZOOM_CODES.has(event.code ?? "")) {
    return "block";
  }
  // Ctrl+U (ソースの表示)、Ctrl+S (ページの保存)、Ctrl+G (次を検索)。
  // 入力欄では文字の装飾 (下線など) に使うことがあるので止めない。
  if (EDITING_LETTERS.has(event.code ?? `Key${letter.toUpperCase()}`)) {
    return editable ? null : "block";
  }
  // Ctrl+Shift+I / J / C (開発者ツール)。Windows はアプリ側でも止めている。
  if (shift && (letter === "i" || letter === "j" || letter === "c")) {
    return "block";
  }
  return null;
}

/** マウスの「戻る」「進む」ボタン (ブラウザーでは前のページへ戻る)。 */
export function isHistoryButton(button: number): boolean {
  return button === 3 || button === 4;
}

/** 文字を入力できる欄か (input・textarea・contenteditable)。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") {
    return false;
  }
  const element = target as Element;
  return (
    element.closest("input, textarea, select, [contenteditable]") !== null &&
    element.closest('[contenteditable="false"]') === null
  );
}

/**
 * 画像やリンクをつかんで引っ張る (ドラッグする) 動きを止めるか。
 * アプリが自分で引っ張れるようにした要素 (draggable="true") と、入力欄の中はそのまま。
 */
export function blocksDrag(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") {
    return false;
  }
  const element = target as Element;
  if (element.closest('[draggable="true"]')) return false;
  // 入力欄の中 (作成画面の本文) では、画像などを動かして並べ替えられるようにする。
  if (isEditableTarget(target)) return false;
  return element.closest("img, a, svg") !== null;
}

/**
 * 強制再読み込み。画面からは「キャッシュを使わずに読み込む」を頼めないので、
 * アプリ側 (apps/desktop/src-tauri/src/browser.rs の force_reload) に頼む。
 * 先に Cache Storage の控えも消しておく。アプリ側に頼めなければ、ふつうに再読み込みする。
 */
export async function forceReload(
  win: Window = window,
  reloadNative: () => Promise<unknown> = () => invokeDesktop("force_reload"),
): Promise<void> {
  try {
    const keys = (await win.caches?.keys()) ?? [];
    await Promise.all(keys.map((key) => win.caches.delete(key)));
  } catch {
    // 消せなくても、再読み込みは行う。
  }
  // 古いアプリ (force_reload が無い) では null が返る。
  if ((await reloadNative()) === null) win.location.reload();
}

/**
 * デスクトップ版で、ブラウザー標準のキー操作・マウスの戻るボタン・画像やリンクのドラッグを止める。
 * 再読み込みと強制再読み込みはここで行う。ほかのアプリの操作 (印刷や検索など) は、
 * メールの画面 (components/mail/mail-app.tsx) が同じ判定 (resolveDesktopKey) で行う。
 * 戻り値の関数で止めるのをやめる。
 */
export function startBrowserGuard(
  win: Window,
  { mac = false }: { mac?: boolean } = {},
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const command = resolveDesktopKey(event, {
      mac,
      editable: isEditableTarget(event.target),
    });
    if (!command) return;
    event.preventDefault();
    if (command === "reload") win.location.reload();
    else if (command === "forceReload") void forceReload(win);
  };
  // マウスの戻る・進むボタン。Chromium は mouseup で前のページへ戻るので、押した時と離した時の両方で止める。
  const onMouse = (event: MouseEvent) => {
    if (isHistoryButton(event.button)) event.preventDefault();
  };
  const onDragStart = (event: DragEvent) => {
    if (blocksDrag(event.target)) event.preventDefault();
  };
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("mousedown", onMouse, true);
  win.addEventListener("mouseup", onMouse, true);
  win.addEventListener("auxclick", onMouse, true);
  win.addEventListener("dragstart", onDragStart, true);
  return () => {
    win.removeEventListener("keydown", onKeyDown);
    win.removeEventListener("mousedown", onMouse, true);
    win.removeEventListener("mouseup", onMouse, true);
    win.removeEventListener("auxclick", onMouse, true);
    win.removeEventListener("dragstart", onDragStart, true);
  };
}
