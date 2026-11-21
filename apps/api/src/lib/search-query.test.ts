import { describe, expect, it } from "vitest";
import {
  highlightTerms,
  isEmptySearch,
  likePattern,
  MAX_SEARCH_TERMS,
  normalizeDate,
  parseSearchQuery,
} from "./search-query.js";

describe("parseSearchQuery", () => {
  it("空白 (全角を含む) で区切った語を、すべて含む条件にする", () => {
    expect(parseSearchQuery("定例　ミーティング 日程").terms).toEqual([
      { field: "any", text: "定例", negated: false },
      { field: "any", text: "ミーティング", negated: false },
      { field: "any", text: "日程", negated: false },
    ]);
  });

  it("引用符で囲んだ語句は、空白を含めて 1 つの語にする", () => {
    expect(parseSearchQuery('"Always Free" 利用状況').terms).toEqual([
      { field: "any", text: "Always Free", negated: false },
      { field: "any", text: "利用状況", negated: false },
    ]);
  });

  it("from: などで探す場所を限定する", () => {
    expect(
      parseSearchQuery(
        'from:佐藤 to:aoi@example.com cc:tanaka subject:"経費 精算" body:締め切り',
      ).terms,
    ).toEqual([
      { field: "from", text: "佐藤", negated: false },
      { field: "to", text: "aoi@example.com", negated: false },
      { field: "to", text: "tanaka", negated: false },
      { field: "subject", text: "経費 精算", negated: false },
      { field: "body", text: "締め切り", negated: false },
    ]);
  });

  it("先頭の - で、含まない条件にする", () => {
    expect(parseSearchQuery("請求書 -from:github -下書き").terms).toEqual([
      { field: "any", text: "請求書", negated: false },
      { field: "from", text: "github", negated: true },
      { field: "any", text: "下書き", negated: true },
    ]);
  });

  it("状態と期間の条件を読み取る", () => {
    expect(
      parseSearchQuery(
        "has:attachment is:unread is:starred after:2026/11/1 before:2026-12-01",
      ),
    ).toEqual({
      terms: [],
      hasAttachment: true,
      seen: false,
      flagged: true,
      since: "2026-11-01",
      before: "2026-12-01",
    });
    expect(parseSearchQuery("is:read -has:attachment")).toEqual({
      terms: [],
      seen: true,
      hasAttachment: false,
    });
  });

  it("演算子として解釈できないものは、そのまま語として探す", () => {
    expect(
      parseSearchQuery("Re: https://example.com/a after:来週 is:big").terms,
    ).toEqual([
      { field: "any", text: "Re:", negated: false },
      { field: "any", text: "https://example.com/a", negated: false },
      { field: "any", text: "after:来週", negated: false },
      { field: "any", text: "is:big", negated: false },
    ]);
  });

  it("語の数には上限がある", () => {
    const many = Array.from({ length: 50 }, (_, index) => `w${index}`);
    expect(parseSearchQuery(many.join(" ")).terms).toHaveLength(
      MAX_SEARCH_TERMS,
    );
  });

  it("条件が無ければ空の検索として扱う", () => {
    expect(isEmptySearch(parseSearchQuery('  "" '))).toBe(true);
    expect(isEmptySearch(parseSearchQuery("is:unread"))).toBe(false);
    expect(isEmptySearch(parseSearchQuery("a"))).toBe(false);
  });
});

describe("normalizeDate", () => {
  it("日付を YYYY-MM-DD にそろえる", () => {
    expect(normalizeDate("2026/1/5")).toBe("2026-01-05");
    expect(normalizeDate("2026-11-21")).toBe("2026-11-21");
  });

  it("存在しない日付は受け付けない", () => {
    expect(normalizeDate("2026-02-30")).toBeNull();
    expect(normalizeDate("11/21")).toBeNull();
    expect(normalizeDate("abc")).toBeNull();
  });
});

describe("likePattern", () => {
  it("% や _ を、そのままの文字として探す", () => {
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });
});

describe("highlightTerms", () => {
  it("件名や本文に現れる語だけを返す", () => {
    expect(
      highlightTerms(
        parseSearchQuery("日程 日程 subject:定例 from:佐藤 -不要 body:議題"),
      ),
    ).toEqual(["日程", "定例", "議題"]);
  });
});
