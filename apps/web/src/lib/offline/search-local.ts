import type { Address, SearchFilters } from "@/lib/api";

/**
 * 端末内に保存したメールの検索 (オフライン用)。
 *
 * 検索欄の書き方は、サーバーの検索 (apps/api/src/lib/search-query.ts) と同じにしている。
 * 書き方を変えるときは、両方を合わせて直すこと。
 *
 * - 空白 (全角を含む) で区切った語は、すべてを含むメールに絞り込む (AND)。
 * - "..." で囲むと、空白を含む語句をそのまま探す。
 * - 先頭に - を付けると、その語を含まないメールに絞り込む。
 * - from: / to: / subject: / body: を付けると、探す場所を限定する (cc: は to: と同じ)。
 * - has:attachment、is:unread、is:read、is:starred で状態を絞り込む。
 * - after:2026-11-01 (その日以降)、before:2026-12-01 (その日より前) で期間を絞り込む。
 */

export type SearchField = "any" | "from" | "to" | "subject" | "body";

export type SearchTerm = {
  field: SearchField;
  text: string;
  /** true なら、この語を含まないメールを探す。 */
  negated: boolean;
};

/** folder: で指定したフォルダ (サーバーの検索と同じ決まり)。 */
export type FolderTerm = {
  /** 小文字にそろえた名前。 */
  name: string;
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
  /** この日 (YYYY-MM-DD) まで (この日を含む)。 */
  until?: string;
};

const MAX_SEARCH_TERMS = 20;

const fieldOperators: Record<string, SearchField> = {
  from: "from",
  to: "to",
  cc: "to",
  subject: "subject",
  body: "body",
};

type Token = { text: string; quoted: boolean };

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

/** 検索欄の入力と、絞り込みの条件を 1 つにまとめる (サーバーの検索と同じ決まり)。 */
export function buildSearch(
  text: string,
  filters: SearchFilters,
): ParsedSearch {
  const search = parseSearchQuery(text);
  for (const [field, value] of [
    ["from", filters.from],
    ["to", filters.to],
    ["subject", filters.subject],
  ] as const) {
    if (value.trim()) {
      search.terms.push({ field, text: value.trim(), negated: false });
    }
  }
  if (filters.hasAttachment) search.hasAttachment = true;
  if (filters.unread) search.seen = false;
  if (filters.flagged) search.flagged = true;
  const since = filters.since ? normalizeDate(filters.since) : null;
  if (since) search.since = since;
  const until = filters.until ? normalizeDate(filters.until) : null;
  if (until) search.until = until;
  return search;
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
    search.before === undefined &&
    search.until === undefined
  );
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

/** 検索の対象にする、メール 1 通分の内容。 */
export type SearchDoc = {
  subject: string;
  from: Address[];
  /** 宛先 (To と Cc)。 */
  recipients: Address[];
  snippet: string;
  /** 本文。端末に保存していなければ null (冒頭の抜粋だけを探す)。 */
  body: string | null;
  receivedAt: string;
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  /** メールのあるフォルダの、folder: で当てはまる名前 (小文字。folderNames で作る)。 */
  folderNames?: readonly string[];
};

/** 受信トレイなどの役割の、アプリでの名前 (lib/mailboxes.ts の specialLabels と揃える)。 */
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

/**
 * folder: で当てはまるフォルダの名前。アプリでの表示名、役割の名前 (表示名が無いとき)、
 * メールサーバー上の名前とパス (サーバーの検索と同じ決まり)。
 */
export function folderNames(mailbox: {
  name: string;
  path: string;
  specialUse: string | null;
  displayName?: string | null;
}): string[] {
  const names = [mailbox.name, mailbox.path];
  if (mailbox.displayName) names.push(mailbox.displayName);
  else if (mailbox.specialUse) {
    names.push(mailbox.specialUse, ROLE_LABELS[mailbox.specialUse] ?? "");
  }
  return names.filter(Boolean).map((name) => name.toLowerCase());
}

/** folder: で、そのフォルダにあるメールを探しているか (ごみ箱なども探す範囲に入れる)。 */
export function hasPositiveFolder(search: ParsedSearch): boolean {
  return search.folders?.some((folder) => !folder.negated) ?? false;
}

function addressText(list: Address[]): string {
  return list
    .map((item) => `${item.name ?? ""} ${item.address}`)
    .join(" ")
    .toLowerCase();
}

/** その日の 0 時 (この端末のタイムゾーン) を、日数をずらして返す。 */
function startOfDay(date: string, addDays = 0): number {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(year, month - 1, day + addDays).getTime();
}

const EXCERPT_BEFORE = 30;
const EXCERPT_LENGTH = 160;

/**
 * メールが検索に当てはまるかを調べる。当てはまらなければ null。
 * 当てはまれば、語が件名にも冒頭の抜粋にも無いときの本文の該当箇所 (無ければ null) を返す。
 */
export function matchSearch(
  doc: SearchDoc,
  search: ParsedSearch,
): { excerpt: string | null } | null {
  if (
    search.hasAttachment !== undefined &&
    doc.hasAttachments !== search.hasAttachment
  ) {
    return null;
  }
  if (search.seen !== undefined && doc.seen !== search.seen) return null;
  if (search.flagged !== undefined && doc.flagged !== search.flagged) {
    return null;
  }
  for (const folder of search.folders ?? []) {
    const found = doc.folderNames?.includes(folder.name) ?? false;
    if (found === folder.negated) return null;
  }
  const received = Date.parse(doc.receivedAt);
  if (search.since && received < startOfDay(search.since)) return null;
  if (search.before && received >= startOfDay(search.before)) return null;
  if (search.until && received >= startOfDay(search.until, 1)) return null;

  const subject = doc.subject.toLowerCase();
  const from = addressText(doc.from);
  const recipients = addressText(doc.recipients);
  const body = `${doc.snippet}\n${doc.body ?? ""}`.toLowerCase();
  for (const term of search.terms) {
    const needle = term.text.toLowerCase();
    let found: boolean;
    switch (term.field) {
      case "from":
        found = from.includes(needle);
        break;
      case "to":
        found = recipients.includes(needle);
        break;
      case "subject":
        found = subject.includes(needle);
        break;
      case "body":
        found = body.includes(needle);
        break;
      default:
        found =
          subject.includes(needle) ||
          from.includes(needle) ||
          recipients.includes(needle) ||
          body.includes(needle);
    }
    if (found === term.negated) return null;
  }

  const excerptTerm = search.terms.find(
    (term) => !term.negated && (term.field === "any" || term.field === "body"),
  );
  if (!excerptTerm || !doc.body) return { excerpt: null };
  const needle = excerptTerm.text.toLowerCase();
  if (subject.includes(needle) || doc.snippet.toLowerCase().includes(needle)) {
    return { excerpt: null };
  }
  const position = doc.body.toLowerCase().indexOf(needle);
  if (position < 0) return { excerpt: null };
  const start = Math.max(0, position - EXCERPT_BEFORE);
  const text = doc.body
    .slice(start, start + EXCERPT_LENGTH)
    .replace(/\s+/g, " ")
    .trim();
  return { excerpt: `${start > 0 ? "…" : ""}${text}` };
}
