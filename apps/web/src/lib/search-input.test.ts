import { describe, expect, it } from "vitest";
import { emptyFilters } from "@/lib/search";
import {
  addSearchHistory,
  completeQuery,
  filtersToText,
  quoteValue,
  replaceToken,
  tokenAt,
} from "@/lib/search-input";

describe("tokenAt", () => {
  it("カーソルの位置の語と演算子を切り出す", () => {
    expect(tokenAt("会議 from:sato", 12)).toEqual({
      start: 3,
      end: 12,
      negated: false,
      key: "from",
      value: "sato",
    });
  });

  it('除外の - と、全角のコロン、囲みの " を扱う', () => {
    expect(tokenAt("-to：“佐藤 美咲”", 5)).toMatchObject({
      negated: true,
      key: "to",
      value: "佐藤 美咲",
    });
  });

  it("空白の上では長さ 0 の語になる", () => {
    expect(tokenAt("会議 ", 3)).toMatchObject({
      start: 3,
      end: 3,
      key: "",
      value: "",
    });
  });
});

describe("replaceToken", () => {
  it("語を置き換えて空白を足し、カーソルをその後に置く", () => {
    const text = "fr 会議";
    expect(
      replaceToken(text, tokenAt(text, 2), "from:sato@example.com"),
    ).toEqual({
      text: "from:sato@example.com 会議",
      caret: 22,
    });
  });

  it("演算子だけを入れたときは空白を足さない", () => {
    expect(replaceToken("fr", tokenAt("fr", 2), "from:")).toEqual({
      text: "from:",
      caret: 5,
    });
  });
});

describe("completeQuery", () => {
  it("値をまだ入れていない演算子を除く", () => {
    expect(completeQuery("会議 from: is:unread after：")).toBe(
      "会議 is:unread",
    );
  });
});

describe("filtersToText", () => {
  it("以前の絞り込み条件を検索欄の書き方にする (終わりの日は翌日の before:)", () => {
    expect(
      filtersToText("見積", {
        ...emptyFilters,
        from: "佐藤 美咲",
        until: "2026-12-31",
        unread: true,
      }),
    ).toBe('見積 from:"佐藤 美咲" before:2027-01-01 is:unread');
  });
});

describe("quoteValue / addSearchHistory", () => {
  it("空白を含む値だけを囲む", () => {
    expect(quoteValue("a b")).toBe('"a b"');
    expect(quoteValue("ab")).toBe("ab");
  });

  it("同じ検索は先頭へ移し、件数を抑える", () => {
    const history = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(addSearchHistory(history, " c  ")).toEqual([
      "c",
      "a",
      "b",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
    expect(addSearchHistory(history, "new")).toHaveLength(8);
  });
});
