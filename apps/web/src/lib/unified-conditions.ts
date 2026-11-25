import type {
  UnifiedCondition,
  UnifiedFilters,
  UnifiedFlag,
  UnifiedGroup,
  UnifiedRule,
  UnifiedTextField,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";

/**
 * 統合フォルダの条件 (条件ビルダーで組む AND / OR / NOT の木) の扱い。
 * サーバーの apps/api/src/lib/unified-filters.ts と同じ形・同じ上限にそろえる。
 */

/** グループを入れ子にできる深さ (いちばん外側のグループを 1 段目と数える)。 */
export const MAX_GROUP_DEPTH = 4;
/** 1 つの統合フォルダに入れられる条件とグループの合計 (いちばん外側を除く)。 */
export const MAX_CONDITIONS = 60;

export const emptyUnifiedFilters: UnifiedFilters = {
  version: 2,
  root: { type: "group", match: "all", children: [] },
};

export const TEXT_FIELD_LABELS: Record<UnifiedTextField, string> = {
  from: "差出人",
  to: "宛先 (To / Cc)",
  subject: "件名",
  body: "本文",
  any: "件名・差出人・宛先・本文",
};

export const FLAG_LABELS: Record<UnifiedFlag, string> = {
  unread: "未読",
  flagged: "スター付き",
  hasAttachment: "添付ファイルあり",
  answered: "返信済み",
};

/** 受信日時の条件で選べる日数。 */
export const RECEIVED_DAYS: readonly { days: number; label: string }[] = [
  { days: 1, label: "24 時間" },
  { days: 7, label: "7 日" },
  { days: 30, label: "30 日" },
  { days: 90, label: "90 日" },
  { days: 365, label: "1 年" },
];

export const daysLabel = (days: number) =>
  RECEIVED_DAYS.find((item) => item.days === days)?.label ?? `${days} 日`;

export const MATCH_LABELS: Record<UnifiedGroup["match"], string> = {
  all: "すべてに当てはまる",
  any: "いずれかに当てはまる",
  none: "どれにも当てはまらない",
};

type LegacyFilters = {
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  from: string;
  to: string;
  subject: string;
  text: string;
  withinDays: number | null;
};

/** 以前の形 (未読のみ・差出人などをすべて AND) を、同じ意味の木にする。 */
function fromLegacy(old: Partial<LegacyFilters>): UnifiedFilters {
  const children: UnifiedCondition[] = [];
  for (const flag of ["unread", "flagged", "hasAttachment"] as const) {
    if (old[flag] === true)
      children.push({ type: "flag", flag, negate: false });
  }
  for (const field of ["from", "to", "subject"] as const) {
    const value = (old[field] ?? "").trim();
    if (value) children.push({ type: "text", field, value, negate: false });
  }
  const text = (old.text ?? "").trim();
  if (text) children.push({ type: "query", value: text, negate: false });
  if (typeof old.withinDays === "number") {
    children.push({ type: "received", days: old.withinDays, negate: false });
  }
  return { version: 2, root: { type: "group", match: "all", children } };
}

/**
 * 保存されていた条件を、いまの形にする。端末に残っている以前の版の内容
 * (未読のみ・差出人などの形) を読んだときも、同じ意味の木にして使う。
 */
export function toUnifiedFilters(value: unknown): UnifiedFilters {
  if (
    value &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === 2 &&
    (value as { root?: { type?: unknown } }).root?.type === "group"
  ) {
    return value as UnifiedFilters;
  }
  if (value && typeof value === "object" && "unread" in value) {
    return fromLegacy(value as Partial<LegacyFilters>);
  }
  return emptyUnifiedFilters;
}

/** 条件の中身があるか (文字が空の条件や、空のグループは無いものとみなす)。 */
export function isEffective(node: UnifiedCondition): boolean {
  if (node.type === "group") return node.children.some(isEffective);
  if (node.type === "text" || node.type === "query") {
    return node.value.trim() !== "";
  }
  return true;
}

/** 条件を 1 つでも指定しているか。 */
export function hasFilters(filters: UnifiedFilters): boolean {
  return isEffective(filters.root);
}

/** いちばん外側を除いた、条件とグループの数。 */
type Countable = { type: string; children?: readonly Countable[] };
export function countConditions(group: {
  children: readonly Countable[];
}): number {
  return group.children.reduce(
    (total, child) =>
      total +
      1 +
      (child.children ? countConditions({ children: child.children }) : 0),
    0,
  );
}

function describeRule(rule: UnifiedRule): string {
  switch (rule.type) {
    case "text": {
      const value = `「${rule.value.trim()}」`;
      const verb = rule.negate ? "を含まない" : "を含む";
      return rule.field === "any"
        ? `${value}${verb}`
        : `${TEXT_FIELD_LABELS[rule.field].replace(/ \(.*\)$/, "")}に${value}${verb}`;
    }
    case "flag": {
      const negative: Record<UnifiedFlag, string> = {
        unread: "既読",
        flagged: "スターなし",
        hasAttachment: "添付ファイルなし",
        answered: "未返信",
      };
      return rule.negate ? negative[rule.flag] : FLAG_LABELS[rule.flag];
    }
    case "received":
      return `受信が${daysLabel(rule.days)}${rule.negate ? "より前" : "以内"}`;
    case "query":
      return `検索「${rule.value.trim()}」${rule.negate ? "に当てはまらない" : ""}`;
  }
}

function describeGroup(group: UnifiedGroup, nested: boolean): string {
  const parts = group.children
    .filter(isEffective)
    .map((child) =>
      child.type === "group" ? describeGroup(child, true) : describeRule(child),
    );
  if (parts.length === 0) return "";
  if (group.match === "none") {
    return `除外 (${parts.join(" または ")})`;
  }
  const text =
    group.match === "any"
      ? parts.join(" または ")
      : parts.join(nested ? " かつ " : "、");
  return nested && parts.length > 1 ? `(${text})` : text;
}

/** 条件を短い文にする。条件が無ければ空文字。 */
export function describeFilters(filters: UnifiedFilters): string {
  return describeGroup(filters.root, false);
}

// ---------------------------------------------------------------------------
// 編集中の木。入力欄が作り直されないよう、条件ごとに画面用の ID を付けて持つ。
// ---------------------------------------------------------------------------

export type EditableRule = UnifiedRule & { key: string };
export type EditableGroup = {
  type: "group";
  key: string;
  match: UnifiedGroup["match"];
  children: EditableCondition[];
};
export type EditableCondition = EditableRule | EditableGroup;

export function toEditable(node: UnifiedGroup): EditableGroup;
export function toEditable(node: UnifiedCondition): EditableCondition;
export function toEditable(node: UnifiedCondition): EditableCondition {
  const key = randomUuid();
  if (node.type === "group") {
    return {
      type: "group",
      key,
      match: node.match,
      children: node.children.map((child) => toEditable(child)),
    };
  }
  return { ...node, key };
}

export function fromEditable(node: EditableGroup): UnifiedGroup;
export function fromEditable(node: EditableCondition): UnifiedCondition;
export function fromEditable(node: EditableCondition): UnifiedCondition {
  if (node.type === "group") {
    return {
      type: "group",
      match: node.match,
      children: node.children.map((child) => fromEditable(child)),
    };
  }
  const { key: _key, ...rule } = node;
  return rule;
}

/** 新しく足す条件 (差出人に〜を含む)。 */
export const newRule = (): EditableRule => ({
  key: randomUuid(),
  type: "text",
  field: "from",
  value: "",
  negate: false,
});

/** 新しく足すグループ (いずれかに当てはまる、条件 1 つ入り)。 */
export const newGroup = (): EditableGroup => ({
  type: "group",
  key: randomUuid(),
  match: "any",
  children: [newRule()],
});

/** 木の中の key の条件を置き換える (null なら取り除く)。 */
export function replaceNode(
  group: EditableGroup,
  key: string,
  next: EditableCondition | null,
): EditableGroup {
  const children: EditableCondition[] = [];
  for (const child of group.children) {
    if (child.key === key) {
      if (next) children.push(next);
    } else if (child.type === "group") {
      children.push(replaceNode(child, key, next));
    } else {
      children.push(child);
    }
  }
  return { ...group, children };
}
