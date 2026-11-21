/** ショートカットキーで実行できる操作。 */
export type ShortcutCommand =
  | "next"
  | "previous"
  | "close"
  | "markRead"
  | "markUnread"
  | "toggleRead"
  | "toggleStar"
  | "archive"
  | "delete"
  | "move"
  | "compose"
  | "reply"
  | "replyAll"
  | "forward";

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
    case "u":
    case "Escape":
      return "close";
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
    case "c":
      return "compose";
    case "r":
      return "reply";
    case "f":
      return "forward";
    default:
      return null;
  }
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
  compose: "C",
  reply: "R",
  replyAll: "Shift+R",
  forward: "F",
} as const;
