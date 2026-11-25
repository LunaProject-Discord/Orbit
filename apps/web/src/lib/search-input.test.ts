import { describe, expect, it } from "vitest";
import { emptyFilters } from "@/lib/search";
import {
  addSearchHistory,
  chipLabel,
  completeQuery,
  filtersToText,
  hasOpenSpace,
  inPlaceText,
  joinSearchInput,
  quoteValue,
  removeSearchHistory,
  replaceToken,
  splitChipRaw,
  splitSearchInput,
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

describe("splitSearchInput", () => {
  it("入力し終えた条件はチップに、末尾の条件は入力中にする", () => {
    expect(splitSearchInput("会議 from:sato is:unread 資料 to:ta")).toEqual({
      chips: [
        { raw: "from:sato", key: "from", value: "sato", negated: false },
        { raw: "is:unread", key: "is", value: "unread", negated: false },
      ],
      rest: "会議 資料",
      open: null,
      tail: "",
      editing: { key: "to", negated: false, prefix: "to:", value: "ta" },
    });
  });

  it("コロンを入れた時点で、値が空でも入力中の条件にする", () => {
    expect(splitSearchInput("-from:")).toMatchObject({
      chips: [],
      rest: "",
      editing: { key: "from", negated: true, prefix: "-from:", value: "" },
    });
  });

  it("成立していない条件や知らない演算子は、普通の語のままにする", () => {
    expect(splitSearchInput("is:foo http://a after:x ")).toEqual({
      chips: [],
      rest: "is:foo http://a after:x ",
      open: null,
      tail: "",
      editing: null,
    });
  });

  it("joinSearchInput で元の入力に戻せる", () => {
    for (const text of ["会議 from:sato is:unread to:ta", "from:a ", "a b"]) {
      const parts = splitSearchInput(text);
      expect(splitSearchInput(joinSearchInput(parts))).toEqual(parts);
    }
  });
});

describe("hasOpenSpace / removeSearchHistory / chipLabel", () => {
  it('" の中の空白は区切りとみなさない', () => {
    expect(hasOpenSpace('"佐藤 美咲')).toBe(false);
    expect(hasOpenSpace("sato ")).toBe(true);
  });

  it("最近の検索から 1 件を除く", () => {
    expect(removeSearchHistory(["a", "b"], "a")).toEqual(["b"]);
  });

  it("チップの名前と値", () => {
    expect(
      chipLabel({
        raw: "-is:unread",
        key: "is",
        value: "unread",
        negated: true,
      }),
    ).toEqual({ label: "状態", value: "未読" });
  });
});

describe("inPlaceText", () => {
  const chips = splitSearchInput(
    "from:sato is:unread has:attachment 会議",
  ).chips;
  const others = chips.filter((_, index) => index !== 1);
  const draft = { key: "is", negated: false, prefix: "is:", value: "starred" };

  it("編集中のチップを元の位置に戻す", () => {
    expect(inPlaceText(others, 1, draft, "会議")).toBe(
      "from:sato is:starred has:attachment 会議",
    );
  });

  it("値が空なら条件ごと除く", () => {
    expect(inPlaceText(others, 1, { ...draft, value: " " }, "")).toBe(
      "from:sato has:attachment ",
    );
  });

  it("閉じ忘れた引用符を閉じる", () => {
    expect(
      inPlaceText(
        [],
        0,
        {
          key: "subject",
          negated: false,
          prefix: "subject:",
          value: '"週次 報',
        },
        "",
      ),
    ).toBe('subject:"週次 報" ');
  });

  it("チップを書き方と値に分ける", () => {
    expect(splitChipRaw('-subject:"週次 報告"')).toEqual({
      prefix: "-subject:",
      value: '"週次 報告"',
    });
    expect(splitChipRaw("会議")).toBeNull();
  });
});

describe("OR とかっこ", () => {
  it("OR でつないだ条件とかっこは、まとめて 1 つのグループのチップにする", () => {
    const parts = splitSearchInput(
      "is:unread from:a OR from:b (to:c d) has:attachment ",
    );
    expect(parts.chips.map((chip) => chip.raw)).toEqual([
      "is:unread",
      "from:a OR from:b",
      "(to:c d)",
      "has:attachment",
    ]);
    expect(parts.rest).toBe("");
    expect(parts.chips[1]?.items).toEqual([
      {
        kind: "chip",
        chip: { raw: "from:a", key: "from", value: "a", negated: false },
      },
      { kind: "or" },
      {
        kind: "chip",
        chip: { raw: "from:b", key: "from", value: "b", negated: false },
      },
    ]);
    expect(parts.chips[2]?.items).toEqual([
      { kind: "text", text: "(" },
      {
        kind: "chip",
        chip: { raw: "to:c", key: "to", value: "c", negated: false },
      },
      { kind: "text", text: "d" },
      { kind: "text", text: ")" },
    ]);
    // グループは 1 つの条件なので、並べ直しても意味は変わらない。
    expect(joinSearchInput(parts)).toBe(
      "is:unread from:a OR from:b (to:c d) has:attachment ",
    );
  });

  it("否定のかっこと、語だけの OR もグループにする", () => {
    const parts = splitSearchInput("会議 -(from:a OR b) x OR y ");
    expect(parts.chips.map((chip) => chip.raw)).toEqual([
      "-(from:a OR b)",
      "x OR y",
    ]);
    expect(parts.rest).toBe("会議 ");
  });

  it("OR の後ろで入力している条件は、つないでいる途中のまとまりの後ろで入力中にする", () => {
    const parts = splitSearchInput("is:unread from:a OR from:");
    expect(parts.chips.map((chip) => chip.raw)).toEqual(["is:unread"]);
    expect(parts.open?.raw).toBe("from:a OR");
    expect(parts.open?.items.map((item) => item.kind)).toEqual(["chip", "or"]);
    expect(parts.editing?.key).toBe("from");
    expect(splitSearchInput("(from:a to:").open?.raw).toBe("(from:a");
    expect(splitSearchInput("a from:").editing?.key).toBe("from");
    expect(splitSearchInput("a from:").open).toBeNull();
  });

  it("OR の後ろの語や、閉じていないかっこも途中のまとまりにする", () => {
    expect(splitSearchInput("from:a OR ")).toMatchObject({
      open: { raw: "from:a OR" },
      tail: "",
      editing: null,
    });
    expect(splitSearchInput("from:a OR 会")).toMatchObject({
      open: { raw: "from:a OR" },
      tail: "会",
      editing: null,
    });
    expect(splitSearchInput("(to:c ")).toMatchObject({
      open: { raw: "(to:c" },
      tail: "",
    });
  });

  it("途中のまとまりも joinSearchInput で元の入力に戻せる", () => {
    for (const text of [
      "is:unread from:a OR from:",
      "x from:a OR 会",
      "(to:c d ",
      "from:a OR ",
      "(b OR c) a d",
    ]) {
      expect(joinSearchInput(splitSearchInput(text))).toBe(text);
    }
  });
});
