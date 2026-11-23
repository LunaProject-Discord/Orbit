import { useSyncExternalStore } from "react";
import type { MessageActionInput } from "@/lib/actions";
import {
  getSettings,
  type Mailbox,
  type MessageSummary,
  type SwipeAction,
  type SwipeSettings,
  saveSwipeSettings,
} from "@/lib/api";
import { actionTargets } from "@/lib/mailboxes";

/**
 * メール一覧の行を左右にスワイプしたときの操作。
 * 何をするかは利用者が設定で選び、サーバーに保存してどの端末でも同じにする。
 */

/** 設定で選べる操作と、その呼び名。 */
export const SWIPE_ACTIONS: readonly (readonly [SwipeAction, string])[] = [
  ["none", "なし"],
  ["toggle_read", "既読 / 未読の切り替え"],
  ["star", "スターを付ける / 外す"],
  ["archive", "アーカイブ"],
  ["delete", "削除"],
  ["junk", "迷惑メールにする"],
  ["move", "フォルダを選んで移動"],
];

/** 何も保存していないときの設定。左で削除、右で既読 / 未読の切り替え。 */
export const DEFAULT_SWIPE: SwipeSettings = {
  left: "delete",
  right: "toggle_read",
};

const values = new Set<string>(SWIPE_ACTIONS.map(([value]) => value));

function isSwipeAction(value: unknown): value is SwipeAction {
  return typeof value === "string" && values.has(value);
}

/** 保存してあった設定を読む。知らない操作は、その向きだけ標準の値にする。 */
export function parseSwipe(saved: unknown): SwipeSettings {
  const record =
    typeof saved === "object" && saved !== null
      ? (saved as Record<string, unknown>)
      : {};
  return {
    left: isSwipeAction(record.left) ? record.left : DEFAULT_SWIPE.left,
    right: isSwipeAction(record.right) ? record.right : DEFAULT_SWIPE.right,
  };
}

/** スワイプした結果、その行に対して実際に行うこと。 */
export type SwipeOutcome = {
  kind:
    | "read"
    | "unread"
    | "star"
    | "unstar"
    | "archive"
    | "trash"
    | "delete"
    | "junk"
    | "not_junk"
    | "move";
  /** 行の後ろに出す文言。 */
  label: string;
  /** 行が一覧から無くなる操作か (無くなるなら、行を画面の外まで送り出す)。 */
  removes: boolean;
  /** 送る操作。null なら、移動先を選ぶ画面を開く。 */
  input: MessageActionInput | null;
};

/**
 * 設定した操作を、その行で実際に行うことに直す。その行ではできない操作
 * (アーカイブ先が無い、すでに迷惑メールのフォルダに無い、など) は null。
 * 移動先は、フォルダの役割 (アプリ内で上書きした役割を含む) から決める。
 */
export function resolveSwipe(
  action: SwipeAction,
  message: Pick<MessageSummary, "seen" | "flagged" | "mailboxId">,
  mailboxes: Mailbox[],
): SwipeOutcome | null {
  if (action === "none") return null;
  if (action === "toggle_read") {
    return message.seen
      ? {
          kind: "unread",
          label: "未読にする",
          removes: false,
          input: { action: "set_flags", seen: false },
        }
      : {
          kind: "read",
          label: "既読にする",
          removes: false,
          input: { action: "set_flags", seen: true },
        };
  }
  if (action === "star") {
    return message.flagged
      ? {
          kind: "unstar",
          label: "スターを外す",
          removes: false,
          input: { action: "set_flags", flagged: false },
        }
      : {
          kind: "star",
          label: "スターを付ける",
          removes: false,
          input: { action: "set_flags", flagged: true },
        };
  }
  const targets = actionTargets(mailboxes, message.mailboxId);
  if (action === "archive") {
    return targets.archive
      ? {
          kind: "archive",
          label: "アーカイブ",
          removes: true,
          input: { action: "move", mailboxId: targets.archive.id },
        }
      : null;
  }
  if (action === "delete") {
    // ごみ箱の中では完全に削除する (右クリックメニューやショートカットキーと同じ)。
    if (targets.inTrash) {
      return {
        kind: "delete",
        label: "完全に削除",
        removes: true,
        input: { action: "delete" },
      };
    }
    return targets.trash
      ? {
          kind: "trash",
          label: "削除",
          removes: true,
          input: { action: "move", mailboxId: targets.trash.id },
        }
      : null;
  }
  if (action === "junk") {
    if (targets.notJunk) {
      return {
        kind: "not_junk",
        label: "迷惑メールから戻す",
        removes: true,
        input: { action: "move", mailboxId: targets.notJunk.id },
      };
    }
    return targets.junk
      ? {
          kind: "junk",
          label: "迷惑メール",
          removes: true,
          input: { action: "move", mailboxId: targets.junk.id },
        }
      : null;
  }
  return targets.destinations.length > 0
    ? { kind: "move", label: "移動", removes: false, input: null }
    : null;
}

// ---------------------------------------------------------------------------
// 指やトラックパッドの動きの判定
// ---------------------------------------------------------------------------

/** これより動くまでは、縦のスクロールか横のスワイプかを決めない (px)。 */
export const SWIPE_SLOP = 10;

/** 動き始めの向き。縦なら一覧のスクロールに任せ、横ならスワイプとして扱う。 */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < SWIPE_SLOP) return null;
  // 斜めの動きは縦のスクロールとみなす (スクロール中に誤って操作しないため)。
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? "x" : "y";
}

/** 指を離したときに操作を行う、行をずらした量 (px)。行の幅の 3 割、64〜120 px。 */
export function swipeThreshold(width: number): number {
  return Math.min(120, Math.max(64, width * 0.3));
}

