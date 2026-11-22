// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { createActionQueue } from "@/lib/actions";
import type { Mailbox, MessageAction, MessageSummary } from "@/lib/api";
import { affectedRows, isUndoable, restoreRows, undoMessage } from "@/lib/undo";

function row(id: string, receivedAt: string, members = [id]): MessageSummary {
  return {
    id,
    accountId: "account",
    mailboxId: "inbox",
    threadKey: id,
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
  } as MessageSummary;
}

const mailbox = (id: string, specialUse: Mailbox["specialUse"] = null) =>
  ({ id, parentId: null, path: id, name: id, specialUse }) as Mailbox;

const newestFirst = (a: MessageSummary, b: MessageSummary) =>
  b.receivedAt.localeCompare(a.receivedAt);

describe("元に戻せる操作", () => {
  it("移動と削除は元に戻せ、既読やスターは対象にしない", () => {
    expect(isUndoable({ action: "delete" })).toBe(true);
    expect(isUndoable({ action: "move", destination: "trash" })).toBe(true);
    expect(isUndoable({ action: "set_flags", seen: true })).toBe(false);
  });

  it("移動先の役割に合わせた文言にする", () => {
    const mailboxes = [
      mailbox("t", "trash"),
      mailbox("a", "archive"),
      mailbox("w"),
    ];
    expect(undoMessage({ action: "move", mailboxId: "t" }, mailboxes, 1)).toBe(
      "削除しました",
    );
    expect(
      undoMessage({ action: "move", destination: "archive" }, mailboxes, 1),
    ).toBe("アーカイブしました");
    expect(
      undoMessage({ action: "move", destination: "junk" }, mailboxes, 3),
    ).toBe("3 件の会話を迷惑メールに移動しました");
    expect(undoMessage({ action: "move", mailboxId: "w" }, mailboxes, 1)).toBe(
      "「w」に移動しました",
    );
    expect(undoMessage({ action: "delete" }, mailboxes, 2)).toBe(
      "2 件の会話を完全に削除しました",
    );
  });
});

describe("行を元に戻す", () => {
  const rows = [
    row("a", "2026-11-22T03:00:00Z"),
    row("b", "2026-11-22T02:00:00Z", ["b", "b2"]),
    row("c", "2026-11-22T01:00:00Z"),
  ];

  it("操作の対象を含む会話の行を控える", () => {
    expect(affectedRows(rows, ["b2", "c"]).map((item) => item.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("無くなった行は、並び順に合う位置へ入れ直す", () => {
    const after = [rows[0], rows[2]] as MessageSummary[];
    expect(
      restoreRows(after, [rows[1] as MessageSummary], newestFirst).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("一部だけ残っていた会話は、控えの内容に差し替える", () => {
    const partial = { ...rows[1], threadCount: 1, threadMessageIds: ["b"] };
    const restored = restoreRows(
      [rows[0], partial, rows[2]] as MessageSummary[],
      [rows[1] as MessageSummary],
      newestFirst,
    );
    expect(restored[1]?.threadMessageIds).toEqual(["b", "b2"]);
    expect(restored).toHaveLength(3);
  });
});

describe("送るのを待たせる操作", () => {
  beforeEach(() => window.localStorage.clear());

  const action = (key: string, ids: string[]): MessageAction => ({
    idempotencyKey: key,
    messageIds: ids,
    action: "delete",
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("待たせている間は送らず、送ってよくなったら送る", async () => {
    const sent: string[] = [];
    const queue = createActionQueue(async (item) => {
      sent.push(item.idempotencyKey);
    });
    const counts: number[] = [];
    queue.onChange((count) => counts.push(count));
    queue.enqueue(action("1", ["a"]), { hold: true });
    await tick();
    expect(sent).toEqual([]);
    // 一覧に重ねる対象には入るが、「送れていない操作」には数えない。
    expect(queue.pending()).toHaveLength(1);
    expect(counts.at(-1)).toBe(0);
    queue.release("1");
    await tick();
    expect(sent).toEqual(["1"]);
    expect(queue.pending()).toHaveLength(0);
    queue.stop();
  });

  it("取り消した操作は送らない", async () => {
    const sent: string[] = [];
    const queue = createActionQueue(async (item) => {
      sent.push(item.idempotencyKey);
    });
    queue.enqueue(action("1", ["a"]), { hold: true });
    expect(queue.cancel("1")).toBe(true);
    await tick();
    expect(sent).toEqual([]);
    expect(queue.pending()).toHaveLength(0);
    // すでに無い操作は取り消せない。
    expect(queue.cancel("1")).toBe(false);
    queue.stop();
  });

  it("待たせている操作と関係のない操作は先に送り、同じメールへの操作は待つ", async () => {
    const sent: string[] = [];
    const queue = createActionQueue(async (item) => {
      sent.push(item.idempotencyKey);
    });
    queue.enqueue(action("1", ["a"]), { hold: true });
    queue.enqueue(action("2", ["b"]));
    queue.enqueue(action("3", ["a"]));
    await tick();
    expect(sent).toEqual(["2"]);
    queue.release("1");
    await tick();
    expect(sent).toEqual(["2", "1", "3"]);
    queue.stop();
  });

  it("送り終えた操作は取り消せない", async () => {
    const queue = createActionQueue(async () => {});
    queue.enqueue(action("1", ["a"]));
    await tick();
    expect(queue.cancel("1")).toBe(false);
    queue.stop();
  });
});
