import { describe, expect, it } from "vitest";
import { accountColor, accountColorName } from "./account-colors";

const accounts = [
  { id: "a", color: null, createdAt: "2026-11-01T00:00:00.000Z" },
  { id: "b", color: null, createdAt: "2026-11-02T00:00:00.000Z" },
  { id: "c", color: null, createdAt: "2026-11-03T00:00:00.000Z" },
];

describe("accountColorName", () => {
  it("選んでいなければ、追加した順に割り当てる", () => {
    expect(
      accounts.map((account) => accountColorName(accounts, account.id)),
    ).toEqual(["sky", "violet", "emerald"]);
  });

  it("並び替えても色は変わらない", () => {
    const reordered = [...accounts].reverse();
    expect(accountColorName(reordered, "a")).toBe("sky");
    expect(accountColorName(reordered, "c")).toBe("emerald");
  });

  it("選んだ色を優先し、ほかのアカウントの色は変えない", () => {
    const list = accounts.map((account) =>
      account.id === "a" ? { ...account, color: "rose" as const } : account,
    );
    expect(accountColorName(list, "a")).toBe("rose");
    expect(accountColorName(list, "b")).toBe("violet");
  });

  it("色の数より多くても、繰り返して割り当てる", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      color: null,
      createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    expect(accountColorName(many, "8")).toBe("sky");
  });

  it("知らないアカウントや色の名前でも、決まった色を返す", () => {
    expect(accountColorName(accounts, "x")).toBe("sky");
    expect(
      accountColorName(
        [{ id: "a", color: "unknown" as never, createdAt: "" }],
        "a",
      ),
    ).toBe("sky");
  });
});

describe("accountColor", () => {
  it("点に付けるクラスを返す", () => {
    expect(accountColor(accounts, "b")).toBe("bg-violet-500");
  });
});
