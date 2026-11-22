import { describe, expect, it } from "vitest";
import {
  ACCOUNT_COLOR_PRESETS,
  accountColorHex,
  accountColorLabel,
  accountColorStyle,
} from "./account-colors";

const accounts = [
  { id: "a", color: null, createdAt: "2026-11-01T00:00:00.000Z" },
  { id: "b", color: null, createdAt: "2026-11-02T00:00:00.000Z" },
  { id: "c", color: null, createdAt: "2026-11-03T00:00:00.000Z" },
];

describe("accountColorHex", () => {
  it("選んでいなければ、追加した順に割り当てる", () => {
    expect(
      accounts.map((account) => accountColorHex(accounts, account.id)),
    ).toEqual(["#0ea5e9", "#8b5cf6", "#10b981"]);
  });

  it("並び替えても色は変わらない", () => {
    const reordered = [...accounts].reverse();
    expect(accountColorHex(reordered, "a")).toBe("#0ea5e9");
    expect(accountColorHex(reordered, "c")).toBe("#10b981");
  });

  it("選んだ色を優先し、ほかのアカウントの色は変えない", () => {
    const list = accounts.map((account) =>
      account.id === "a" ? { ...account, color: "#abcdef" } : account,
    );
    expect(accountColorHex(list, "a")).toBe("#abcdef");
    expect(accountColorHex(list, "b")).toBe("#8b5cf6");
  });

  it("色の数より多くても、繰り返して割り当てる", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      color: null,
      createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    expect(accountColorHex(many, "8")).toBe("#0ea5e9");
  });

  it("知らないアカウントや色の名前でも、決まった色を返す", () => {
    expect(accountColorHex(accounts, "x")).toBe("#0ea5e9");
    expect(
      accountColorHex([{ id: "a", color: "unknown", createdAt: "" }], "a"),
    ).toBe("#0ea5e9");
  });
});

describe("以前の保存形式", () => {
  it("色の名前も読める", () => {
    expect(
      accountColorHex([{ id: "a", color: "rose", createdAt: "" }], "a"),
    ).toBe("#f43f5e");
  });
});

describe("ACCOUNT_COLOR_PRESETS", () => {
  it("20 色あり、重複しない", () => {
    expect(ACCOUNT_COLOR_PRESETS).toHaveLength(20);
    expect(new Set(ACCOUNT_COLOR_PRESETS.map((item) => item.hex)).size).toBe(
      20,
    );
    expect(accountColorLabel("#0ea5e9")).toBe("水色");
    expect(accountColorLabel("#abcdef")).toBeNull();
  });
});

describe("accountColorStyle", () => {
  it("配色ごとに見やすい色を変数にする", () => {
    expect(accountColorStyle("#ffffff")).toMatchObject({
      "--ac-d": "#ffffff",
      "--ac-on-d": "#171717",
    });
    expect(
      (accountColorStyle("#ffffff") as Record<string, string>)["--ac-l"],
    ).not.toBe("#ffffff");
    expect(accountColorStyle("#be123c")).toMatchObject({
      "--ac-l": "#be123c",
      "--ac-on-l": "#ffffff",
    });
  });
});
