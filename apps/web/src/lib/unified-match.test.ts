import { describe, expect, it } from "vitest";
import { applyActions, knownUnseen } from "@/lib/actions";
import type {
  MailboxSummary,
  MessageAction,
  MessageSummary,
  UnifiedCondition,
  UnifiedFolder,
} from "@/lib/api";
import { adjustUnreadCounts } from "@/lib/pending-moves";
import {
  adjustUnifiedCounts,
  factsOf,
  matchesFilters,
  overlayUnifiedRows,
} from "@/lib/unified-match";

function row(
  id: string,
  receivedAt: string,
  patch: Partial<MessageSummary> = {},
): MessageSummary {
  return {
    id,
    accountId: "a",
    mailboxId: "inbox-a",
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
    threadCount: 1,
    threadMessageIds: [id],
    ...patch,
  };
}

function mailbox(
  id: string,
  specialUse: MailboxSummary["specialUse"],
): MailboxSummary {
  return {
    id,
    accountId: "a",
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
  mailbox("archive-a", "archive"),
  mailbox("trash-a", "trash"),
];

function folder(
  id: string,
  children: UnifiedCondition[],
  unreadCount = 10,
  scope: UnifiedFolder["scope"] = { all: true, roles: [], mailboxIds: [] },
  match: "all" | "any" | "none" = "all",
): UnifiedFolder {
  return {
    id,
    name: id,
    icon: null,
    color: null,
    scope,
    filters: { version: 2, root: { type: "group", match, children } },
    createdAt: "2026-11-01",
    unreadCount,
  };
}

const unreadRule: UnifiedCondition = {
  type: "flag",
  flag: "unread",
  negate: false,
};
const textRule: UnifiedCondition = {
  type: "text",
  field: "from",
  value: "boss",
  negate: false,
};

const read = (key: string, ids: string[]): MessageAction => ({
  idempotencyKey: key,
  messageIds: ids,
  action: "set_flags",
  seen: true,
});
const unread = (key: string, ids: string[]): MessageAction => ({
  idempotencyKey: key,
  messageIds: ids,
  action: "set_flags",
  seen: false,
});

describe("統合フォルダの条件を端末で確かめる", () => {
  const facts = factsOf(row("x", "2026-11-20"), "x");

  it("未読の条件は、既読の状態から決まる", () => {
    expect(matchesFilters(folder("f", [unreadRule]), facts)).toBe(true);
    expect(
      matchesFilters(folder("f", [unreadRule]), { ...facts, seen: true }),
    ).toBe(false);
  });

  it("文字の条件は分からないが、AND / OR で決まる場合は決める", () => {
    expect(matchesFilters(folder("f", [unreadRule, textRule]), facts)).toBe(
      null,
    );
    expect(
      matchesFilters(folder("f", [unreadRule, textRule]), {
        ...facts,
        seen: true,
      }),
    ).toBe(false);
    expect(
      matchesFilters(
        folder("f", [unreadRule, textRule], 0, undefined, "any"),
        facts,
      ),
    ).toBe(true);
  });

  it("「どれにも当てはまらない」は否定する", () => {
    const none = folder("f", [unreadRule], 0, undefined, "none");
    expect(matchesFilters(none, facts)).toBe(false);
    expect(matchesFilters(none, { ...facts, seen: true })).toBe(true);
  });

  it("中身の無い条件は無視する", () => {
    const blank: UnifiedCondition = {
      type: "query",
      value: "  ",
      negate: false,
    };
    expect(matchesFilters(folder("f", [blank]), facts)).toBe(true);
    expect(matchesFilters(folder("f", []), facts)).toBe(true);
  });

  it("受信日の条件", () => {
    const recent: UnifiedCondition = {
      type: "received",
      days: 7,
      negate: false,
    };
    const now = Date.parse("2026-11-25T00:00:00Z");
    expect(matchesFilters(folder("f", [recent]), facts, now)).toBe(true);
    const old = factsOf(row("y", "2026-10-01"), "y");
    expect(matchesFilters(folder("f", [recent]), old, now)).toBe(false);
  });
});

describe("統合フォルダの未読数に送信待ちの操作を重ねる", () => {
  const x = row("x", "2026-11-20");

  it("既読にすると、未読だけの統合フォルダの未読数が減る", () => {
    const action = read("k", ["x"]);
    const [result] = adjustUnifiedCounts(
      [folder("unread", [unreadRule])],
      [action],
      new Map([["k", [x]]]),
      new Map(),
      mailboxes,
    );
    expect(result?.unreadCount).toBe(9);
  });

  it("未読にすると増える", () => {
    const action = unread("k", ["x"]);
    const [result] = adjustUnifiedCounts(
      [folder("unread", [unreadRule])],
      [action],
      new Map([["k", [{ ...x, seen: true }]]]),
      new Map(),
      mailboxes,
    );
    expect(result?.unreadCount).toBe(11);
  });

  it("集める場所に入っていないフォルダの操作は数えない", () => {
    const inboxOnly = folder("inbox", [], 10, {
      all: false,
      roles: ["archive"],
      mailboxIds: [],
    });
    const [result] = adjustUnifiedCounts(
      [inboxOnly],
      [read("k", ["x"])],
      new Map([["k", [x]]]),
      new Map(),
      mailboxes,
    );
    expect(result?.unreadCount).toBe(10);
  });

  it("文字の条件で分からないときは変えないが、その統合フォルダの一覧で操作したなら減らす", () => {
    const withText = folder("text", [unreadRule, textRule]);
    const snapshots = new Map([["k", [x]]]);
    const [unknown] = adjustUnifiedCounts(
      [withText],
      [read("k", ["x"])],
      snapshots,
      new Map(),
      mailboxes,
    );
    expect(unknown?.unreadCount).toBe(10);
    const [known] = adjustUnifiedCounts(
      [withText],
      [read("k", ["x"])],
      snapshots,
      new Map([["k", "text"]]),
      mailboxes,
    );
    expect(known?.unreadCount).toBe(9);
  });

  it("ごみ箱へ移すと減り、アーカイブへ移しても全フォルダが対象なら変わらない", () => {
    const all = folder("all", [unreadRule]);
    const trash: MessageAction = {
      idempotencyKey: "k",
      messageIds: ["x"],
      action: "move",
      destination: "trash",
    };
    const archive: MessageAction = { ...trash, destination: "archive" };
    const snapshots = new Map([["k", [x]]]);
    expect(
      adjustUnifiedCounts([all], [trash], snapshots, new Map(), mailboxes)[0]
        ?.unreadCount,
    ).toBe(9);
    expect(
      adjustUnifiedCounts([all], [archive], snapshots, new Map(), mailboxes)[0]
        ?.unreadCount,
    ).toBe(10);
  });

  it("会話の一部を既読にしたとき、どれが未読か分かれば正しく数える", () => {
    const thread = row("c", "2026-11-20", {
      threadMessageIds: ["a", "b", "c"],
      threadCount: 3,
      unseenIds: ["b", "c"],
    });
    const snapshots = new Map([["k", [thread]]]);
    const [result] = adjustUnifiedCounts(
      [folder("unread", [unreadRule])],
      [read("k", ["a", "b"])],
      snapshots,
      new Map(),
      mailboxes,
    );
    // a はもともと既読なので、減るのは b の 1 通だけ。
    expect(result?.unreadCount).toBe(9);
    // フォルダの未読数も同じ。
    const [inbox] = adjustUnreadCounts(
      [{ ...mailbox("inbox-a", "inbox"), unreadCount: 5 }],
      [read("k", ["a", "b"])],
      snapshots,
    );
    expect(inbox?.unreadCount).toBe(4);
  });

  it("すべて既読にしたフォルダの未読は、未読だけの統合フォルダから引く", () => {
    const [result] = adjustUnifiedCounts(
      [folder("unread", [unreadRule])],
      [],
      new Map(),
      new Map(),
      mailboxes,
      [{ mailboxId: "inbox-a", unread: 4 }],
    );
    expect(result?.unreadCount).toBe(6);
    const inboxOnly = folder("inbox", [textRule], 7, {
      all: false,
      roles: ["inbox"],
      mailboxIds: [],
    });
    const [zero] = adjustUnifiedCounts(
      [inboxOnly],
      [],
      new Map(),
      new Map(),
      mailboxes,
      [{ mailboxId: "inbox-a", unread: 4 }],
    );
    expect(zero?.unreadCount).toBe(0);
  });
});

describe("どれが未読かを覚えて一覧に重ねる", () => {
  it("会話の最後の未読を既読にすると、行も既読になる", () => {
    const thread = row("c", "2026-11-20", {
      threadMessageIds: ["a", "c"],
      unseenIds: ["c"],
    });
    const [next] = applyActions([thread], [read("k", ["c"])]);
    expect(next?.seen).toBe(true);
    expect(next?.unseenIds).toEqual([]);
  });

  it("unseenIds が無い会話は、分かる範囲だけ扱う", () => {
    const thread = row("c", "2026-11-20", { threadMessageIds: ["a", "c"] });
    expect(knownUnseen(thread)).toBe(null);
    const [next] = applyActions([thread], [read("k", ["c"])]);
    expect(next?.seen).toBe(false);
    expect(knownUnseen(row("x", "2026-11-20"))).toEqual(["x"]);
  });
});

describe("統合フォルダの一覧に送信待ちの操作を重ねる", () => {
  const unreadFolder = folder("unread", [unreadRule]);
  const x = row("x", "2026-11-20");
  const y = row("y", "2026-11-19");

  it("ほかのウィンドウで既読にした行は、未読だけの統合フォルダから外す", () => {
    const action = read("k", ["x"]);
    const rows = applyActions([x, y], [action]);
    const result = overlayUnifiedRows(
      rows,
      [action],
      new Map([["k", [x]]]),
      unreadFolder,
      mailboxes,
    );
    expect(result.map((item) => item.id)).toEqual(["y"]);
  });

  it("利用者がこの一覧で操作した行 (kept) は残す", () => {
    const action = read("k", ["x"]);
    const rows = applyActions([x, y], [action]);
    const result = overlayUnifiedRows(
      rows,
      [action],
      new Map([["k", [x]]]),
      unreadFolder,
      mailboxes,
      new Set(["x"]),
    );
    expect(result.map((item) => item.id)).toEqual(["x", "y"]);
  });

  it("未読にした行は、未読だけの統合フォルダへ入れる", () => {
    const seenX = { ...x, seen: true };
    const action = unread("k", ["x"]);
    const result = overlayUnifiedRows(
      [y],
      [action],
      new Map([["k", [seenX]]]),
      unreadFolder,
      mailboxes,
    );
    expect(result.map((item) => item.id)).toEqual(["x", "y"]);
    expect(result[0]?.seen).toBe(false);
  });

  it("あとで削除したメールは入れない", () => {
    const seenX = { ...x, seen: true };
    const actions: MessageAction[] = [
      unread("k", ["x"]),
      { idempotencyKey: "d", messageIds: ["x"], action: "delete" },
    ];
    const result = overlayUnifiedRows(
      [y],
      actions,
      new Map([["k", [seenX]]]),
      unreadFolder,
      mailboxes,
    );
    expect(result.map((item) => item.id)).toEqual(["y"]);
  });
});
