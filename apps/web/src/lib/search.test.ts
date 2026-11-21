import { describe, expect, it } from "vitest";
import {
  countFilters,
  emptyFilters,
  highlightParts,
  isSearchActive,
} from "@/lib/search";

describe("isSearchActive", () => {
  it("入力も条件も無ければ検索しない", () => {
    expect(isSearchActive({ text: "  ", filters: emptyFilters })).toBe(false);
  });

  it("入力か条件のどちらかがあれば検索する", () => {
    expect(isSearchActive({ text: "日程", filters: emptyFilters })).toBe(true);
    expect(
      isSearchActive({ text: "", filters: { ...emptyFilters, unread: true } }),
    ).toBe(true);
  });
});

describe("countFilters", () => {
  it("期間は始まりと終わりで 1 つと数える", () => {
    expect(
      countFilters({
        ...emptyFilters,
        from: "佐藤",
        since: "2026-11-01",
        until: "2026-11-30",
        hasAttachment: true,
      }),
    ).toBe(3);
  });
});

describe("highlightParts", () => {
  it("語に当たる部分を分ける (大文字と小文字は区別しない)", () => {
    expect(
      highlightParts("Always Free のご利用状況", ["free", "利用"]),
    ).toEqual([
      { text: "Always ", match: false },
      { text: "Free", match: true },
      { text: " のご", match: false },
      { text: "利用", match: true },
      { text: "状況", match: false },
    ]);
  });

  it("同じ位置で重なる語は長いほうを使う", () => {
    expect(highlightParts("定例ミーティング", ["定例", "定例ミ"])).toEqual([
      { text: "定例ミ", match: true },
      { text: "ーティング", match: false },
    ]);
  });

  it("語が無ければそのまま返す", () => {
    expect(highlightParts("件名", [])).toEqual([
      { text: "件名", match: false },
    ]);
    expect(highlightParts("件名", ["本文"])).toEqual([
      { text: "件名", match: false },
    ]);
  });
});
