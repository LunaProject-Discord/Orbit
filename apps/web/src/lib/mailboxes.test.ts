import { describe, expect, it } from "vitest";
import type { MailboxSummary } from "@/lib/api";
import { buildMailboxTree, mailboxLabel } from "@/lib/mailboxes";

function mailbox(
  id: string,
  overrides: Partial<MailboxSummary> = {},
): MailboxSummary {
  return {
    id,
    accountId: "account",
    parentId: null,
    path: id,
    name: id,
    specialUse: null,
    lastSyncedAt: null,
    totalCount: 0,
    unreadCount: 0,
    ...overrides,
  };
}

function shape(nodes: ReturnType<typeof buildMailboxTree>): unknown[] {
  return nodes.map((node) =>
    node.children.length > 0
      ? [node.mailbox.id, shape(node.children)]
      : node.mailbox.id,
  );
}

describe("buildMailboxTree", () => {
  it("役割のあるフォルダを先に、残りを名前順に並べる", () => {
    const tree = buildMailboxTree([
      mailbox("zeta"),
      mailbox("trash", { specialUse: "trash" }),
      mailbox("alpha"),
      mailbox("sent", { specialUse: "sent" }),
      mailbox("inbox", { specialUse: "inbox" }),
    ]);
    expect(shape(tree)).toEqual(["inbox", "sent", "trash", "alpha", "zeta"]);
  });

  it("parentId からサブフォルダを組み立て、未読数を親に合算する", () => {
    const tree = buildMailboxTree([
      mailbox("child-b", { parentId: "parent", unreadCount: 2 }),
      mailbox("parent", { unreadCount: 1 }),
      mailbox("child-a", { parentId: "parent" }),
      mailbox("grandchild", { parentId: "child-a", unreadCount: 4 }),
    ]);
    expect(shape(tree)).toEqual([
      ["parent", [["child-a", ["grandchild"]], "child-b"]],
    ]);
    expect(tree[0]?.unreadTotal).toBe(7);
    expect(tree[0]?.children[0]?.unreadTotal).toBe(4);
  });

  it("親が一覧に無いフォルダや、親子が循環しているフォルダは最上位に置く", () => {
    const tree = buildMailboxTree([
      mailbox("orphan", { parentId: "missing" }),
      mailbox("a", { parentId: "b" }),
      mailbox("b", { parentId: "a" }),
    ]);
    expect(shape(tree)).toEqual(["a", "b", "orphan"]);
  });
});

describe("mailboxLabel", () => {
  it("役割のあるフォルダは決まった名前、それ以外はサーバーの名前を使う", () => {
    expect(
      mailboxLabel(mailbox("x", { name: "Sent Items", specialUse: "sent" })),
    ).toBe("送信済み");
    expect(mailboxLabel(mailbox("x", { name: "プロジェクト" }))).toBe(
      "プロジェクト",
    );
  });
});
