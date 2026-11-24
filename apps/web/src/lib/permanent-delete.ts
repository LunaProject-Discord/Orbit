import type { MessageActionInput } from "@/lib/actions";

/**
 * ごみ箱からの完全な削除。ごみ箱にあるメールの「削除」は完全な削除になり、
 * 元に戻せないので、Shift を押しながら操作したとき以外は確認を出す。
 */

/** 操作に添える情報。 */
export type ActionOptions = {
  /** 完全な削除でも確認を出さない (Shift を押しながらの操作)。 */
  skipConfirm?: boolean;
  /**
   * 操作を行ったあとに呼ぶ。確認を出したときは、削除を確定したあとにだけ呼ぶ
   * (取り消したら呼ばない)。隣のメールを開くなど、操作に続く動きに使う。
   */
  onDone?: () => void;
};

/** メールへの操作を受け付ける関数。 */
export type ActionHandler = (
  messageIds: string[],
  input: MessageActionInput,
  options?: ActionOptions,
) => void;

/** 確認を出さずに完全に削除する操作か (Shift を押しながらのクリックやキー)。 */
export function skipsDeleteConfirm(event: {
  shiftKey: boolean;
  key?: string;
}): boolean {
  // 「#」はもともと Shift を押して入力するキーなので、Shift を押していても確認を出す。
  if (event.key === "#") return false;
  return event.shiftKey;
}

/** ごみ箱の中にあるか。フォルダの役割はアプリ内で上書きしたものを含む。 */
export function isInTrash(
  row: { mailboxId: string },
  mailboxes: readonly { id: string; specialUse: string | null }[],
): boolean {
  return (
    mailboxes.find((mailbox) => mailbox.id === row.mailboxId)?.specialUse ===
    "trash"
  );
}

/**
 * 「削除」を、ごみ箱へ移すものと完全に削除するものに分ける。
 * 検索結果や統合フォルダでは、ごみ箱にあるメールとほかのフォルダのメールが混ざる。
 */
export function splitForDelete<T extends { mailboxId: string }>(
  rows: readonly T[],
  mailboxes: readonly { id: string; specialUse: string | null }[],
): { toTrash: T[]; permanent: T[] } {
  const toTrash: T[] = [];
  const permanent: T[] = [];
  for (const row of rows) {
    if (isInTrash(row, mailboxes)) permanent.push(row);
    else toTrash.push(row);
  }
  return { toTrash, permanent };
}
