import { describe, expect, it } from "vitest";
import {
  type ImapListEntry,
  type MailboxState,
  needsSync,
  syncPriority,
  toListedMailboxes,
} from "./mailbox-list.js";

function entry(
  path: string,
  options: { delimiter?: string; flags?: string[]; specialUse?: string } = {},
): ImapListEntry {
  const delimiter = options.delimiter ?? "/";
  return {
    path,
    name: path.slice(path.lastIndexOf(delimiter) + 1),
    delimiter,
    flags: new Set(options.flags ?? []),
    ...(options.specialUse ? { specialUse: options.specialUse } : {}),
  };
}

describe("toListedMailboxes", () => {
  it("パスを区切り文字で遡って親を決める", () => {
    const listed = toListedMailboxes([
      entry("INBOX"),
      entry("Projects"),
      entry("Projects/2026"),
      entry("Projects/2026/Mail"),
      entry("Sent", { specialUse: "\\Sent" }),
    ]);
    expect(
      listed.map((item) => [item.path, item.name, item.parentPath]),
    ).toEqual([
      ["INBOX", "INBOX", null],
      ["Projects", "Projects", null],
      ["Projects/2026", "2026", "Projects"],
      ["Projects/2026/Mail", "Mail", "Projects/2026"],
      ["Sent", "Sent", null],
    ]);
    expect(listed.map((item) => item.specialUse)).toEqual([
      "inbox",
      null,
      null,
      null,
      "sent",
    ]);
  });

  it("Gmail の「スター付き」と「重要」は同期せず、「すべてのメール」は同期する", () => {
    const listed = toListedMailboxes([
      entry("INBOX"),
      entry("[Gmail]", { flags: ["\\Noselect", "\\HasChildren"] }),
      entry("[Gmail]/All Mail", { specialUse: "\\All" }),
      entry("[Gmail]/Starred", { specialUse: "\\Flagged" }),
      entry("[Gmail]/Important", {
        flags: ["\\HasNoChildren", "\\Important"],
      }),
      entry("[Gmail]/Trash", { specialUse: "\\Trash" }),
      entry("仕事"),
    ]);
    expect(listed.map((item) => [item.path, item.specialUse])).toEqual([
      ["INBOX", "inbox"],
      ["[Gmail]/All Mail", "all"],
      ["[Gmail]/Trash", "trash"],
      ["仕事", null],
    ]);
  });

  it("メールを入れられない入れ物は除き、その下のフォルダは上の階層に付ける", () => {
    const listed = toListedMailboxes([
      entry("INBOX"),
      entry("[Gmail]", { flags: ["\\Noselect", "\\HasChildren"] }),
      entry("[Gmail]/Sent Mail", { specialUse: "\\Sent" }),
      entry("INBOX/Box", { flags: ["\\NonExistent"] }),
      entry("INBOX/Box/Deep"),
    ]);
    expect(
      listed.map((item) => [item.path, item.name, item.parentPath]),
    ).toEqual([
      ["INBOX", "INBOX", null],
      ["[Gmail]/Sent Mail", "[Gmail]/Sent Mail", null],
      ["INBOX/Box/Deep", "Box/Deep", "INBOX"],
    ]);
  });

  it("区切り文字がサーバーごとに違っても扱える", () => {
    const listed = toListedMailboxes([
      entry("INBOX", { delimiter: "." }),
      entry("INBOX.Archive.2025", { delimiter: "." }),
      entry("INBOX.Archive", { delimiter: "." }),
    ]);
    expect(listed.map((item) => [item.path, item.parentPath])).toEqual([
      ["INBOX", null],
      ["INBOX.Archive.2025", "INBOX.Archive"],
      ["INBOX.Archive", "INBOX"],
    ]);
  });
});

describe("needsSync", () => {
  const state: MailboxState = {
    uidValidity: 1n,
    uidNext: 11n,
    highestModseq: 50n,
    lastSyncedAt: new Date(),
    total: 10,
    unseen: 2,
  };
  const status = {
    messages: 10,
    uidNext: 11,
    uidValidity: 1n,
    unseen: 2,
    highestModseq: 50n,
  };

  it("状態が変わっていなければ開かない", () => {
    expect(needsSync(state, status, false)).toBe(false);
    // 変更番号があるサーバーでは、定期的な確認でも開かなくてよい。
    expect(needsSync(state, status, true)).toBe(false);
  });

  it("一度も同期していないか、状態を取得できなかったら開く", () => {
    expect(needsSync({ ...state, lastSyncedAt: null }, status, false)).toBe(
      true,
    );
    expect(needsSync(state, undefined, false)).toBe(true);
  });

  it("件数、次の UID、UIDVALIDITY、変更番号のどれかが違えば開く", () => {
    expect(needsSync(state, { ...status, messages: 9 }, false)).toBe(true);
    expect(needsSync(state, { ...status, uidNext: 12 }, false)).toBe(true);
    expect(needsSync(state, { ...status, uidValidity: 2n }, false)).toBe(true);
    expect(needsSync(state, { ...status, highestModseq: 51n }, false)).toBe(
      true,
    );
  });

  it("変更番号の無いサーバーでは、未読数の変化か定期的な確認で開く", () => {
    const { highestModseq: _, ...plain } = status;
    expect(needsSync(state, plain, false)).toBe(false);
    expect(needsSync(state, { ...plain, unseen: 3 }, false)).toBe(true);
    expect(needsSync(state, plain, true)).toBe(true);
  });
});

describe("syncPriority", () => {
  it("受信トレイを最初に、迷惑メールとごみ箱を最後にする", () => {
    const order = (["trash", null, "junk", "inbox", "sent"] as const)
      .slice()
      .sort((a, b) => syncPriority(a) - syncPriority(b));
    expect(order).toEqual(["inbox", "sent", null, "junk", "trash"]);
  });
});
