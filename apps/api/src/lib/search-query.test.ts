import { describe, expect, it } from "vitest";
import {
  highlightTerms,
  isEmptySearch,
  likePattern,
  MAX_SEARCH_TERMS,
  normalizeDate,
  parseSearchQuery,
  rolesNamed,
  type SearchNode,
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
    ).toMatchObject({
      terms: [],
      hasAttachment: true,
      seen: false,
      flagged: true,
      since: "2026-11-01",
      before: "2026-12-01",
    });
    expect(parseSearchQuery("is:read -has:attachment")).toMatchObject({
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

describe("folder:", () => {
  it("フォルダの名前を小文字で受け取り、in: も同じに扱う", () => {
    expect(
      parseSearchQuery('folder:受信トレイ -in:Trash folder:"仕事 2026"')
        .folders,
    ).toEqual([
      { name: "受信トレイ", negated: false },
      { name: "trash", negated: true },
      { name: "仕事 2026", negated: false },
    ]);
    expect(isEmptySearch(parseSearchQuery("folder:受信トレイ"))).toBe(false);
  });

  it("役割は日本語の名前でも英語でも当てはまる", () => {
    expect(rolesNamed("受信トレイ")).toEqual(["inbox"]);
    expect(rolesNamed("trash")).toEqual(["trash"]);
    expect(rolesNamed("仕事")).toEqual([]);
  });
});

describe("OR とかっこ", () => {
  it("grouping: false (検索欄) では、OR もかっこもただの語として探す", () => {
    expect(
      parseSearchQuery("from:a OR (定例 -(b)", { grouping: false }).nodes,
    ).toEqual([
      { kind: "text", field: "from", text: "a", negated: false },
      { kind: "text", field: "any", text: "OR", negated: false },
      { kind: "text", field: "any", text: "(定例", negated: false },
      { kind: "text", field: "any", text: "(b)", negated: true },
    ]);
  });

  const text = (value: string, negated = false): SearchNode => ({
    kind: "text",
    field: "any",
    text: value,
    negated,
  });

  it("OR は空白より強く結び付く", () => {
    expect(parseSearchQuery("from:a OR from:b 定例").nodes).toEqual([
      {
        kind: "or",
        children: [
          { kind: "text", field: "from", text: "a", negated: false },
          { kind: "text", field: "from", text: "b", negated: false },
        ],
      },
      text("定例"),
    ]);
    expect(parseSearchQuery("a OR b OR is:unread").nodes).toEqual([
      {
        kind: "or",
        children: [text("a"), text("b"), { kind: "seen", value: false }],
      },
    ]);
  });

  it("かっこでまとめ、-( ) は当てはまらないもの", () => {
    expect(parseSearchQuery("(a b) OR c -(d OR folder:ごみ箱)").nodes).toEqual([
      {
        kind: "or",
        children: [
          { kind: "and", children: [text("a"), text("b")] },
          text("c"),
        ],
      },
      {
        kind: "not",
        child: {
          kind: "or",
          children: [
            text("d"),
            { kind: "folder", name: "ごみ箱", negated: false },
          ],
        },
      },
    ]);
  });

  it("小文字の or、引用符の中、余ったかっこ、前後の欠けた OR はただの語", () => {
    expect(parseSearchQuery('a or b "OR" (株) c)').nodes).toEqual([
      text("a"),
      text("or"),
      text("b"),
      text("OR"),
      text("株"),
      text("c)"),
    ]);
    expect(parseSearchQuery("OR a OR").nodes).toEqual([text("OR"), text("a")]);
  });

  it("最上位の条件だけを terms に並べ、目立たせる語は OR の中からも選ぶ", () => {
    const search = parseSearchQuery("定例 (議題 OR subject:日程) -(不要)");
    expect(search.terms).toEqual([
      { field: "any", text: "定例", negated: false },
    ]);
    expect(highlightTerms(search)).toEqual(["定例", "議題", "日程"]);
    expect(isEmptySearch(parseSearchQuery("()"))).toBe(true);
  });
});
