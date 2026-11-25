"use client";

import { cn } from "cn";
import { FolderPlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useId } from "react";
import { Hint } from "@/components/hint";
import { ContactInput } from "@/components/mail/contact-suggestions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UnifiedFlag, UnifiedGroup, UnifiedTextField } from "@/lib/api";
import {
  countConditions,
  daysLabel,
  type EditableCondition,
  type EditableGroup,
  type EditableRule,
  FLAG_LABELS,
  MATCH_LABELS,
  MAX_CONDITIONS,
  MAX_GROUP_DEPTH,
  newGroup,
  newRule,
  RECEIVED_DAYS,
  replaceNode,
  TEXT_FIELD_LABELS,
} from "@/lib/unified-conditions";

/**
 * 統合フォルダの条件ビルダー。条件をグループにまとめ、グループごとに
 * 「すべて (AND)」「いずれか (OR)」「どれでもない (NOT)」を選べる。グループは入れ子にできる。
 */

/** 条件の種類 (選ぶ欄の値)。文字の条件は場所ごとに分けて並べる。 */
type Kind = UnifiedTextField | "flag" | "received" | "query";

const KIND_OPTIONS: readonly { value: Kind; label: string }[] = [
  { value: "from", label: TEXT_FIELD_LABELS.from },
  { value: "to", label: TEXT_FIELD_LABELS.to },
  { value: "subject", label: TEXT_FIELD_LABELS.subject },
  { value: "body", label: TEXT_FIELD_LABELS.body },
  { value: "any", label: "件名・差出人・宛先・本文のどこか" },
  { value: "flag", label: "メールの状態" },
  { value: "received", label: "受信日時" },
  { value: "query", label: "検索の書き方で指定" },
];

const ruleKind = (rule: EditableRule): Kind =>
  rule.type === "text" ? rule.field : rule.type;

/** 種類を変えた条件。打ち込んだ文字は、文字の条件どうしなら引き継ぐ。 */
function changeKind(rule: EditableRule, kind: Kind): EditableRule {
  const value = rule.type === "text" || rule.type === "query" ? rule.value : "";
  const base = { key: rule.key, negate: rule.negate };
  if (kind === "flag") return { ...base, type: "flag", flag: "unread" };
  if (kind === "received") return { ...base, type: "received", days: 7 };
  if (kind === "query") return { ...base, type: "query", value };
  return { ...base, type: "text", field: kind, value };
}

/** 「〜でない」を選ぶ欄の言葉。 */
function negateOptions(rule: EditableRule): [string, string] {
  switch (rule.type) {
    case "text":
      return ["を含む", "を含まない"];
    case "flag":
      return ["である", "ではない"];
    case "received":
      return ["以内", "より前"];
    case "query":
      return ["に当てはまる", "に当てはまらない"];
  }
}

const CONNECTOR: Record<UnifiedGroup["match"], string> = {
  all: "かつ",
  any: "または",
  none: "または",
};

type Props = {
  value: EditableGroup;
  onChange: (next: EditableGroup) => void;
};

export function UnifiedConditionBuilder({ value, onChange }: Props) {
  const full = countConditions(value) >= MAX_CONDITIONS;
  const update = (key: string, next: EditableCondition | null) =>
    onChange(replaceNode(value, key, next));
  return (
    <GroupEditor
      group={value}
      depth={1}
      full={full}
      onChange={onChange}
      onReplace={update}
    />
  );
}

