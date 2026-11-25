import type { SearchFilters } from "@/lib/api";

/**
 * 検索欄の入力の扱い (候補を出すための、入力中の語の切り出しと置き換え)。
 * 書き方の解釈そのものはサーバー (apps/api/src/lib/search-query.ts) が行う。
 */

/** 候補に出す演算子。key は入力する文字 (コロンの前)。 */
export type SearchOperator = {
  key:
    | "from"
    | "to"
    | "subject"
    | "body"
    | "folder"
    | "has"
    | "is"
    | "after"
    | "before";
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
  { key: "folder", label: "フォルダ", example: "受信トレイ" },
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

/** フォルダの名前を候補に出す演算子 (in: は Gmail と同じ書き方)。 */
export const FOLDER_OPERATORS = ["folder", "in"] as const;
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
  const [from, to] = tokenRanges(text).find(
    ([start, end]) => caret >= start && caret <= end,
  ) ?? [caret, caret];
  return parseToken(text, from, to);
}

/** 空白で区切った語の位置。"..." の中の空白は区切りにしない (サーバーと同じ)。 */
function tokenRanges(text: string): [number, number][] {
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
  return ranges;
}

function parseToken(text: string, from: number, to: number): InputToken {
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

/** OR やかっこでまとめた条件の中身 (グループのチップの中に、入力の順に並べて出す)。 */
export type GroupItem =
  | { kind: "chip"; chip: SearchChip }
  | { kind: "or" }
  /** 条件以外の語と、かっこ (「(」「-(」「)」)。 */
  | { kind: "text"; text: string };

/** 検索欄の中で、まとまった要素 (チップ) として出す、成立した条件。 */
export type SearchChip = {
  /** 入力の書き方そのまま (「from:sato@example.com」など)。 */
  raw: string;
  key: string;
  value: string;
  negated: boolean;
  /**
   * OR やかっこでまとめたグループなら、その中身 (key と value は空)。グループはまとめて 1 つの条件
   * (ほかの条件とは「かつ」) なので、ほかのチップと同じく先頭へ並べ直しても意味は変わらない。
   */
  items?: GroupItem[];
};

const TEXT_KEYS = ["from", "to", "cc", "subject", "body", "folder", "in"];
const HAS_VALUES = /^(attachment|attachments|添付)$/iu;
const IS_VALUES = /^(unread|read|starred|flagged|未読|既読|スター)$/iu;
const DATE_VALUE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/u;

/** 演算子として成立している (サーバーが条件として扱う) か。 */
function isCompleteOperator(token: InputToken): boolean {
  if (token.value === "") return false;
  if (TEXT_KEYS.includes(token.key)) return true;
  if (token.key === "has") return HAS_VALUES.test(token.value);
  if (token.key === "is") return IS_VALUES.test(token.value);
  if ((DATE_OPERATORS as readonly string[]).includes(token.key)) {
    // 日付の除外 (-after:) はサーバーが条件として扱わないので、チップにしない。
    return !token.negated && DATE_VALUE.test(token.value);
  }
  return false;
}

type Word = { from: number; to: number; word: string };

/** 語の頭の「(」「-(」の数から、語の終わりの「)」の数を引いたもの。 */
function parenDelta(word: string): number {
  const opens = /^-?(\(+)/u.exec(word)?.[1]?.length ?? 0;
  const closes = /(\)+)$/u.exec(word)?.[1]?.length ?? 0;
  return opens - closes;
}

/**
 * 入力を、ひとまとまりの条件 (単位) に分ける。ふつうは語 1 つが 1 つの単位で、OR でつないだ語と、
 * かっこの中の語はまとめて 1 つの単位にする (サーバーの解釈と同じく、OR は空白より強く結び付く)。
 * depth は、閉じていないかっこの数。
 */
function splitUnits(
  text: string,
): { from: number; to: number; words: Word[]; depth: number }[] {
  const words = tokenRanges(text)
    .filter(([from, to]) => from < to)
    .map(([from, to]) => ({ from, to, word: text.slice(from, to) }));
  const units: { from: number; to: number; words: Word[]; depth: number }[] =
    [];
  let index = 0;
  while (index < words.length) {
    let end = index;
    let depth = Math.max(0, parenDelta(words[index]?.word ?? ""));
    for (;;) {
      if (depth > 0 && end + 1 < words.length) {
        end += 1;
        depth = Math.max(0, depth + parenDelta(words[end]?.word ?? ""));
        continue;
      }
      if (words[end + 1]?.word === "OR" && words[end]?.word !== "OR") {
        end += 1;
        if (end + 1 < words.length) {
          end += 1;
          depth = Math.max(0, depth + parenDelta(words[end]?.word ?? ""));
          continue;
        }
      }
      break;
    }
    const unit = words.slice(index, end + 1);
    units.push({
      from: unit[0]?.from ?? 0,
      to: unit[unit.length - 1]?.to ?? 0,
      words: unit,
      depth,
    });
    index = end + 1;
  }
  return units;
}

/** まとまりの中の語を、グループのチップの中身にする。 */
function groupItems(text: string, words: readonly Word[]): GroupItem[] {
  const items: GroupItem[] = [];
  for (const { from, to, word } of words) {
    if (word === "OR") {
      items.push({ kind: "or" });
      continue;
    }
    const open = /^-?\(+/u.exec(word)?.[0] ?? "";
    const close = /\)+$/u.exec(word.slice(open.length))?.[0] ?? "";
    if (open) items.push({ kind: "text", text: open });
    const innerFrom = from + open.length;
    const innerTo = to - close.length;
    if (innerFrom < innerTo) {
      const token = parseToken(text, innerFrom, innerTo);
      const raw = text.slice(innerFrom, innerTo);
      items.push(
        isCompleteOperator(token)
          ? {
              kind: "chip",
              chip: {
                raw,
                key: token.key,
                value: token.value,
                negated: token.negated,
              },
            }
          : { kind: "text", text: raw },
      );
    }
    if (close) items.push({ kind: "text", text: close });
  }
  return items;
}

/** まとまりを入力し終えたか (後ろに空白があり、OR で終わっておらず、かっこが閉じている)。 */
function isUnitDone(
  text: string,
  unit: { to: number; words: Word[]; depth: number },
  last: boolean,
): boolean {
  if (unit.to >= text.length) return false;
  if (!last) return true;
  const end = unit.words[unit.words.length - 1]?.word;
  return unit.depth === 0 && !(unit.words.length > 1 && end === "OR");
}

/**
 * 入力を、成立した条件 (チップ) と、それ以外 (欄に残す文字) に分ける。
 * 条件は後ろに空白があるもの (入力し終えたもの) だけをチップにし、入力中の語は欄に残す。
 * OR やかっこでまとめた条件は、入力し終えたらまとめて 1 つのグループのチップにする。
 * rest は、チップにした語と、その後ろの空白を取り除いた入力。
 */
export function splitChips(text: string): {
  chips: SearchChip[];
  rest: string;
} {
  const chips: SearchChip[] = [];
  let rest = "";
  let last = 0;
  const units = splitUnits(text);
  units.forEach((unit, index) => {
    if (!isUnitDone(text, unit, index === units.length - 1)) return;
    if (unit.words.length === 1) {
      const token = parseToken(text, unit.from, unit.to);
      if (!isCompleteOperator(token)) return;
      chips.push({
        raw: text.slice(unit.from, unit.to),
        key: token.key,
        value: token.value,
        negated: token.negated,
      });
    } else {
      chips.push({
        raw: text.slice(unit.from, unit.to),
        key: "",
        value: "",
        negated: false,
        items: groupItems(text, unit.words),
      });
    }
    rest += text.slice(last, unit.from);
    // 後ろの空白も 1 つ取り除く。
    last = unit.to + 1;
  });
  rest += text.slice(last);
  return { chips, rest };
}

/** チップと欄の文字を、検索欄の入力に戻す。チップは確定した印として後ろに空白を残す。 */
export function joinChips(chips: readonly SearchChip[], rest: string): string {
  if (chips.length === 0) return rest;
  return `${chips.map((chip) => chip.raw).join(" ")} ${rest}`;
}

/** 検索欄でチップにする演算子 (コロンを入れた時点でチップにする)。 */
const CHIP_KEYS = [
  "from",
  "to",
  "cc",
  "subject",
  "body",
  "folder",
  "in",
  "has",
  "is",
  "after",
  "since",
  "before",
  "until",
];

/** 入力中の条件 (末尾の「from:…」)。値はチップの中の欄で入力する。 */
export type EditingChip = {
  key: string;
  negated: boolean;
  /** 「from:」「-to:」など、コロンまで。 */
  prefix: string;
  /** コロンの後 (" を含めた入力そのまま)。 */
  value: string;
};

/** 末尾で入力中の、OR やかっこでつないでいる途中のまとまり (「from:a OR」まで入れたところなど)。 */
export type OpenGroup = {
  /** 入力の書き方そのまま (後ろの空白は含まない)。 */
  raw: string;
  items: GroupItem[];
};

export type SearchInputParts = {
  /** 入力し終えた条件。 */
  chips: SearchChip[];
  /** 条件以外の語。 */
  rest: string;
  /** 末尾でつないでいる途中のまとまり。この後ろに、入力中の条件 (editing) か語 (tail) が続く。 */
  open?: OpenGroup | null;
  /** open の後ろで入力中の、条件ではない語。 */
  tail?: string;
  /** 末尾で入力中の条件。無ければ null (欄には rest か tail を出す)。 */
  editing: EditingChip | null;
};

/** 値の中に、" で囲まれていない空白があるか (あれば、値を入力し終えた)。 */
export function hasOpenSpace(value: string): boolean {
  let inQuotes = false;
  for (const char of value) {
    if (char === '"' || char === "“" || char === "”") inQuotes = !inQuotes;
    else if (!inQuotes && /\s/u.test(char)) return true;
  }
  return false;
}

/**
 * 入力を、入力し終えた条件 (チップ)、それ以外の語、末尾で入力中の条件に分ける。
 * 演算子はコロンを入れた時点で「入力中の条件」になり、値を入れて空白で区切るとチップになる。
 */
export function splitSearchInput(text: string): SearchInputParts {
  const units = splitUnits(text);
  const unit = units[units.length - 1];
  if (!unit || isUnitDone(text, unit, true)) {
    return { ...splitChips(text), open: null, tail: "", editing: null };
  }
  // 末尾のまとまりを入力している途中。後ろに空白が無ければ、最後の語を入力している。
  const typing =
    unit.to === text.length ? unit.words[unit.words.length - 1] : null;
  const done = typing ? unit.words.slice(0, -1) : unit.words;
  const match = typing ? /^(-?)([a-z]+)([:：])(.*)$/iu.exec(typing.word) : null;
  const key = match?.[2]?.toLowerCase() ?? "";
  const editing: EditingChip | null =
    match && CHIP_KEYS.includes(key)
      ? {
          key,
          negated: match[1] === "-",
          prefix: `${match[1]}${match[2]}${match[3]}`,
          value: match[4] ?? "",
        }
      : null;
  if (done.length === 0) {
    // 語 1 つだけ: 条件なら入力中のチップ、そうでなければ欄の語。
    if (!editing || !typing) {
      return { ...splitChips(text), open: null, tail: "", editing: null };
    }
    const { chips, rest } = splitChips(text.slice(0, typing.from));
    return { chips, rest: rest.trimEnd(), open: null, tail: "", editing };
  }
  const { chips, rest } = splitChips(text.slice(0, unit.from));
  return {
    chips,
    rest: rest.trimEnd(),
    open: {
      raw: text.slice(unit.from, done[done.length - 1]?.to ?? unit.from),
      items: groupItems(text, done),
    },
    tail: typing && !editing ? typing.word : "",
    editing,
  };
}

/** splitSearchInput の結果を、検索欄の入力に戻す。 */
export function joinSearchInput(parts: SearchInputParts): string {
  const spacer = (text: string) =>
    text === "" || /\s$/u.test(text) ? "" : " ";
  let text = joinChips(parts.chips, parts.rest);
  if (parts.open) text = `${text}${spacer(text)}${parts.open.raw} `;
  if (parts.editing) {
    return `${text}${spacer(text)}${parts.editing.prefix}${parts.editing.value}`;
  }
  return parts.open ? `${text}${parts.tail ?? ""}` : text;
}

const CHIP_LABELS: Record<string, string> = {
  from: "差出人",
  to: "宛先",
  cc: "宛先",
  subject: "件名",
  body: "本文",
  folder: "フォルダ",
  in: "フォルダ",
  has: "添付",
  is: "状態",
  after: "以降",
  since: "以降",
  before: "より前",
  until: "より前",
};

const STATE_LABELS: Record<string, string> = {
  unread: "未読",
  read: "既読",
  starred: "スター付き",
  flagged: "スター付き",
  attachment: "あり",
  attachments: "あり",
  添付: "あり",
};

/** チップに出す名前と値 (「差出人」「sato@example.com」など)。 */
export function chipLabel(chip: SearchChip): { label: string; value: string } {
  const label = CHIP_LABELS[chip.key] ?? chip.key;
  const value = STATE_LABELS[chip.value.toLowerCase()] ?? chip.value;
  return { label, value };
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
  /^-?(from|to|cc|subject|body|folder|in|has|is|after|since|before|until)[:：]$/iu;

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

/** 最近の検索から 1 件を除く。 */
export function removeSearchHistory(history: string[], text: string): string[] {
  return history.filter((item) => item !== text);
}

export function writeSearchHistory(history: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 保存できなくても検索はできる。
  }
}

/** チップを「from:」などのコロンまでと、その後ろ (値) に分ける。 */
export function splitChipRaw(
  raw: string,
): { prefix: string; value: string } | null {
  const match = /^(-?[a-z]+[:：])(.*)$/iu.exec(raw);
  return match ? { prefix: match[1] ?? "", value: match[2] ?? "" } : null;
}

/** その場で編集しているチップ。 */
export type InPlaceDraft = {
  key: string;
  negated: boolean;
  prefix: string;
  value: string;
};

/**
 * 確定したチップのうち 1 つをその場で編集しているときの、入力の全体。
 * others は編集中のもの以外のチップ、at は編集中のチップの位置。値が空なら条件ごと除き、
 * 引用符を閉じ忘れていれば閉じる。
 */
export function inPlaceText(
  others: readonly SearchChip[],
  at: number,
  draft: InPlaceDraft,
  rest: string,
): string {
  const value = draft.value.trim();
  if (value === "") return joinChips(others, rest);
  const quotes = (value.match(/["“”]/gu) ?? []).length;
  const raw = `${draft.prefix}${value}${quotes % 2 === 1 ? '"' : ""}`;
  const chips = [...others];
  chips.splice(Math.min(at, chips.length), 0, {
    raw,
    key: draft.key,
    value: value.replace(/["“”]/gu, ""),
    negated: draft.negated,
  });
  return joinChips(chips, rest);
}
