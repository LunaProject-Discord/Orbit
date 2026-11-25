import type { Account, MailboxSummary } from "@/lib/api";
import { mailboxLabel, specialLabels } from "@/lib/mailboxes";

/** 検索欄の folder: の候補。 */
export type FolderSuggestion = {
  /** 表示名 (folder: の値として入れる)。 */
  label: string;
  /** 添える説明 (どのアカウントのフォルダか)。 */
  detail: string;
};

const roleOrder = Object.keys(specialLabels);

/**
 * folder: の候補。同じ名前のフォルダ (どのアカウントにもある受信トレイなど) は 1 つにまとめる。
 * サーバーは名前で探すので、まとめた名前を選べば、すべてのアカウントのそのフォルダから探す。
 * 受信トレイなどの役割のあるフォルダを先に、ほかは名前順に並べる。
 */
export function folderSuggestions(
  mailboxes: readonly MailboxSummary[],
  accounts: readonly Pick<Account, "id" | "email" | "displayName">[],
  query: string,
  limit: number,
): FolderSuggestion[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<
    string,
    { label: string; order: number; accountIds: Set<string> }
  >();
  for (const mailbox of mailboxes) {
    const label = mailboxLabel(mailbox);
    if (needle !== "" && !label.toLowerCase().includes(needle)) continue;
    const key = label.toLowerCase();
    const role = mailbox.displayName
      ? -1
      : roleOrder.indexOf(mailbox.specialUse ?? "");
    const order = role === -1 ? roleOrder.length : role;
    const group = groups.get(key);
    if (group) {
      group.accountIds.add(mailbox.accountId);
      group.order = Math.min(group.order, order);
    } else {
      groups.set(key, {
        label,
        order,
        accountIds: new Set([mailbox.accountId]),
      });
    }
  }
  const names = new Map(
    accounts.map((account) => [
      account.id,
      account.displayName || account.email,
    ]),
  );
  return [...groups.values()]
    .sort(
      (a, b) =>
        // 入力した語で始まるものを先に出す。
        Number(!a.label.toLowerCase().startsWith(needle)) -
          Number(!b.label.toLowerCase().startsWith(needle)) ||
        a.order - b.order ||
        a.label.localeCompare(b.label, "ja"),
    )
    .slice(0, limit)
    .map((group) => {
      const [only] = group.accountIds;
      return {
        label: group.label,
        detail:
          group.accountIds.size > 1 || only === undefined
            ? `${group.accountIds.size} つのアカウント`
            : (names.get(only) ?? ""),
      };
    });
}
