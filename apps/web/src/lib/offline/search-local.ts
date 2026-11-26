import type { Address, SearchFilters } from "@/lib/api";
import { findFolded, foldForSearch } from "@/lib/search-fold";

/**
 * 端末内に保存したメールの検索 (オフライン用)。
 *
 * 検索欄の書き方は、サーバーの検索 (apps/api/src/lib/search-query.ts) と同じにしている。
 * 解釈の部分 (tokenize から highlightTerms まで) は、あちらの写し。書き方を変えるときは、両方を合わせて直すこと。
 *
 * - 空白 (全角を含む) で区切った語は、すべてを含むメールに絞り込む (AND)。
 * - 大文字の OR でつなぐと、どれかを含むメールに絞り込む (OR は空白より強く結び付く)。
 *   かっこでまとめられ、「-(…)」はその条件に当てはまらないメール。
 * - "..." で囲むと、空白を含む語句をそのまま探す。
 * - 先頭に - を付けると、その語を含まないメールに絞り込む。
 * - from: / to: / subject: / body: を付けると、探す場所を限定する (cc: は to: と同じ)。
 * - has:attachment、is:unread、is:read、is:starred で状態を絞り込む。
 * - after:2026-11-01 (その日以降)、before:2026-12-01 (その日より前) で期間を絞り込む。
 * - folder:受信トレイ (in: でも可) で、そのフォルダにあるメールに絞り込む。
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

/** 条件の葉 (語句 1 つ、状態 1 つなど)。 */
export type SearchLeaf =
  | ({ kind: "text" } & SearchTerm)
  | ({ kind: "folder" } & FolderTerm)
  | { kind: "attachment"; value: boolean }
  | { kind: "seen"; value: boolean }
  | { kind: "flagged"; value: boolean }
  /** この日 (YYYY-MM-DD) 以降。 */
  | { kind: "since"; date: string }
  /** この日 (YYYY-MM-DD) より前 (この日は含まない)。 */
  | { kind: "before"; date: string };

/** 条件の木。and / or は子のすべて / どれか、not は子に当てはまらないもの。 */
export type SearchNode =
  | SearchLeaf
  | { kind: "and"; children: SearchNode[] }
  | { kind: "or"; children: SearchNode[] }
  | { kind: "not"; child: SearchNode };

export type ParsedSearch = {
  /** 条件の木の最上位 (すべてに当てはまるメールを探す)。SQL にするのは search-sql.ts の searchCondition。 */
  nodes: SearchNode[];
  /**
   * 以下は、最上位の (OR やかっこの中ではない) 条件だけを並べたもの。一覧で目立たせる語などに使う。
   * 絞り込みには nodes を使うこと (OR の中の条件が入っていない)。
   */
  terms: SearchTerm[];
  folders?: FolderTerm[];
  hasAttachment?: boolean;
  seen?: boolean;
  flagged?: boolean;
  /** この日 (YYYY-MM-DD) 以降。 */
  since?: string;
  /** この日 (YYYY-MM-DD) より前 (この日は含まない)。 */
  before?: string;
  /** この日 (YYYY-MM-DD) まで (この日を含む)。検索欄の外の絞り込み (filters.until) だけで使う。 */
  until?: string;
};

/** 1 回の検索で使う語 (語句とフォルダ) の上限。超えた分は無視する。 */
export const MAX_SEARCH_TERMS = 20;

const fieldOperators: Record<string, SearchField> = {
  from: "from",
  to: "to",
  cc: "to",
  subject: "subject",
  body: "body",
};

type Token =
  | { type: "word"; text: string; quoted: boolean }
  /** 「(」。「-(」なら negated。 */
  | { type: "open"; negated: boolean }
  | { type: "close" }
  | { type: "or" };

/**
 * 語に分ける。空白で区切り、"..." の中の空白は区切りにしない (from:"佐藤 美咲" も 1 つ)。
 * 語の頭の「(」と、開いたかっこを閉じる「)」はかっことして扱う (引用符の中は除く)。
 * 大文字の OR (引用符で囲んでいないもの) は「または」。
 * grouping が false なら、OR もかっこもただの文字として扱う (検索欄では今は使わない)。
 */