function GroupEditor({
  group,
  depth,
  full,
  onChange,
  onReplace,
  onRemove,
}: {
  group: EditableGroup;
  depth: number;
  /** 条件の数が上限に達している (もう足せない)。 */
  full: boolean;
  onChange: (next: EditableGroup) => void;
  onReplace: (key: string, next: EditableCondition | null) => void;
  /** 入れ子のグループなら、グループごと取り除く。 */
  onRemove?: () => void;
}) {
  const nested = depth > 1;
  const add = (node: EditableCondition) =>
    onChange({ ...group, children: [...group.children, node] });
  return (
    <fieldset
      aria-label={nested ? "条件のグループ" : "条件"}
      data-slot="condition-group"
      className={cn(
        "flex min-w-0 flex-col gap-2",
        nested && "rounded-lg border bg-muted/40 p-2.5 max-sm:p-2",
      )}
    >
      <div className="flex min-w-0 items-start gap-2 text-sm">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0">次の条件の</span>
          <Select
            items={(Object.keys(MATCH_LABELS) as UnifiedGroup["match"][]).map(
              (match) => ({ value: match, label: MATCH_LABELS[match] }),
            )}
            value={group.match}
            onValueChange={(match) => {
              if (match) onChange({ ...group, match });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="条件の組み合わせ方"
              className="w-fit"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="w-auto">
              {(Object.keys(MATCH_LABELS) as UnifiedGroup["match"][]).map(
                (match) => (
                  <SelectItem key={match} value={match}>
                    {MATCH_LABELS[match]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <span className="shrink-0">メール</span>
        </div>
        {onRemove && (
          <Hint label="グループを削除">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="グループを削除"
              onClick={onRemove}
              className="shrink-0"
            >
              <XIcon />
            </Button>
          </Hint>
        )}
      </div>

      {group.children.length === 0 && (
        <p className="text-muted-foreground text-xs">
          条件がありません。対象のフォルダのメールがすべて表示されます。
        </p>
      )}
      <ul className="flex min-w-0 flex-col gap-1.5">
        {group.children.map((child, index) => (
          <li key={child.key} className="flex min-w-0 flex-col gap-1.5">
            {index > 0 && (
              <span
                aria-hidden="true"
                className="pl-1 text-muted-foreground text-xs"
              >
                {CONNECTOR[group.match]}
              </span>
            )}
            {child.type === "group" ? (
              <GroupEditor
                group={child}
                depth={depth + 1}
                full={full}
                onChange={(next) => onReplace(child.key, next)}
                onReplace={onReplace}
                onRemove={() => onReplace(child.key, null)}
              />
            ) : (
              <RuleEditor
                rule={child}
                onChange={(next) => onReplace(child.key, next)}
                onRemove={() => onReplace(child.key, null)}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={full}
          onClick={() => add(newRule())}
        >
          <PlusIcon />
          条件を追加
        </Button>
        {depth < MAX_GROUP_DEPTH && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={full}
            onClick={() => add(newGroup())}
          >
            <FolderPlusIcon />
            グループを追加
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function RuleEditor({
  rule,
  onChange,
  onRemove,
}: {
  rule: EditableRule;
  onChange: (next: EditableRule) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [positive, negative] = negateOptions(rule);
  const kind = ruleKind(rule);
  const negateSelect = (
    <Select
      items={[
        { value: "no", label: positive },
        { value: "yes", label: negative },
      ]}
      value={rule.negate ? "yes" : "no"}
      onValueChange={(next) => onChange({ ...rule, negate: next === "yes" })}
    >
      <SelectTrigger size="sm" aria-label="当てはまり方" className="w-fit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" className="w-auto">
        <SelectItem value="no">{positive}</SelectItem>
        <SelectItem value="yes">{negative}</SelectItem>
      </SelectContent>
    </Select>
  );

  let valueField: React.ReactNode = null;
  if (rule.type === "text" && (rule.field === "from" || rule.field === "to")) {
    valueField = (
      <ContactInput
        id={`${id}-value`}
        aria-label={`${TEXT_FIELD_LABELS[rule.field]}に含む文字`}
        value={rule.value}
        maxLength={200}
        placeholder="名前またはアドレス"
        onValueChange={(value) => onChange({ ...rule, value })}
        className="h-8"
      />
    );
  } else if (rule.type === "text" || rule.type === "query") {
    valueField = (
      <Input
        id={`${id}-value`}
        aria-label={
          rule.type === "query"
            ? "検索の書き方"
            : `${TEXT_FIELD_LABELS[rule.field]}に含む文字`
        }
        value={rule.value}
        maxLength={200}
        autoComplete="off"
        placeholder={
          rule.type === "query" ? "例: from:github OR 請求書" : undefined
        }
        onChange={(event) => onChange({ ...rule, value: event.target.value })}
        className="h-8"
      />
    );
  } else if (rule.type === "flag") {
    valueField = (
      <Select
        items={(Object.keys(FLAG_LABELS) as UnifiedFlag[]).map((flag) => ({
          value: flag,
          label: FLAG_LABELS[flag],
        }))}
        value={rule.flag}
        onValueChange={(flag) => {
          if (flag) onChange({ ...rule, flag });
        }}
      >
        <SelectTrigger size="sm" aria-label="状態" className="w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" className="w-auto">
          {(Object.keys(FLAG_LABELS) as UnifiedFlag[]).map((flag) => (
            <SelectItem key={flag} value={flag}>
              {FLAG_LABELS[flag]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (rule.type === "received") {
    const options = RECEIVED_DAYS.some((item) => item.days === rule.days)
      ? RECEIVED_DAYS
      : [...RECEIVED_DAYS, { days: rule.days, label: daysLabel(rule.days) }];
    valueField = (
      <Select
        items={options.map(({ days, label }) => ({
          value: String(days),
          label,
        }))}
        value={String(rule.days)}
        onValueChange={(next) => {
          if (next) onChange({ ...rule, days: Number(next) });
        }}
      >
        <SelectTrigger size="sm" aria-label="期間" className="w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" className="w-auto">
          {options.map(({ days, label }) => (
            <SelectItem key={days} value={String(days)}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  /** 文字を打つ欄は、狭い画面では次の行に広げる。 */
  const wide = rule.type === "text" || rule.type === "query";
  return (
    <div
      data-slot="condition-rule"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      <Select
        items={KIND_OPTIONS}
        value={kind}
        onValueChange={(next) => {
          if (next && next !== kind) onChange(changeKind(rule, next));
        }}
      >
        <SelectTrigger size="sm" aria-label="条件の種類" className="w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" className="w-auto">
          {KIND_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {wide ? (
        <>
          <div className="min-w-40 flex-1 max-sm:order-last max-sm:basis-full">
            {valueField}
          </div>
          {negateSelect}
        </>
      ) : (
        <>
          {valueField}
          {negateSelect}
        </>
      )}
      <Hint label="条件を削除">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="条件を削除"
          onClick={onRemove}
          className="ml-auto"
        >
          <XIcon />
        </Button>
      </Hint>
    </div>
  );
}
