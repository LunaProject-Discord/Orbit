import { describe, expect, it } from "vitest";
import type { MailboxSummary } from "@/lib/api";
import { folderSuggestions } from "@/lib/search-folders";

function mailbox(
  id: string,
  accountId: string,
  name: string,
  extra: Partial<MailboxSummary> = {},
): MailboxSummary {
  return {
    id,
    accountId,
    parentId: null,
    path: name,
    name,
    specialUse: null,
    lastSyncedAt: null,
    totalCount: 0,
    unreadCount: 0,
    ...extra,
  } as MailboxSummary;
}

const accounts = [
  { id: "a", email: "a@example.com", displayName: "仕事" },
  { id: "b", email: "b@example.com", displayName: null },
];
const mailboxes = [
  mailbox("1", "a", "INBOX", { specialUse: "inbox" }),
  mailbox("2", "b", "INBOX", { specialUse: "inbox" }),
  mailbox("3", "a", "Projects"),
  mailbox("4", "b", "Trash", { specialUse: "trash" }),
  mailbox("5", "b", "受信メモ"),
];

describe("folderSuggestions", () => {
  it("同じ名前はまとめ、役割のあるフォルダを先に並べる", () => {
    expect(folderSuggestions(mailboxes, accounts, "", 10)).toEqual([
      { label: "受信トレイ", detail: "2 つのアカウント" },
      { label: "ごみ箱", detail: "b@example.com" },
      { label: "Projects", detail: "仕事" },
      { label: "受信メモ", detail: "b@example.com" },
    ]);
  });

  it("入力した語を含むものに絞り、その語で始まるものを先に出す", () => {
    expect(
      folderSuggestions(mailboxes, accounts, "受信", 10).map((f) => f.label),
    ).toEqual(["受信トレイ", "受信メモ"]);
    expect(
      folderSuggestions(mailboxes, accounts, "ject", 10).map((f) => f.label),
    ).toEqual(["Projects"]);
  });
});
