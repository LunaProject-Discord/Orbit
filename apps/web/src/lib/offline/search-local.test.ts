import { describe, expect, it } from "vitest";
import { matchSearch, parseSearchQuery, type SearchDoc } from "./search-local";

const doc = (overrides: Partial<SearchDoc>): SearchDoc => ({
  subject: "",
  from: [{ address: "someone@example.com" }],
  recipients: [{ address: "me@example.com" }],
  snippet: "",
  body: null,
  receivedAt: "2026-11-01T00:00:00Z",
  hasAttachments: false,
  seen: true,
  flagged: false,
  ...overrides,
});

const matches = (target: SearchDoc, q: string) =>
  matchSearch(target, parseSearchQuery(q)) !== null;

describe("matchSearch (端末内の検索)", () => {
  it("全角と半角・大文字と小文字を区別しない (サーバーの検索と同じ)", () => {
    const target = doc({ subject: "ＡＢＣ商事より", body: "ｱﾏｿﾞﾝで購入" });
    expect(matches(target, "abc")).toBe(true);
    expect(matches(target, "アマゾン")).toBe(true);
  });

  it("本文の途中の改行や名前の空白があっても見つかる", () => {
    const target = doc({
      from: [{ name: "佐藤 美咲", address: "misaki@example.jp" }],
      body: "今月分のご請求\r\n書をお送りします。",
    });
    expect(matches(target, "請求書")).toBe(true);
    expect(matches(target, "from:佐藤美咲")).toBe(true);
    expect(matches(target, "to:佐藤美咲")).toBe(false);
  });

  it("抜粋は、当たった箇所の前後を元の文字のまま返す", () => {
    const target = doc({ body: "今月分のご請求\r\n書をお送りします。" });
    expect(matchSearch(target, parseSearchQuery("請求書"))).toEqual({
      excerpt: "今月分のご請求 書をお送りします。",
    });
  });
});
