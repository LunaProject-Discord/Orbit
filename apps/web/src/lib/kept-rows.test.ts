import { describe, expect, it } from "vitest";
import type { MessageSummary } from "@/lib/api";
import { keepRows } from "@/lib/kept-rows";

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

const newestFirst = (a: MessageSummary, b: MessageSummary) =>
  b.receivedAt.localeCompare(a.receivedAt);

describe("条件から外れた行を一覧に残す", () => {
  const a = row("a", "2026-11-03");
  const b = row("b", "2026-11-02");
  const c = row("c", "2026-11-01");

  it("残す行が無ければ、取得した一覧をそのまま返す", () => {
    const next = [a, c];
    expect(keepRows([a, b, c], next, new Set(), newestFirst)).toBe(next);
  });

  it("取得し直した一覧から無くなった行を、操作後の姿で元の位置へ戻す", () => {
    const read = { ...b, seen: true };
    const result = keepRows([a, read, c], [a, c], new Set(["b"]), newestFirst);
    expect(result.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result[1]?.seen).toBe(true);
  });

  it("残すことにしていない行は戻さない (ほかの端末で削除されたなど)", () => {
    const result = keepRows([a, b, c], [a], new Set(["b"]), newestFirst);
    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("サーバーの一覧にまた出てきた行は、サーバーの内容を使う", () => {
    const read = { ...b, seen: true };
    const next = [a, b, c];
    expect(keepRows([a, read, c], next, new Set(["b"]), newestFirst)).toBe(
      next,
    );
  });

  it("同じ会話が別の行として出ているときは、重ねて出さない", () => {
    const thread = row("b", "2026-11-02", ["b", "b0"]);
    const grown = row("b2", "2026-11-04", ["b2", "b", "b0"]);
    const result = keepRows(
      [a, thread, c],
      [grown, a, c],
      new Set(["b"]),
      newestFirst,
    );
    expect(result.map((item) => item.id)).toEqual(["b2", "a", "c"]);
  });
});
