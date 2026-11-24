import { describe, expect, it } from "vitest";
import { applyActions } from "@/lib/actions";
import type { MailboxSummary, MessageAction, MessageSummary } from "@/lib/api";
import {
  adjustUnreadCounts,
  insertPendingMoves,
  pruneSnapshots,
} from "@/lib/pending-moves";

function row(
  id: string,
  receivedAt: string,
  members = [id],
  mailboxId = "inbox-a",
): MessageSummary {
  return {
    id,
    accountId: "a",
    mailboxId,
    threadKey: `t-${id}`,
    subject: id,
    from: [],
    to: [],
    receivedAt,
    snippet: "",
    hasAttachments: false,
    seen: false,
    flagged: false,
    answered: false,
    threadCount: members.length,
    threadMessageIds: members,
  };
}

function mailbox(
  id: string,
  specialUse: MailboxSummary["specialUse"],
  accountId = "a",
): MailboxSummary {
  return {
    id,
    accountId,
    parentId: null,
    path: id,
    name: id,
    specialUse,
    sortOrder: null,
    lastSyncedAt: null,
    totalCount: 0,
    unreadCount: 0,
  };
}

const mailboxes = [
  mailbox("inbox-a", "inbox"),
  mailbox("trash-a", "trash"),
  mailbox("work-a", null),
  mailbox("all-a", "all"),
];

const trash = { accountId: "a", mailboxId: "trash-a" };

describe("送信待ちの移動を移動先の一覧に出す", () => {
  const x = row("x", "2026-11-02");
  const del: MessageAction = {
    idempotencyKey: "k1",
    messageIds: ["x"],
    action: "move",
    destination: "trash",
  };

  it("削除したメールを、サーバーへ届く前からごみ箱に出す", () => {
    const old = row("o", "2026-11-01", ["o"], "trash-a");
    const result = insertPendingMoves(
      [old],
      [del],
      new Map([["k1", [x]]]),
      mailboxes,
      trash,
    );
    expect(result.map((r) => [r.id, r.mailboxId])).toEqual([
      ["x", "trash-a"],
      ["o", "trash-a"],
    ]);
  });

  it("移動元の一覧には出さない", () => {
    const fetched = applyActions([x], [del]);
    const result = insertPendingMoves(
      fetched,
      [del],
      new Map([["k1", [x]]]),
      mailboxes,
      { accountId: "a", mailboxId: "inbox-a" },
    );
    expect(result).toEqual([]);
  });

  it("サーバーに反映済みなら二重に出さない", () => {
    const server = row("x", "2026-11-02", ["x"], "trash-a");
    const result = insertPendingMoves(
      [server],
      [del],
      new Map([["k1", [x]]]),
      mailboxes,
      trash,
    );
    expect(result).toEqual([server]);
  });

  it("フォルダを指定した移動と、その後の既読も反映する", () => {
    const move: MessageAction = {
      idempotencyKey: "k2",
      messageIds: ["x"],
      action: "move",
      mailboxId: "work-a",
    };
    const read: MessageAction = {
      idempotencyKey: "k3",
      messageIds: ["x"],
      action: "set_flags",
      seen: true,
    };
    const result = insertPendingMoves(
      [],
      [move, read],
      new Map([["k2", [x]]]),
      mailboxes,
      { accountId: "a", mailboxId: "work-a" },
    );
    expect(result).toMatchObject([
      { id: "x", mailboxId: "work-a", seen: true },
    ]);
  });

  it("続けて別のフォルダへ移したら、最後の移動先にだけ出す", () => {
    const again: MessageAction = {
      idempotencyKey: "k2",
      messageIds: ["x"],
      action: "move",
      mailboxId: "work-a",
    };
    const snapshots = new Map([
      ["k1", [x]],
      ["k2", [{ ...x, mailboxId: "trash-a" }]],
    ]);
    expect(
      insertPendingMoves([], [del, again], snapshots, mailboxes, trash),
    ).toEqual([]);
    expect(
      insertPendingMoves([], [del, again], snapshots, mailboxes, {
        accountId: "a",
        mailboxId: "work-a",
      }),
    ).toHaveLength(1);
  });

  it("アーカイブ先が無ければ「すべてのメール」に出す", () => {
    const archive: MessageAction = {
      idempotencyKey: "k4",
      messageIds: ["x"],
      action: "move",
      destination: "archive",
    };
    const result = insertPendingMoves(
      [],
      [archive],
      new Map([["k4", [x]]]),
      mailboxes,
      { accountId: "a", mailboxId: "all-a" },
    );
    expect(result).toMatchObject([{ id: "x", mailboxId: "all-a" }]);
  });

  it("受信トレイへ戻したメールは、すべての受信トレイにも出す", () => {
    const back: MessageAction = {
      idempotencyKey: "k5",
      messageIds: ["j"],
      action: "move",
      destination: "inbox",
    };
    const junk = row("j", "2026-11-03", ["j"], "junk-a");
    const result = insertPendingMoves(
      [],
      [back],
      new Map([["k5", [junk]]]),
      mailboxes,
      { accountId: null, mailboxId: null },
    );
    expect(result).toMatchObject([{ id: "j", mailboxId: "inbox-a" }]);
  });

  it("会話の一部だけを移したら、移した分だけの行にし、同じ会話の行があればまとめる", () => {
    const thread = row("m2", "2026-11-05", ["m1", "m2"]);
    const part: MessageAction = {
      idempotencyKey: "k6",
      messageIds: ["m1"],
      action: "move",
      destination: "trash",
    };
    const alone = insertPendingMoves(
      [],
      [part],
      new Map([["k6", [thread]]]),
      mailboxes,
      trash,
    );
    expect(alone).toMatchObject([{ id: "m1", threadMessageIds: ["m1"] }]);

    const existing = { ...row("m0", "2026-11-04", ["m0"], "trash-a") };
    existing.threadKey = thread.threadKey;
    const merged = insertPendingMoves(
      [existing],
      [part],
      new Map([["k6", [thread]]]),
      mailboxes,
      trash,
    );
    expect(merged).toMatchObject([
      { id: "m0", threadMessageIds: ["m0", "m1"] },
    ]);
  });

  it("完全に削除したメールは出さない", () => {
    const purge: MessageAction = {
      idempotencyKey: "k7",
      messageIds: ["x"],
      action: "delete",
    };
    expect(
      insertPendingMoves(
        [],
        [del, purge],
        new Map([["k1", [x]]]),
        mailboxes,
        trash,
      ),
    ).toEqual([]);
  });

  it("送信待ちに無い操作の控えは捨てる", () => {
    const snapshots = new Map([
      ["k1", [x]],
      ["gone", [x]],
    ]);
    pruneSnapshots(snapshots, [del]);
    expect([...snapshots.keys()]).toEqual(["k1"]);
  });
});

