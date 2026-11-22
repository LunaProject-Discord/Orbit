import { describe, expect, it } from "vitest";
import type { MessageSummary, ThreadMessage } from "@/lib/api";
import {
  applyActionToThreads,
  flattenRows,
  indexOfOpen,
  itemKey,
  stepItem,
  type ThreadRows,
} from "@/lib/thread-rows";

const row = (id: string, threadCount = 1): MessageSummary => ({
  id,
  accountId: "account",
  mailboxId: "inbox",
  threadKey: id,
  subject: id,
  from: [],
  to: [],
  receivedAt: "2026-01-01T00:00:00.000Z",
  snippet: "",
  hasAttachments: false,
  seen: true,
  flagged: false,
  answered: false,
  threadCount,
  threadMessageIds: [id],
});

const child = (id: string, seen = true): ThreadMessage => ({
  id,
  accountId: "account",
  subject: id,
  from: [],
  to: [],
  cc: [],
  receivedAt: "2026-01-01T00:00:00.000Z",
  snippet: "",
  hasAttachments: false,
  seen,
  flagged: false,
  answered: false,
  draft: false,
  mailboxIds: ["inbox"],
});

const rows = [row("a"), row("b", 3), row("c", 2)];
const threads: ThreadRows = new Map([
  ["b", [child("b1"), child("b2"), child("b")]],
]);

describe("flattenRows", () => {
  it("広げた会話の下に、中のメールを新しい順で並べる", () => {
    const items = flattenRows(rows, new Set(["b"]), threads);
    expect(items.map(itemKey)).toEqual(["a", "b", "b:b", "b:b2", "b:b1", "c"]);
  });

  it("中身をまだ取得していない会話は、取得中の行を出す", () => {
    const items = flattenRows(rows, new Set(["c"]), threads);
    expect(items.map(itemKey)).toEqual(["a", "b", "c", "c:status"]);
    expect(items[3]).toMatchObject({ kind: "status", status: "loading" });
    const failed = flattenRows(
      rows,
      new Set(["c"]),
      new Map([["c", "error" as const]]),
    );
    expect(failed[3]).toMatchObject({ kind: "status", status: "error" });
  });

  it("1 通だけのメールは広げない", () => {
    const items = flattenRows(rows, new Set(["a"]), threads);
    expect(items.map(itemKey)).toEqual(["a", "b", "c"]);
  });
});

describe("indexOfOpen / stepItem", () => {
  const items = flattenRows(rows, new Set(["b", "c"]), threads);
  // a, b, b:b, b:b2, b:b1, c, c:status

  it("開いている行の位置を返す", () => {
    expect(indexOfOpen(items, { rowId: "b", childId: null })).toBe(1);
    expect(indexOfOpen(items, { rowId: "b", childId: "b2" })).toBe(3);
    expect(indexOfOpen(items, { rowId: "b", childId: "x" })).toBe(-1);
    expect(indexOfOpen(items, null)).toBe(-1);
  });

  it("前後の行へ進み、取得中の行は飛ばす", () => {
    expect(itemKey(stepItem(items, -1, 1) as never)).toBe("a");
    expect(itemKey(stepItem(items, 1, 1) as never)).toBe("b:b");
    expect(itemKey(stepItem(items, 2, -1) as never)).toBe("b");
    expect(itemKey(stepItem(items, 4, 1) as never)).toBe("c");
    expect(stepItem(items, 5, 1)).toBeNull();
    expect(stepItem(items, 0, -1)).toBeNull();
  });
});

describe("applyActionToThreads", () => {
  it("既読やスターを中のメールに反映する", () => {
    const source: ThreadRows = new Map([
      ["b", [child("b1", false), child("b")]],
    ]);
    const next = applyActionToThreads(source, {
      idempotencyKey: "k",
      messageIds: ["b1"],
      action: "set_flags",
      seen: true,
    });
    expect(next.get("b")).toMatchObject([
      { id: "b1", seen: true },
      { id: "b" },
    ]);
  });

  it("移動や削除をしたメールは並びから外す", () => {
    const next = applyActionToThreads(threads, {
      idempotencyKey: "k",
      messageIds: ["b2"],
      action: "delete",
    });
    expect((next.get("b") as ThreadMessage[]).map((item) => item.id)).toEqual([
      "b1",
      "b",
    ]);
  });

  it("対象が無ければ、同じものを返す", () => {
    expect(
      applyActionToThreads(threads, {
        idempotencyKey: "k",
        messageIds: ["zzz"],
        action: "delete",
      }),
    ).toBe(threads);
  });
});