/**
 * 指を離したときに操作を行うか。十分にずらしたか、同じ向きに素早く払ったとき。
 * velocity は離す直前の速さ (px / ms、右向きが正)。
 */
export function shouldCommit(
  offset: number,
  width: number,
  velocity = 0,
): boolean {
  const distance = Math.abs(offset);
  if (distance >= swipeThreshold(width)) return true;
  return (
    distance >= 32 &&
    Math.abs(velocity) >= 0.6 &&
    Math.sign(velocity) === Math.sign(offset)
  );
}

/** 行をずらせる量を、操作のある向きと行の幅に収める。 */
export function clampOffset(
  offset: number,
  width: number,
  can: { left: boolean; right: boolean },
): number {
  const min = can.left ? -width : 0;
  const max = can.right ? width : 0;
  return Math.min(max, Math.max(min, offset));
}

/** これ以下のはみ出し (px) は、横にスクロールできる枠として数えない。 */
export const SIDEWAYS_SLACK = 16;

/**
 * 触れた場所が、その向きへまだ横にスクロールできる枠 (幅を固定したメールの本文、横に長い表や
 * コードなど) の中か。その中では、横の動きをスクロールに使うので、スワイプとして扱わない。
 * direction は指を動かす向き (left なら、中身は右側の続きが見える向きへスクロールする)。
 *
 * わずかにはみ出しているだけの枠は数えない (少しはみ出しただけのメールでスワイプできなく
 * なるのを避ける)。スクロールの端まで来ていれば、その先への動きはスワイプにする。
 * 本文の iframe の中からも、外側の文書までたどる。stopAt まで来たら、そこで終える。
 */
export function insideSidewaysScroller(
  target: unknown,
  stopAt: Element | null,
  direction: "left" | "right",
): boolean {
  let node = toElement(target);
  while (node && node !== stopAt) {
    const view = node.ownerDocument.defaultView;
    if (!view) return false;
    const range = node.scrollWidth - node.clientWidth;
    if (range > SIDEWAYS_SLACK) {
      const overflow = view.getComputedStyle(node).overflowX;
      // 文書のいちばん外側 (html) は、指定が無くても画面ごとスクロールする。
      const scrolls =
        node === node.ownerDocument.documentElement
          ? overflow !== "hidden" && overflow !== "clip"
          : overflow === "auto" || overflow === "scroll";
      // 右から左へ書く文書では scrollLeft が負になるので、大きさで比べる。
      const position = Math.abs(node.scrollLeft);
      const rtl = view.getComputedStyle(node).direction === "rtl";
      const towardEnd = (direction === "left") !== rtl;
      if (scrolls && (towardEnd ? position < range - 2 : position > 2)) {
        return true;
      }
    }
    node = node.parentElement ?? (view.frameElement as Element | null);
  }
  return false;
}

/** 文字を入力する欄の中か (横の動きは、カーソルの移動や選択に使う)。 */
export function insideTextField(target: unknown): boolean {
  return (
    toElement(target)?.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    ) != null
  );
}

/** イベントの対象を要素にする。iframe の中の要素は instanceof で見分けられないので、形で見る。 */
function toElement(target: unknown): Element | null {
  if (typeof target !== "object" || target === null) return null;
  const node = target as Node;
  if (node.nodeType === 1) return node as Element;
  return node.nodeType === 3 ? node.parentElement : null;
}

// ---------------------------------------------------------------------------
// 設定の保持 (サーバーに保存し、前回の内容を端末にも残す)
// ---------------------------------------------------------------------------

const CACHE_KEY = "mail.swipe.v1";

let current: SwipeSettings | null = null;
/** 保存の途中で届いた取得結果に、選んだばかりの設定を上書きされないようにする。 */
let saving = 0;
const listeners = new Set<() => void>();

function read(): SwipeSettings {
  if (current) return current;
  try {
    current = parseSwipe(
      JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null"),
    );
  } catch {
    current = DEFAULT_SWIPE;
  }
  return current;
}

function set(next: SwipeSettings) {
  const previous = read();
  if (previous.left === next.left && previous.right === next.right) return;
  current = next;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // 保存できなくても、このページを開いている間は有効。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** いまのスワイプ操作の設定。変わると、使っている部品を描き直す。 */
export function useSwipeSettings(): SwipeSettings {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_SWIPE);
}

/** サーバーから設定を取得し直す (起動時と、ほかの端末で変えたとき)。 */
export async function refreshSwipeSettings(
  load: () => Promise<{ swipe: unknown }> = getSettings,
): Promise<void> {
  try {
    const { swipe } = await load();
    if (saving === 0) set(parseSwipe(swipe));
  } catch {
    // 取得できない間 (オフラインなど) は、前回の内容を使う。
  }
}

/**
 * 設定を変える。画面にはすぐ反映し、サーバーに保存できなければ元に戻す。
 * 保存できたかを返す。
 */
export async function changeSwipeSettings(
  patch: Partial<SwipeSettings>,
  save: (swipe: SwipeSettings) => Promise<void> = saveSwipeSettings,
): Promise<boolean> {
  const previous = read();
  const next = { ...previous, ...patch };
  set(next);
  saving += 1;
  try {
    await save(next);
    return true;
  } catch {
    // この後に選び直していなければ、保存できていた内容へ戻す。
    if (current === next) set(previous);
    return false;
  } finally {
    saving -= 1;
  }
}

/** テスト用: 保持している設定を捨てる。 */
export function resetSwipeSettingsForTest() {
  current = null;
  saving = 0;
}