function tokenize(input: string, grouping: boolean): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let inQuotes = false;
  let depth = 0;
  const push = () => {
    if (grouping && current === "OR" && !quoted) tokens.push({ type: "or" });
    else if (current !== "" || quoted) {
      tokens.push({ type: "word", text: current, quoted });
    }
    current = "";
    quoted = false;
  };
  for (const char of input) {
    if (char === '"' || char === "“" || char === "”") {
      inQuotes = !inQuotes;
      quoted = true;
    } else if (inQuotes) {
      current += char;
    } else if (/\s/u.test(char)) {
      push();
    } else if (
      grouping &&
      char === "(" &&
      !quoted &&
      (current === "" || current === "-")
    ) {
      tokens.push({ type: "open", negated: current === "-" });
      current = "";
      depth += 1;
    } else if (grouping && char === ")" && depth > 0) {
      push();
      tokens.push({ type: "close" });
      depth -= 1;
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

/** 語 1 つを条件の葉にする。 */
function leafOf(token: { text: string }): SearchLeaf | null {
  let text = token.text;
  let negated = false;
  if (text.startsWith("-") && text.length > 1) {
    negated = true;
    text = text.slice(1);
  }
  const colon = text.search(/[:：]/u);
  const key = colon > 0 ? text.slice(0, colon).toLowerCase() : "";
  const value = colon > 0 ? text.slice(colon + 1) : "";
  const textLeaf = (field: SearchField, raw: string): SearchLeaf | null => {
    const trimmed = raw.trim();
    return trimmed === ""
      ? null
      : { kind: "text", field, text: trimmed, negated };
  };

  if (key in fieldOperators && value !== "") {
    return textLeaf(fieldOperators[key] as SearchField, value);
  }
  if ((key === "folder" || key === "in") && value.trim() !== "") {
    return { kind: "folder", name: value.trim().toLowerCase(), negated };
  }
  if (key === "has" && /^(attachment|attachments|添付)$/i.test(value)) {
    return { kind: "attachment", value: !negated };
  }
  if (key === "is") {
    const state = value.toLowerCase();
    if (state === "unread" || state === "未読") {
      return { kind: "seen", value: negated };
    }
    if (state === "read" || state === "既読") {
      return { kind: "seen", value: !negated };
    }
    if (state === "starred" || state === "flagged" || state === "スター") {
      return { kind: "flagged", value: !negated };
    }
  }
  if (!negated && (key === "after" || key === "since")) {
    const date = normalizeDate(value);
    if (date) return { kind: "since", date };
  }
  if (!negated && (key === "before" || key === "until")) {
    const date = normalizeDate(value);
    if (date) return { kind: "before", date };
  }
  // 演算子として解釈できなければ、入力そのままを語として探す (URL や「Re:」など)。
  return textLeaf("any", text);
}

/**
 * 条件の木を組み立てる。空白で並べた条件はすべて (AND)、OR でつないだ条件はどれか、
 * かっこはまとまり、「-(」は「当てはまらない」。OR は空白より強く結び付く
 * (「from:a OR from:b 定例」は「(from:a OR from:b) かつ 定例」)。
 */
function parseTokens(tokens: Token[]): SearchNode[] {
  let index = 0;
  let words = 0;
  const leaf = (token: { text: string }): SearchNode | null => {
    const node = leafOf(token);
    if (!node) return null;
    if (node.kind === "text" || node.kind === "folder") {
      if (words >= MAX_SEARCH_TERMS) return null;
      words += 1;
    }
    return node;
  };
  const unary = (): SearchNode | null => {
    const token = tokens[index];
    if (!token) return null;
    index += 1;
    if (token.type === "open") {
      const children = sequence(true);
      if (children.length === 0) return null;
      const group: SearchNode =
        children.length === 1
          ? (children[0] as SearchNode)
          : { kind: "and", children };
      return token.negated ? { kind: "not", child: group } : group;
    }
    if (token.type === "word") return leaf(token);
    // 前に何も無い OR は、ただの語として探す。
    if (token.type === "or") return leaf({ text: "OR" });
    return null;
  };
  const disjunction = (): SearchNode | null => {
    const first = unary();
    const options = first ? [first] : [];
    while (tokens[index]?.type === "or") {
      index += 1;
      const next = unary();
      if (next) options.push(next);
    }
    if (options.length === 0) return null;
    return options.length === 1
      ? (options[0] as SearchNode)
      : { kind: "or", children: options };
  };
  const sequence = (inGroup: boolean): SearchNode[] => {
    const nodes: SearchNode[] = [];
    while (index < tokens.length) {
      if (tokens[index]?.type === "close") {
        index += 1;
        if (inGroup) break;
        continue;
      }
      const node = disjunction();
      if (node) nodes.push(node);
    }
    return nodes;
  };
  return sequence(false);
}

/** 検索の書き方の解釈のしかた。 */
export type SearchQueryOptions = {
  /**
   * OR とかっこを使うか (既定は使う)。検索欄では今は使わない (あおいさんの判断、2026-11-25) ので、
   * 検索欄の検索では false にして、OR もかっこもただの語として探す。統合フォルダの条件では使う。
   */
  grouping?: boolean;
};

export function parseSearchQuery(
  input: string,
  options: SearchQueryOptions = {},
): ParsedSearch {
  const result: ParsedSearch = {
    nodes: parseTokens(
      tokenize(input.normalize("NFC"), options.grouping ?? true),
    ),
    terms: [],
  };
  for (const node of result.nodes) noteTopLevel(result, node);
  return result;
}

/** 最上位の条件を、目立たせる語などに使う欄にも入れる。 */
function noteTopLevel(search: ParsedSearch, node: SearchNode) {
  switch (node.kind) {
    case "text":
      search.terms.push({
        field: node.field,
        text: node.text,
        negated: node.negated,
      });
      break;
    case "folder":
      search.folders ??= [];
      search.folders.push({ name: node.name, negated: node.negated });
      break;
    case "attachment":
      search.hasAttachment = node.value;
      break;
    case "seen":
      search.seen = node.value;
      break;
    case "flagged":
      search.flagged = node.value;
      break;
    case "since":
      search.since = node.date;
      break;
    case "before":
      search.before = node.date;
      break;
  }
}

/** 検索に、すべてに当てはまる条件を 1 つ足す (URL の from= など、検索欄の外の絞り込み)。 */
export function addSearchCondition(search: ParsedSearch, leaf: SearchLeaf) {
  search.nodes.push(leaf);
  noteTopLevel(search, leaf);
}

/** 条件の木の葉を、NOT の中かどうかと一緒にたどる。 */
export function* searchLeaves(
  nodes: readonly SearchNode[],
  inverted = false,
): Generator<{ leaf: SearchLeaf; inverted: boolean }> {
  for (const node of nodes) {
    if (node.kind === "and" || node.kind === "or") {
      yield* searchLeaves(node.children, inverted);
    } else if (node.kind === "not") {
      yield* searchLeaves([node.child], !inverted);
    } else {
      yield { leaf: node, inverted };
    }
  }
}

/** 何の条件も無い (全件が当てはまってしまう) 検索かどうか。 */
export function isEmptySearch(search: ParsedSearch): boolean {
  return search.nodes.length === 0 && search.until === undefined;
}

/** 一覧で目立たせる語 (含まないことを求めた語と、差出人・宛先に限定した語は除く)。 */
export function highlightTerms(search: ParsedSearch): string[] {
  const terms: string[] = [];
  for (const { leaf, inverted } of searchLeaves(search.nodes)) {
    if (leaf.kind !== "text" || leaf.negated !== inverted) continue;
    if (leaf.field === "from" || leaf.field === "to") continue;
    terms.push(leaf.text);
  }
  return [...new Set(terms)];
}

/** 検索欄の入力と、絞り込みの条件を 1 つにまとめる (サーバーの検索と同じ決まり)。 */
export function buildSearch(
  text: string,
  filters: SearchFilters,
): ParsedSearch {
  const search = parseSearchQuery(text, { grouping: false });
  for (const [field, value] of [
    ["from", filters.from],
    ["to", filters.to],
    ["subject", filters.subject],
  ] as const) {
    if (value.trim()) {
      addSearchCondition(search, {
        kind: "text",
        field,
        text: value.trim(),
        negated: false,
      });
    }
  }
  if (filters.hasAttachment) {
    addSearchCondition(search, { kind: "attachment", value: true });
  }
  if (filters.unread)
    addSearchCondition(search, { kind: "seen", value: false });
  if (filters.flagged) {
    addSearchCondition(search, { kind: "flagged", value: true });
  }
  const since = filters.since ? normalizeDate(filters.since) : null;
  if (since) addSearchCondition(search, { kind: "since", date: since });
  const until = filters.until ? normalizeDate(filters.until) : null;
  if (until) search.until = until;
  return search;
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
  for (const { leaf, inverted } of searchLeaves(search.nodes)) {
    if (leaf.kind === "folder" && leaf.negated === inverted) return true;
  }
  return false;
}

function addressText(list: Address[]): string {
  return foldForSearch(
    list.map((item) => `${item.name ?? ""} ${item.address}`).join(" "),
  );
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
  const received = Date.parse(doc.receivedAt);
  if (search.until && received >= startOfDay(search.until, 1)) return null;

  // 全角と半角・大文字と小文字・空白の有無は区別しない (サーバーの検索と同じ)。
  const subject = foldForSearch(doc.subject);
  const from = addressText(doc.from);
  const recipients = addressText(doc.recipients);
  const body = foldForSearch(`${doc.snippet}\n${doc.body ?? ""}`);
  const leafMatches = (leaf: SearchLeaf): boolean => {
    switch (leaf.kind) {
      case "text": {
        const needle = foldForSearch(leaf.text);
        let found: boolean;
        switch (leaf.field) {
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
        return found !== leaf.negated;
      }
      case "folder":
        return (doc.folderNames?.includes(leaf.name) ?? false) !== leaf.negated;
      case "attachment":
        return doc.hasAttachments === leaf.value;
      case "seen":
        return doc.seen === leaf.value;
      case "flagged":
        return doc.flagged === leaf.value;
      case "since":
        return received >= startOfDay(leaf.date);
      case "before":
        return received < startOfDay(leaf.date);
    }
  };
  const matches = (node: SearchNode): boolean => {
    switch (node.kind) {
      case "and":
        return node.children.every(matches);
      case "or":
        return node.children.some(matches);
      case "not":
        return !matches(node.child);
      default:
        return leafMatches(node);
    }
  };
  if (!search.nodes.every(matches)) return null;

  // 抜粋に使う語。OR の中の語でもよい (当てはまった方とは限らないが、無ければ抜粋を出さないだけ)。
  const excerptTerm = [...searchLeaves(search.nodes)]
    .map(({ leaf, inverted }) =>
      leaf.kind === "text" && leaf.negated === inverted ? leaf : null,
    )
    .find(
      (term) =>
        term !== null && (term.field === "any" || term.field === "body"),
    );
  if (!excerptTerm || !doc.body) return { excerpt: null };
  if (
    findFolded(doc.subject, excerptTerm.text) ||
    findFolded(doc.snippet, excerptTerm.text)
  ) {
    return { excerpt: null };
  }
  const found = findFolded(doc.body, excerptTerm.text);
  if (!found) return { excerpt: null };
  const start = Math.max(0, found.start - EXCERPT_BEFORE);
  const text = doc.body
    .slice(start, start + EXCERPT_LENGTH)
    .replace(/\s+/g, " ")
    .trim();
  return { excerpt: `${start > 0 ? "…" : ""}${text}` };
}
