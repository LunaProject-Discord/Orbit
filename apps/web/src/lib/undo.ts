import type { MessageActionInput } from "@/lib/actions";
import type { Mailbox, MessageSummary } from "@/lib/api";
import { mailboxLabel } from "@/lib/mailboxes";

/**
 * 削除や移動の「元に戻す」。操作は画面にすぐ反映するが、サーバーへ送るのは少し待ち、
 * その間に「元に戻す」を押せば送らずに取り消す。待つ間にページを閉じたら、そのまま送る。
 */

/** 「元に戻す」を受け付ける時間 (ms)。この間、操作をサーバーへ送らずに待つ。 */
export const UNDO_MS = 7_000;

/** 元に戻せる操作か。一覧から無くなる操作 (移動、削除) が対象。 */
export function isUndoable(input: MessageActionInput): boolean {
  return input.action !== "set_flags";
}

/** 行った操作を知らせる文言。count は対象の会話の数。 */
export function undoMessage(
  input: MessageActionInput,
  mailboxes: readonly Mailbox[],
  count: number,
): string {
  const what = count > 1 ? `${count} 件の会話を` : "";
  if (input.action === "delete") return `${what}完全に削除しました`;
  if (input.action !== "move") return "";
  const target =
    "mailboxId" in input
      ? mailboxes.find((mailbox) => mailbox.id === input.mailboxId)
      : undefined;
  const role =
    "destination" in input ? input.destination : (target?.specialUse ?? null);
  switch (role) {
    case "trash":
      return `${what}削除しました`;
    case "archive":
    case "all":
      return `${what}アーカイブしました`;
    case "junk":
      return `${what}迷惑メールに移動しました`;
    case "inbox":
      return `${what}受信トレイに移動しました`;
    default:
      return target
        ? `${what}「${mailboxLabel(target)}」に移動しました`
        : `${what}移動しました`;
  }
}

/** 操作の対象になる行 (会話)。操作の前に控えておき、元に戻すときに使う。 */
export function affectedRows(
  rows: readonly MessageSummary[],
  messageIds: readonly string[],
): MessageSummary[] {
  const ids = new Set(messageIds);
  return rows.filter((row) => row.threadMessageIds.some((id) => ids.has(id)));
}

/**
 * 控えておいた行を一覧へ戻す。残っている行は控えの内容に差し替え、
 * 無くなった行は並び順 (compare) に合う位置へ入れ直す。
 */
export function restoreRows(
  current: readonly MessageSummary[],
  saved: readonly MessageSummary[],
  compare: (a: MessageSummary, b: MessageSummary) => number,
): MessageSummary[] {
  const byId = new Map(saved.map((row) => [row.id, row]));
  const present = new Set(current.map((row) => row.id));
  const result = current.map((row) => byId.get(row.id) ?? row);
  const missing = saved.filter((row) => !present.has(row.id));
  if (missing.length === 0) return result;
  return [...result, ...missing].sort(compare);
}
