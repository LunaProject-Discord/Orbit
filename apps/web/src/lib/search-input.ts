import type { SearchFilters } from "@/lib/api";

/**
 * 検索欄の入力の扱い (候補を出すための、入力中の語の切り出しと置き換え)。
 * 書き方の解釈そのものはサーバー (apps/api/src/lib/search-query.ts) が行う。
 */

/** 候補に出す演算子。key は入力する文字 (コロンの前)。 */
export type SearchOperator = {
  key: "from" | "to" | "subject" | "body" | "has" | "is" | "after" | "before";
  /** 何を指定するか (候補の行に出す)。 */
  label: string;
  /** 入力例 (候補の行の右に出す)。 */
  example: string;
};

export const SEARCH_OPERATORS: readonly SearchOperator[] = [
  { key: "from", label: "差出人", example: "名前やアドレス" },
  { key: "to", label: "宛先 (Cc を含む)", example: "名前やアドレス" },
  { key: "subject", label: "件名", example: "語句" },
  { key: "body", label: "本文", example: "語句" },
  { key: "has", label: "添付ファイルあり", example: "attachment" },
  { key: "is", label: "未読・既読・スター付き", example: "unread" },
  { key: "after", label: "この日以降", example: "2026-11-01" },
  { key: "before", label: "この日より前", example: "2026-12-01" },
];

/** 演算子の値として選べるもの (has: と is:)。 */
export const OPERATOR_VALUES: Partial<
  Record<SearchOperator["key"], readonly { value: string; label: string }[]>
> = {
  has: [{ value: "attachment", label: "添付ファイルあり" }],
  is: [
    { value: "unread", label: "未読" },
    { value: "read", label: "既読" },
    { value: "starred", label: "スター付き" },
  ],
};

/** 相手のアドレスを候補に出す演算子。 */
export const ADDRESS_OPERATORS = ["from", "to", "cc"] as const;
/** 日付を指定する演算子。 */
export const DATE_OPERATORS = ["after", "before", "since", "until"] as const;

/** カーソルの位置にある語。 */
export type InputToken = {
  /** 入力の中での位置 (start は含み、end は含まない)。 */
  start: number;
  end: number;
  /** 先頭に - が付いている (その語を含まないメールを探す)。 */
  negated: boolean;
  /** コロンの前 (小文字)。演算子が無ければ空文字。 */
  key: string;
  /** コロンの後 (演算子が無ければ語の全体)。囲みの " は除く。 */
  value: string;
};

/** text の中で、caret の位置を含む語を切り出す。空白の上なら長さ 0 の語を返す。 */
export function tokenAt(text: string, caret: number): InputToken {
  // 空白で区切る。"..." の中の空白は区切りにしない (サーバーと同じ)。
  let start = 0;
  let inQuotes = false;
  const ranges: [number, number][] = [];
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "“" || char === "”") inQuotes = !inQuotes;
    const boundary =
      index === text.length || (!inQuotes && /\s/u.test(char ?? ""));
    if (boundary) {
      ranges.push([start, index]);
      start = index + 1;
    }
  }
  const range = ranges.find(([from, to]) => caret >= from && caret <= to) ?? [
    caret,
    caret,
  ];
  const [from, to] = range;
  let raw = text.slice(from, to);
  let negated = false;
  if (raw.startsWith("-")) {
    negated = true;
    raw = raw.slice(1);
  }
  const colon = raw.search(/[:：]/u);
  const key = colon > 0 ? raw.slice(0, colon).toLowerCase() : "";
  const value = (colon > 0 ? raw.slice(colon + 1) : raw).replace(/["“”]/gu, "");
  return { start: from, end: to, negated, key, value };
}

/** 値に空白が含まれるなら " で囲む。 */
export function quoteValue(value: string): string {
  return /\s/u.test(value) ? `"${value.replace(/["“”]/gu, "")}"` : value;
}

/**
 * 語を置き換える。後ろに空白を 1 つ足し (続けて入力できるように)、カーソルはその後に置く。
 * replacement が ":" で終わる (演算子だけを入れた) ときは、空白を足さずに値の入力を待つ。
 */
export function replaceToken(
  text: string,
  token: Pick<InputToken, "start" | "end">,
  replacement: string,
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end).replace(/^\s+/u, "");
  const spacer = replacement.endsWith(":") ? "" : " ";
  const next = `${before}${replacement}${spacer}${after}`;
  return {
    text: next,
    caret: before.length + replacement.length + spacer.length,
  };
}

const INCOMPLETE_OPERATOR =
  /^-?(from|to|cc|subject|body|has|is|after|since|before|until)[:：]$/iu;

/**
 * 入力の途中の、値をまだ入れていない演算子 (「from:」だけなど) を除いた検索の語。
 * そのままサーバーへ送ると「from:」という語を探してしまう。
 */
export function completeQuery(text: string): string {
  return text
    .trim()
    .split(/\s+/u)
    .filter((part) => !INCOMPLETE_OPERATOR.test(part))
    .join(" ");
}

/** 入力の語の数 (最近の検索に残すかどうかの判断に使う)。 */
export function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** YYYY-MM-DD の翌日。 */
function nextDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(
    Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1),
  );
  return next.toISOString().slice(0, 10);
}

/**
 * 以前の検索画面の絞り込み条件 (差出人の欄など) を、検索欄の書き方にする。
 * 期間の終わりはその日を含んでいたので、before: には翌日を入れる。
 */
export function filtersToText(text: string, filters: SearchFilters): string {
  const parts: string[] = [];
  if (text.trim() !== "") parts.push(text.trim());
  if (filters.from.trim())
    parts.push(`from:${quoteValue(filters.from.trim())}`);
  if (filters.to.trim()) parts.push(`to:${quoteValue(filters.to.trim())}`);
  if (filters.subject.trim()) {
    parts.push(`subject:${quoteValue(filters.subject.trim())}`);
  }
  if (filters.since) parts.push(`after:${filters.since}`);
  if (filters.until) parts.push(`before:${nextDay(filters.until)}`);
  if (filters.hasAttachment) parts.push("has:attachment");
  if (filters.unread) parts.push("is:unread");
  if (filters.flagged) parts.push("is:starred");
  return parts.join(" ");
}

const HISTORY_KEY = "mail.search-history.v1";
const HISTORY_LIMIT = 8;

/** この端末で最近検索した語 (新しい順)。 */
export function readSearchHistory(): string[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(HISTORY_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** 最近の検索に加える (同じものは先頭へ移す)。 */
export function addSearchHistory(history: string[], text: string): string[] {
  const query = normalizeQuery(text);
  if (query === "") return history;
  return [query, ...history.filter((item) => item !== query)].slice(
    0,
    HISTORY_LIMIT,
  );
}

export function writeSearchHistory(history: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 保存できなくても検索はできる。
  }
}
