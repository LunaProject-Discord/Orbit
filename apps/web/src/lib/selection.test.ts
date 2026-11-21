import { describe, expect, it } from "vitest";
import { actionBatches, selectRange, toggleSelection } from "@/lib/selection";

describe("toggleSelection", () => {
  it("選択を切り替え、元の集合は変えない", () => {
    const base = new Set(["a"]);
    expect([...toggleSelection(base, "b")]).toEqual(["a", "b"]);
    expect([...toggleSelection(base, "a")]).toEqual([]);
    expect([...base]).toEqual(["a"]);
  });
});

describe("selectRange", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("起点からその行までを、上下どちら向きでも選ぶ", () => {
    expect([...selectRange(order, new Set(), "b", "d")]).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect([...selectRange(order, new Set(["e"]), "d", "b")].sort()).toEqual([
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("起点が無いか一覧に無ければ、その行だけを選ぶ", () => {
    expect([...selectRange(order, new Set(), null, "c")]).toEqual(["c"]);
    expect([...selectRange(order, new Set(), "x", "c")]).toEqual(["c"]);
    expect([...selectRange(order, new Set(["a"]), "a", "x")]).toEqual(["a"]);
  });
});

describe("actionBatches", () => {
  const row = (accountId: string, ...threadMessageIds: string[]) => ({
    accountId,
    threadMessageIds,
  });

  it("アカウントごとに分け、会話のメッセージをまとめて含める", () => {
    expect(
      actionBatches([row("p", "a", "b"), row("w", "c"), row("p", "d")]),
    ).toEqual([["a", "b", "d"], ["c"]]);
  });

  it("上限を超えるときは分け、会話は途中で切らない", () => {
    expect(
      actionBatches([row("p", "a", "b"), row("p", "c", "d"), row("p", "e")], 3),
    ).toEqual([
      ["a", "b"],
      ["c", "d", "e"],
    ]);
    // 1 つの会話が上限を超える場合だけ、会話を分ける。
    expect(actionBatches([row("p", "a", "b", "c")], 2)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });
});
