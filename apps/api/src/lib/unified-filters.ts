import {
  messages,
  type UnifiedCondition,
  type UnifiedFilters,
  type UnifiedGroup,
  type UnifiedRule,
} from "@orbit/db";
import { and, eq, not, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { parseSearchQuery } from "./search-query.js";
import { searchCondition, termCondition } from "./search-sql.js";

/**
 * 統合フォルダの条件 (条件ビルダーで組んだ AND / OR / NOT の木)。
 * 保存する形の検査、古い形 (version 1) からの変換、当てはまるメールを探す SQL を用意する。
 */

/** グループを入れ子にできる深さ (いちばん外側のグループを 1 段目と数える)。 */
export const MAX_GROUP_DEPTH = 4;
/** 1 つの統合フォルダに入れられる条件とグループの合計。 */
export const MAX_CONDITIONS = 60;

const text = z.string().max(200);

const rule = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    field: z.enum(["from", "to", "subject", "body", "any"]),
    value: text,
    negate: z.boolean(),
  }),
  z.object({
    type: z.literal("flag"),
    flag: z.enum(["unread", "flagged", "hasAttachment", "answered"]),
    negate: z.boolean(),
  }),
  z.object({
    type: z.literal("received"),
    days: z.number().int().min(1).max(3650),
    negate: z.boolean(),
  }),
  z.object({ type: z.literal("query"), value: text, negate: z.boolean() }),
]);

const group: z.ZodType<UnifiedGroup> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    match: z.enum(["all", "any", "none"]),
    children: z.array(z.union([rule, group])).max(MAX_CONDITIONS),
  }),
);

function depth(node: UnifiedGroup): number {
  let deepest = 0;
  for (const child of node.children) {
    if (child.type === "group") deepest = Math.max(deepest, depth(child));
  }
  return deepest + 1;
}

function count(node: UnifiedCondition): number {
  if (node.type !== "group") return 1;
  return node.children.reduce((total, child) => total + count(child), 1);
}

const tree = z
  .object({ version: z.literal(2), root: group })
  .refine((value) => depth(value.root) <= MAX_GROUP_DEPTH, {
    message: "too_deep",
  })
  .refine((value) => count(value.root) <= MAX_CONDITIONS + 1, {
    message: "too_many_conditions",
  });

/** version 1 の形 (すべて AND)。古い端末から届いたときも受け付ける。 */
const legacy = z.object({
  unread: z.boolean(),
  flagged: z.boolean(),
  hasAttachment: z.boolean(),
  from: text,
  to: text,
  subject: text,
  text,
  withinDays: z.number().int().min(1).max(3650).nullable(),
});
export type LegacyUnifiedFilters = z.infer<typeof legacy>;

/** version 1 の条件を、同じ意味の木 (すべて AND のグループ 1 つ) にする。 */
export function fromLegacyFilters(old: LegacyUnifiedFilters): UnifiedFilters {
  const children: UnifiedCondition[] = [];
  for (const flag of ["unread", "flagged", "hasAttachment"] as const) {
    if (old[flag]) children.push({ type: "flag", flag, negate: false });
  }
  for (const field of ["from", "to", "subject"] as const) {
    const value = old[field].trim();
    if (value !== "") {
      children.push({ type: "text", field, value, negate: false });
    }
  }
  if (old.text.trim() !== "") {
    children.push({ type: "query", value: old.text.trim(), negate: false });
  }
  if (old.withinDays !== null) {
    children.push({ type: "received", days: old.withinDays, negate: false });
  }
  return {
    version: 2,
    root: { type: "group", match: "all", children },
  };
}

/** 保存する条件の形。古い形で届いたら、新しい形に変換する。 */
export const unifiedFilters = z.union([
  tree,
  legacy.transform((old) => fromLegacyFilters(old)),
]);

/**
 * データベースから読んだ条件を、新しい形にする。マイグレーションで変換済みのはずだが、
 * 変換前のバックアップから戻した行などがあっても壊れないようにする。
 */
export function readFilters(value: unknown): UnifiedFilters {
  const parsed = unifiedFilters.safeParse(value);
  return parsed.success ? parsed.data : emptyFilters();
}

export const emptyFilters = (): UnifiedFilters => ({
  version: 2,
  root: { type: "group", match: "all", children: [] },
});

function normalizeNode(node: UnifiedCondition): UnifiedCondition {
  if (node.type === "group") {
    return {
      type: "group",
      match: node.match,
      children: node.children.map(normalizeNode),
    };
  }
  if (node.type === "text" || node.type === "query") {
    return { ...node, value: node.value.trim() };
  }
  return { ...node };
}

/** 文字の前後の空白を落とし、知らないキーを除いて、同じ内容は同じ形で保存する。 */
export function normalizeFilters(filters: UnifiedFilters): UnifiedFilters {
  return { version: 2, root: normalizeNode(filters.root) as UnifiedGroup };
}

/** 検索の書き方 (OR、かっこ、has: / is:、folder: など) で書いた条件。何も無ければ undefined。 */
const queryCondition = (value: string): SQL | undefined =>
  searchCondition(parseSearchQuery(value));

/** null (列が空など) は「当てはまらない」とみなしてから否定する (NOT NULL で消えないように)。 */
const negated = (condition: SQL) => not(sql`coalesce(${condition}, false)`);

function ruleCondition(node: UnifiedRule): SQL | undefined {
  let condition: SQL | undefined;
  switch (node.type) {
    case "text":
      condition =
        node.value.trim() === ""
          ? undefined
          : termCondition({
              field: node.field,
              text: node.value.trim(),
              negated: false,
            });
      break;
    case "flag":
      condition =
        node.flag === "unread"
          ? eq(messages.seen, false)
          : node.flag === "flagged"
            ? eq(messages.flagged, true)
            : node.flag === "answered"
              ? eq(messages.answered, true)
              : eq(messages.hasAttachments, true);
      break;
    case "received":
      condition = sql`${messages.receivedAt} >= now() - make_interval(days => ${node.days}::int)`;
      break;
    case "query":
      condition = queryCondition(node.value);
      break;
  }
  if (condition === undefined) return undefined;
  return node.negate ? negated(condition) : condition;
}

/** 条件 1 つ (グループを含む) を SQL にする。中身の無い条件は undefined。 */
export function conditionSql(node: UnifiedCondition): SQL | undefined {
  if (node.type !== "group") return ruleCondition(node);
  const parts = node.children
    .map(conditionSql)
    .filter((part): part is SQL => part !== undefined);
  if (parts.length === 0) return undefined;
  if (node.match === "all") return and(...parts);
  const any = parts.length === 1 ? parts[0] : or(...parts);
  if (!any) return undefined;
  return node.match === "none" ? negated(any) : any;
}

/**
 * メールが、統合フォルダの条件に当てはまるか。外側の問い合わせの messages を参照する。
 * 条件が無ければ空の配列 (where に展開して使う)。
 */
export function filterConditions(filters: UnifiedFilters): SQL[] {
  const condition = conditionSql(readFilters(filters).root);
  return condition ? [condition] : [];
}
