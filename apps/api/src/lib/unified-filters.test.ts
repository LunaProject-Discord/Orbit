import type { UnifiedCondition, UnifiedFilters } from "@orbit/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  conditionSql,
  filterConditions,
  fromLegacyFilters,
  MAX_GROUP_DEPTH,
  readFilters,
  unifiedFilters,
} from "./unified-filters.js";

const dialect = new PgDialect();
const render = (node: UnifiedCondition) => {
  const condition = conditionSql(node);
  return condition ? dialect.sqlToQuery(condition) : undefined;
};

const tree = (children: UnifiedCondition[]): UnifiedFilters => ({
  version: 2,
  root: { type: "group", match: "all", children },
});

describe("統合フォルダの条件", () => {
  it("以前の形 (すべて AND) を、同じ意味の木にする", () => {
    expect(
      fromLegacyFilters({
        unread: true,
        flagged: false,
        hasAttachment: true,
        from: " github ",
        to: "",
        subject: "",
        text: "請求書 -下書き",
        withinDays: 30,
      }),
    ).toEqual(
      tree([
        { type: "flag", flag: "unread", negate: false },
        { type: "flag", flag: "hasAttachment", negate: false },
        { type: "text", field: "from", value: "github", negate: false },
        { type: "query", value: "請求書 -下書き", negate: false },
        { type: "received", days: 30, negate: false },
      ]),
    );
  });

  it("古い端末から以前の形で届いても、新しい形で受け付ける", () => {
    const parsed = unifiedFilters.parse({
      unread: false,
      flagged: true,
      hasAttachment: false,
      from: "",
      to: "",
      subject: "",
      text: "",
      withinDays: null,
    });
    expect(parsed).toEqual(
      tree([{ type: "flag", flag: "flagged", negate: false }]),
    );
  });

  it("読めない形の保存データは、条件なしとして扱う", () => {
    expect(readFilters({ foo: 1 })).toEqual(tree([]));
  });

  it("深すぎる入れ子は受け付けない", () => {
    let node: UnifiedCondition = { type: "group", match: "all", children: [] };
    for (let level = 1; level < MAX_GROUP_DEPTH; level += 1) {
      node = { type: "group", match: "any", children: [node] };
    }
    expect(unifiedFilters.safeParse({ version: 2, root: node }).success).toBe(
      true,
    );
    const deeper = { type: "group", match: "all", children: [node] };
    expect(unifiedFilters.safeParse({ version: 2, root: deeper }).success).toBe(
      false,
    );
  });

  it("知らない種類の条件は受け付けない", () => {
    expect(
      unifiedFilters.safeParse(
        tree([{ type: "size", negate: false } as unknown as UnifiedCondition]),
      ).success,
    ).toBe(false);
  });

  it("空の条件や空のグループは無いものとして扱う", () => {
    expect(
      filterConditions(
        tree([
          { type: "text", field: "subject", value: "  ", negate: false },
          { type: "group", match: "any", children: [] },
        ]),
      ),
    ).toEqual([]);
  });

  it("OR は or、どれにも当てはまらないは not (... or ...) にする", () => {
    const any = render({
      type: "group",
      match: "any",
      children: [
        { type: "flag", flag: "unread", negate: false },
        { type: "flag", flag: "flagged", negate: false },
      ],
    });
    expect(any?.sql).toMatch(/ or /);
    expect(any?.sql).not.toMatch(/^not/);
    const none = render({
      type: "group",
      match: "none",
      children: [
        { type: "text", field: "from", value: "a", negate: false },
        { type: "text", field: "from", value: "b", negate: false },
      ],
    });
    expect(none?.sql).toMatch(/^not coalesce\(\(.* or .*\), false\)$/);
    expect(none?.params).toEqual(["%a%", "%b%"]);
  });

  it("含まないは、列が空でも当てはまるよう coalesce してから否定する", () => {
    const query = render({
      type: "text",
      field: "subject",
      value: "50%",
      negate: true,
    });
    expect(query?.sql).toMatch(/^not coalesce\(/);
    expect(query?.params).toEqual(["%50\\%%"]);
  });
});
