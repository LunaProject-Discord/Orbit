/** ショートカットキーで実行できる操作。 */
export type ShortcutCommand =
  | "next"
  | "previous"
  | "close"
  | "select"
  | "markRead"
  | "markUnread"
  | "toggleRead"
  | "toggleStar"
  | "archive"
  | "delete"
  | "move"
  | "junk"
  | "undo"
  | "compose"
  | "search"
  | "reply"
  | "replyAll"
  | "forward"
  | "toggleSidebar"
  | "expandThread"
  | "collapseThread";

type KeyLike = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
};

/**
 * キー入力に対応する操作を返す。割り当ては Gmail を基本に、
 * Thunderbird / Outlook で馴染みのあるキー (M、A、Delete、矢印) も足している。
 */
export function resolveShortcut(event: KeyLike): ShortcutCommand | null {
  // Ctrl / Cmd / Alt との組み合わせは、ブラウザーや OS のショートカットに譲る。
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return null;
  }
  if (event.shiftKey) {
    switch (event.key) {
      case "I":
        return "markRead";
      case "U":
        return "markUnread";
      case "#":
        return "delete";
      case "!":
        return "junk";
      case "R":
        return "replyAll";
      default:
        return null;
    }
  }
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    // 一覧で会話を広げて、中のメールを 1 通ずつ並べる。
    case "ArrowRight":
      return "expandThread";
    case "ArrowLeft":
      return "collapseThread";
    case "u":
    case "Escape":
      return "close";
    case "x":
      return "select";
    case "m":
      return "toggleRead";
    case "s":
      return "toggleStar";
    case "e":
    case "a":
      return "archive";
    case "#":
    case "Delete":
      return "delete";
    case "v":
      return "move";
    // 直前の削除や移動を元に戻す (Gmail と同じキー)。
    case "z":
      return "undo";
    case "c":
      return "compose";
    case "/":
      return "search";
    case "r":
      return "reply";
    case "f":
      return "forward";
    // Thunderbird のフォルダペインの表示切り替えと同じキー。
    case "F9":
      return "toggleSidebar";
    default:
      return null;
  }
}

/**
 * すべて選択のキー (Windows / Linux は Ctrl+A、macOS は ⌘+A)。
 * どちらの OS でも、もう一方のキーで押しても受け付ける。
 */
export function isSelectAllKey(event: KeyLike): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.isComposing &&
    event.key.toLowerCase() === "a"
  );
}

/** すべて選択のキーで一覧のメールを選ぶ範囲 (一覧の枠) に付ける印。 */
export const SELECT_ALL_SCOPE_ATTRIBUTE = "data-select-all-scope";

/**
 * すべて選択のキーを、一覧のメールの選択に使うかどうか。
 * 入力欄にいるときや、メールの本文などを見ているときは、ふつうの文字の全選択に任せる。
 * target はキーを受けた要素、lastPointer は最後にマウスや指で押した要素。
 * どこにも入っていない (body) ときは、最後に押した場所で決める。まだどこも押していなければ一覧。
 */
export function selectAllTargetsList(
  target: EventTarget | null,
  lastPointer: EventTarget | null,
): boolean {
  if (isTypingTarget(target)) return false;
  const scope =
    target instanceof HTMLElement &&
    target !== target.ownerDocument.body &&
    target !== target.ownerDocument.documentElement
      ? target
      : lastPointer;
  if (scope === null) return true;
  if (!(scope instanceof Element)) return false;
  return scope.closest(`[${SELECT_ALL_SCOPE_ATTRIBUTE}]`) !== null;
}

/** 文字を入力する場所にいる間は、ショートカットを効かせない。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** メニューに出すキーの表示。 */
export const shortcutLabels = {
  markRead: "Shift+I",
  markUnread: "Shift+U",
  toggleStar: "S",
  archive: "E",
  delete: "Delete",
  move: "V",
  junk: "!",
  compose: "C",
  reply: "R",
  replyAll: "Shift+R",
  forward: "F",
} as const;
