import { describe, expect, it } from "vitest";
import type { MailboxSummary } from "@/lib/api";
import {
  actionTargets,
  buildMailboxTree,
  mailboxLabel,
  moveBy,
  moveTo,
  orderMailboxes,
  sortAccounts,
  withSortOrder,
} from "@/lib/mailboxes";

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
    sortOrder: null,
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

describe("actionTargets", () => {
  const gmail = [
    mailbox("inbox", { specialUse: "inbox" }),
    mailbox("all", { specialUse: "all" }),
    mailbox("label"),
  ];

  it("アーカイブ用のフォルダが無い Gmail では「すべてのメール」をアーカイブ先にする", () => {
    expect(actionTargets(gmail, "inbox").archive?.id).toBe("all");
    expect(actionTargets(gmail, null).archive?.id).toBe("all");
  });

  it("受信トレイ以外を開いているときは「すべてのメール」へのアーカイブを出さない", () => {
    expect(actionTargets(gmail, "label").archive).toBeNull();
    expect(actionTargets(gmail, "all").archive).toBeNull();
  });

  it("アーカイブ用のフォルダがあればそれを使う", () => {
    const mailboxes = [...gmail, mailbox("archive", { specialUse: "archive" })];
    expect(actionTargets(mailboxes, "label").archive?.id).toBe("archive");
  });
});

describe("フォルダの並び替え", () => {
  it("並び替えた順に並べ、順番の無いフォルダは後ろに既定の順で並べる", () => {
    const tree = buildMailboxTree([
      mailbox("inbox", { specialUse: "inbox", sortOrder: 2 }),
      mailbox("work", { sortOrder: 0 }),
      mailbox("trash", { specialUse: "trash", sortOrder: 1 }),
      mailbox("zeta"),
      mailbox("sent", { specialUse: "sent" }),
      mailbox("alpha"),
    ]);
    expect(shape(tree)).toEqual([
      "work",
      "trash",
      "inbox",
      "sent",
      "alpha",
      "zeta",
    ]);
  });

  it("並び順は同じ親を持つフォルダの中で決まる", () => {
    const tree = buildMailboxTree([
      mailbox("b", { sortOrder: 0 }),
      mailbox("a", { sortOrder: 1 }),
      mailbox("a/y", { parentId: "a", sortOrder: 0 }),
      mailbox("a/x", { parentId: "a", sortOrder: 1 }),
    ]);
    expect(shape(tree)).toEqual(["b", ["a", ["a/y", "a/x"]]]);
  });

  it("ドラッグした項目を、落とした項目の位置へ動かす", () => {
    expect(moveTo(["a", "b", "c", "d"], "a", "c")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(moveTo(["a", "b", "c", "d"], "d", "b")).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    expect(moveTo(["a", "b"], "a", "a")).toBeNull();
    expect(moveTo(["a", "b"], "a", "x")).toBeNull();
  });

  it("キーボードでは 1 つずつ動かし、端では動かさない", () => {
    expect(moveBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveBy(["a", "b", "c"], "a", -1)).toBeNull();
    expect(moveBy(["a", "b", "c"], "c", 1)).toBeNull();
    expect(moveBy(["a", "b", "c"], "x", 1)).toBeNull();
  });

  it("並べた順に表示順を振り直し、対象外はそのままにする", () => {
    const items = [
      { id: "a", sortOrder: null },
      { id: "b", sortOrder: 5 },
      { id: "c", sortOrder: null },
    ];
    expect(withSortOrder(items, ["b", "a"])).toEqual([
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 0 },
      { id: "c", sortOrder: null },
    ]);
  });

  it("アカウントは並び替えた順、残りは追加した順に並べる", () => {
    const sorted = sortAccounts([
      { id: "old", sortOrder: null, createdAt: "2026-01-01T00:00:00Z" },
      { id: "second", sortOrder: 1, createdAt: "2026-02-01T00:00:00Z" },
      { id: "new", sortOrder: null, createdAt: "2026-03-01T00:00:00Z" },
      { id: "first", sortOrder: 0, createdAt: "2026-04-01T00:00:00Z" },
    ]);
    expect(sorted.map((account) => account.id)).toEqual([
      "first",
      "second",
      "old",
      "new",
    ]);
  });
});

describe("移動先の並び", () => {
  const list = [
    mailbox("inbox", { specialUse: "inbox", sortOrder: 1 }),
    mailbox("work", { sortOrder: 0 }),
    mailbox("work/b", { parentId: "work", sortOrder: 0 }),
    mailbox("work/a", { parentId: "work", sortOrder: 1 }),
    mailbox("junk", { specialUse: "junk" }),
    mailbox("sent", { specialUse: "sent" }),
    mailbox("trash", { specialUse: "trash" }),
  ];

  it("サイドバーと同じ順に、子は親のすぐ下へ階層を付けて並べる", () => {
    expect(
      orderMailboxes(list).map(({ mailbox, depth }) => [mailbox.id, depth]),
    ).toEqual([
      ["work", 0],
      ["work/b", 1],
      ["work/a", 1],
      ["inbox", 0],
      ["sent", 0],
      ["junk", 0],
      ["trash", 0],
    ]);
  });

  it("移動先は並び順を保ち、いまのフォルダと送信済みなどを除く", () => {
    const { destinations } = actionTargets(list, "inbox");
    expect(destinations.map(({ mailbox }) => mailbox.id)).toEqual([
      "work",
      "work/b",
      "work/a",
      "junk",
      "trash",
    ]);
  });

  it("迷惑メールのフォルダがあれば迷惑メールとして扱え、その中では戻せる", () => {
    expect(actionTargets(list, "inbox").junk?.id).toBe("junk");
    expect(actionTargets(list, "inbox").notJunk).toBeNull();
    expect(actionTargets(list, "junk").junk).toBeNull();
    expect(actionTargets(list, "junk").notJunk?.id).toBe("inbox");
    const withoutJunk = list.filter((item) => item.specialUse !== "junk");
    expect(actionTargets(withoutJunk, "inbox").junk).toBeNull();
  });
});
