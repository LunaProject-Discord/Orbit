import { describe, expect, it } from "vitest";
import type { UnifiedFilters } from "@/lib/api";
import {
  countConditions,
  describeFilters,
  fromEditable,
  hasFilters,
  newGroup,
  newRule,
  replaceNode,
  toEditable,
  toUnifiedFilters,
} from "@/lib/unified-conditions";

const filters: UnifiedFilters = {
  version: 2,
  root: {
    type: "group",
    match: "all",
    children: [
      { type: "flag", flag: "unread", negate: false },
      {
        type: "group",
        match: "any",
        children: [
          { type: "text", field: "from", value: "github", negate: false },
          { type: "text", field: "subject", value: "請求書", negate: false },
        ],
      },
      {
        type: "group",
        match: "none",
        children: [
          { type: "text", field: "any", value: "広告", negate: false },
        ],
      },
      { type: "received", days: 30, negate: true },
    ],
  },
};

describe("統合フォルダの条件", () => {
  it("AND / OR / NOT の組み合わせを短い文にする", () => {
    expect(describeFilters(filters)).toBe(
      "未読、(差出人に「github」を含む または 件名に「請求書」を含む)、除外 (「広告」を含む)、受信が30 日より前",
    );
  });

  it("以前の版の形を、同じ意味の木として読む", () => {
    expect(
      toUnifiedFilters({
        unread: false,
        flagged: true,
        hasAttachment: false,
        from: "",
        to: " a@example.com ",
        subject: "",
        text: "",
        withinDays: null,
      }),
    ).toEqual({
      version: 2,
      root: {
        type: "group",
        match: "all",
        children: [
          { type: "flag", flag: "flagged", negate: false },
          { type: "text", field: "to", value: "a@example.com", negate: false },
        ],
      },
    });
  });

  it("空の条件や空のグループだけなら、条件なしとみなす", () => {
    expect(
      hasFilters({
        version: 2,
        root: {
          type: "group",
          match: "all",
          children: [
            { type: "group", match: "any", children: [] },
            { type: "query", value: " ", negate: false },
          ],
        },
      }),
    ).toBe(false);
    expect(hasFilters(filters)).toBe(true);
  });

  it("編集用の ID を付けて外すと、元の木に戻る", () => {
    expect(fromEditable(toEditable(filters.root))).toEqual(filters.root);
  });

  it("入れ子の中の条件を置き換え・削除できる", () => {
    const rule = newRule();
    if (rule.type !== "text") throw new Error("expected text rule");
    const group = { ...newGroup(), children: [rule] };
    const root = toEditable(filters.root);
    const added = { ...root, children: [...root.children, group] };
    expect(countConditions(added)).toBe(countConditions(root) + 2);
    const changed = replaceNode(added, rule.key, { ...rule, value: "x" });
    expect(changed.children.at(-1)).toMatchObject({
      children: [{ value: "x" }],
    });
    const removed = replaceNode(changed, group.key, null);
    expect(fromEditable(removed)).toEqual(filters.root);
  });
});
