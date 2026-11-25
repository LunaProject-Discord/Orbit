/**
 * 検索欄に入力された文字列の解釈。
 *
 * - 空白 (全角を含む) で区切った語は、すべてを含むメールに絞り込む (AND)。
 * - "..." で囲むと、空白を含む語句をそのまま探す。
 * - 先頭に - を付けると、その語を含まないメールに絞り込む。
 * - from: / to: / subject: / body: を付けると、探す場所を限定する (cc: は to: と同じ)。
 * - has:attachment、is:unread、is:read、is:starred で状態を絞り込む。
 * - after:2026-11-01 (その日以降)、before:2026-12-01 (その日より前) で期間を絞り込む。
 * - folder:受信トレイ (in: でも可) で、そのフォルダにあるメールに絞り込む。名前は、アプリでの
 *   表示名・受信トレイなどの役割の名前・メールサーバー上の名前やパスのどれかと一致すればよく、
 *   アカウントはまたぐ (どのアカウントの受信トレイでもよい)。
 */

export type SearchField = "any" | "from" | "to" | "subject" | "body";

export type SearchTerm = {
  field: SearchField;
  text: string;
  /** true なら、この語を含まないメールを探す。 */
  negated: boolean;
};

/** folder: で指定したフォルダ。 */
export type FolderTerm = {
  /** 小文字にそろえた名前。 */
  name: string;
  /** true なら、そのフォルダに無いメールを探す。 */
  negated: boolean;
};

export type ParsedSearch = {
  terms: SearchTerm[];
  folders?: FolderTerm[];
  hasAttachment?: boolean;
  seen?: boolean;
  flagged?: boolean;
  /** この日 (YYYY-MM-DD) 以降。 */
  since?: string;
  /** この日 (YYYY-MM-DD) より前 (この日は含まない)。 */
  before?: string;
};

/** 1 回の検索で使う語の上限。超えた分は無視する。 */
export const MAX_SEARCH_TERMS = 20;

const fieldOperators: Record<string, SearchField> = {
  from: "from",
  to: "to",
  cc: "to",
  subject: "subject",
  body: "body",
};

type Token = { text: string; quoted: boolean };

/** 空白で区切る。"..." の中の空白は区切りにしない (from:"佐藤 美咲" のような形も 1 つにまとめる)。 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let inQuotes = false;
  const push = () => {
    if (current !== "" || quoted) tokens.push({ text: current, quoted });
    current = "";
    quoted = false;
  };
  for (const char of input) {
    if (char === '"' || char === "“" || char === "”") {
      inQuotes = !inQuotes;
      quoted = true;
    } else if (!inQuotes && /\s/u.test(char)) {
      push();
    } else {
      current += char;
    }
  }
  push();
  return tokens;
}

/** 2026-11-01、2026/11/1 のような日付を YYYY-MM-DD にそろえる。日付でなければ null。 */
export function normalizeDate(value: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1970 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function parseSearchQuery(input: string): ParsedSearch {
  const result: ParsedSearch = { terms: [] };
  const addTerm = (field: SearchField, text: string, negated: boolean) => {
    const trimmed = text.trim();
    if (trimmed === "" || result.terms.length >= MAX_SEARCH_TERMS) return;
    result.terms.push({ field, text: trimmed, negated });
  };

  for (const token of tokenize(input.normalize("NFC"))) {
    let text = token.text;
    let negated = false;
    if (text.startsWith("-") && text.length > 1) {
      negated = true;
      text = text.slice(1);
    }
    const colon = text.search(/[:：]/u);
    const key = colon > 0 ? text.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? text.slice(colon + 1) : "";

    if (key in fieldOperators && value !== "") {
      addTerm(fieldOperators[key] as SearchField, value, negated);
      continue;
    }
    if ((key === "folder" || key === "in") && value.trim() !== "") {
      result.folders ??= [];
      if (result.folders.length < MAX_SEARCH_TERMS) {
        result.folders.push({ name: value.trim().toLowerCase(), negated });
      }
      continue;
    }
    if (key === "has" && /^(attachment|attachments|添付)$/i.test(value)) {
      result.hasAttachment = !negated;
      continue;
    }
    if (key === "is") {
      const state = value.toLowerCase();
      if (state === "unread" || state === "未読") {
        result.seen = negated;
        continue;
      }
      if (state === "read" || state === "既読") {
        result.seen = !negated;
        continue;
      }
      if (state === "starred" || state === "flagged" || state === "スター") {
        result.flagged = !negated;
        continue;
      }
    }
    if (!negated && (key === "after" || key === "since")) {
      const date = normalizeDate(value);
      if (date) {
        result.since = date;
        continue;
      }
    }
    if (!negated && (key === "before" || key === "until")) {
      const date = normalizeDate(value);
      if (date) {
        result.before = date;
        continue;
      }
    }
    // 演算子として解釈できなければ、入力そのままを語として探す (URL や「Re:」など)。
    addTerm("any", text, negated);
  }
  return result;
}

/** 何の条件も無い (全件が当てはまってしまう) 検索かどうか。 */
export function isEmptySearch(search: ParsedSearch): boolean {
  return (
    search.terms.length === 0 &&
    (search.folders?.length ?? 0) === 0 &&
    search.hasAttachment === undefined &&
    search.seen === undefined &&
    search.flagged === undefined &&
    search.since === undefined &&
    search.before === undefined
  );
}

/** ILIKE の検索文字列にする。% や _ はそのままの文字として探す。 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** 一覧で目立たせる語 (含まないことを求めた語と、差出人・宛先に限定した語は除く)。 */
export function highlightTerms(search: ParsedSearch): string[] {
  const terms = search.terms
    .filter(
      (term) => !term.negated && term.field !== "from" && term.field !== "to",
    )
    .map((term) => term.text);
  return [...new Set(terms)];
}

/** 受信トレイなどの役割の、アプリでの名前 (apps/web の specialLabels と揃える)。 */
const ROLE_LABELS: Record<string, string> = {
  inbox: "受信トレイ",
  flagged: "スター付き",
  drafts: "下書き",
  sent: "送信済み",
  archive: "アーカイブ",
  all: "すべてのメール",
  junk: "迷惑メール",
  trash: "ごみ箱",
};

/** folder: の名前に当てはまる役割 (「受信トレイ」でも「inbox」でもよい)。 */
export function rolesNamed(name: string): string[] {
  const target = name.toLowerCase();
  return Object.entries(ROLE_LABELS)
    .filter(([role, label]) => role === target || label === target)
    .map(([role]) => role);
}