describe("送信待ちの操作を未読数に重ねる", () => {
  const counted = mailboxes.map((m) =>
    m.id === "inbox-a" ? { ...m, unreadCount: 3 } : m,
  );
  const unread = row("x", "2026-11-02");

  it("未読のメールを削除したら、受信トレイから減らしごみ箱に足す", () => {
    const del: MessageAction = {
      idempotencyKey: "k1",
      messageIds: ["x"],
      action: "move",
      destination: "trash",
    };
    const result = adjustUnreadCounts(
      counted,
      [del],
      new Map([["k1", [unread]]]),
    );
    expect(result.find((m) => m.id === "inbox-a")?.unreadCount).toBe(2);
    expect(result.find((m) => m.id === "trash-a")?.unreadCount).toBe(1);
  });

  it("既読にしたら減らし、既読のメールを未読にしたら増やす", () => {
    const read: MessageAction = {
      idempotencyKey: "k2",
      messageIds: ["x"],
      action: "set_flags",
      seen: true,
    };
    const unreadAgain: MessageAction = {
      idempotencyKey: "k3",
      messageIds: ["x"],
      action: "set_flags",
      seen: false,
    };
    const result = adjustUnreadCounts(
      counted,
      [read, unreadAgain],
      new Map([
        ["k2", [unread]],
        ["k3", [{ ...unread, seen: true }]],
      ]),
    );
    expect(result.find((m) => m.id === "inbox-a")?.unreadCount).toBe(3);
  });

  it("控えの無い操作は数えない", () => {
    const read: MessageAction = {
      idempotencyKey: "none",
      messageIds: ["x"],
      action: "set_flags",
      seen: true,
    };
    expect(adjustUnreadCounts(counted, [read], new Map())).toBe(counted);
  });
});
