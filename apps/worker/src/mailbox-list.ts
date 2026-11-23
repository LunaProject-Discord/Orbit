import type { mailboxes } from "@orbit/db";
import { clean, toSpecialUse } from "./message-parse.js";

export type SpecialUse = NonNullable<
  (typeof mailboxes.$inferSelect)["specialUse"]
>;

/** サーバーから取得したフォルダ 1 件。DB の mailboxes に反映する形。 */
export type ListedMailbox = {
  /** IMAP ではフォルダのパス、Microsoft Graph ではフォルダの ID。 */
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: SpecialUse | null;
  /** 親フォルダの path。最上位なら null。 */
  parentPath: string | null;
};

/** ImapFlow の list() が返す項目のうち、使うものだけ。 */
export type ImapListEntry = {
  path: string;
  name: string;
  delimiter?: string;
  flags: Set<string>;
  specialUse?: string;
};

/** メールを入れられないフォルダ (階層のためだけにある入れ物)。同期の対象にしない。 */
export function isSelectable(entry: Pick<ImapListEntry, "flags">): boolean {
  return !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent");
}

/**
 * 他のフォルダにあるメールを条件で集めて見せているだけのフォルダ
 * (Gmail の「スター付き」と「重要」など)。中身は他のフォルダと重複するうえ、
 * ここから移動するとスターや重要マークが外れてしまうので、同期の対象にしない。
 * スター付きのメールは、アプリ側の「スター付き」で見られる。
 */
export function isVirtual(
  entry: Pick<ImapListEntry, "flags" | "specialUse">,
): boolean {
  const has = (name: string) =>
    entry.specialUse?.toLowerCase() === name ||
    [...entry.flags].some((flag) => flag.toLowerCase() === name);
  return has("\\flagged") || has("\\important");
}

/**
 * IMAP のフォルダ一覧を、親子関係の付いた形にする。
 * 親はパスを区切り文字で遡って決める。メールを入れられない入れ物 (Gmail の
 * "[Gmail]" など) は一覧に含めないので、その下のフォルダは一つ上の階層に付け、
 * 名前には入れ物からの相対パスを使う (どこにあったフォルダか分かるようにする)。
 */
export function toListedMailboxes(entries: ImapListEntry[]): ListedMailbox[] {
  const selectable = new Map<string, ImapListEntry>();
  for (const entry of entries) {
    if (isSelectable(entry) && !isVirtual(entry)) {
      selectable.set(entry.path, entry);
    }
  }

  const result: ListedMailbox[] = [];
  for (const entry of selectable.values()) {
    const delimiter = entry.delimiter || null;
    let parentPath: string | null = null;
    let skipped = false;
    if (delimiter) {
      let path = entry.path;
      for (;;) {
        const index = path.lastIndexOf(delimiter);
        if (index <= 0) break;
        path = path.slice(0, index);
        if (selectable.has(path)) {
          parentPath = path;
          break;
        }
        skipped = true;
      }
    }
    const relative =
      parentPath !== null && delimiter
        ? entry.path.slice(parentPath.length + delimiter.length)
        : entry.path;
    result.push({
      path: entry.path,
      name: clean(skipped ? relative : entry.name) || entry.path,
      delimiter,
      specialUse:
        entry.path.toUpperCase() === "INBOX"
          ? "inbox"
          : toSpecialUse(entry.specialUse),
      parentPath,
    });
  }
  return result;
}

/** DB に保存してある、フォルダの同期状態。 */
export type MailboxState = {
  uidValidity: bigint | null;
  uidNext: bigint | null;
  highestModseq: bigint | null;
  lastSyncedAt: Date | null;
  /** DB にあるメッセージの数。 */
  total: number;
  /** DB にある未読メッセージの数。 */
  unseen: number;
};

/** IMAP の STATUS の結果。サーバーが返さなかった項目は undefined。 */
export type MailboxStatus = {
  messages?: number;
  uidNext?: number;
  uidValidity?: bigint;
  unseen?: number;
  highestModseq?: bigint;
};

/**
 * フォルダを開いて突き合わせる必要があるかを、STATUS の結果から判断する。
 * 開かずに済むフォルダを飛ばすことで、フォルダが多くても確認を短時間で終える。
 * force は、変更番号 (CONDSTORE) の無いサーバーで定期的に確認し直すときに true にする
 * (スターの変化などは STATUS では分からないため)。
 */
export function needsSync(
  state: MailboxState,
  status: MailboxStatus | undefined,
  force: boolean,
): boolean {
  if (state.lastSyncedAt === null || !status) return true;
  if (
    status.uidValidity !== undefined &&
    status.uidValidity !== state.uidValidity
  ) {
    return true;
  }
  if (
    status.uidNext !== undefined &&
    BigInt(status.uidNext) !== state.uidNext
  ) {
    return true;
  }
  if (status.messages !== undefined && status.messages !== state.total) {
    return true;
  }
  if (status.highestModseq !== undefined) {
    return status.highestModseq !== state.highestModseq;
  }
  if (status.unseen !== undefined && status.unseen !== state.unseen) {
    return true;
  }
  return force;
}

const SYNC_ORDER: (SpecialUse | null)[] = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  null,
  "flagged",
  "all",
  "junk",
  "trash",
];

/** 同期や本文の取得を行う順番。よく見るフォルダを先に、迷惑メールとごみ箱を最後にする。 */
export function syncPriority(specialUse: SpecialUse | null): number {
  return SYNC_ORDER.indexOf(specialUse);
}
