import {
  mailboxes,
  messageMailboxes,
  messageSearch,
  messages,
} from "@orbit/db";
import { and, eq, not, or, type SQL, sql } from "drizzle-orm";
import { foldForSearch } from "./search-fold.js";
import { searchIndex } from "./search-index.js";
import {
  type FolderTerm,
  type ParsedSearch,
  rolesNamed,
  type SearchField,
  type SearchLeaf,
  type SearchNode,
  type SearchTerm,
  searchLeaves,
} from "./search-query.js";

/**
 * 検索用の文字列 (message_search.doc) のどの部分を探すか。doc は「件名 \x01 差出人 \x01 宛先 \x01 本文」
 * なので、split_part(doc, chr(1), n) の n。0 は全体。
 */
const FIELD_PARTS: Record<SearchField, number> = {
  any: 0,
  subject: 1,
  from: 2,
  to: 3,
  body: 4,
};

/** doc (検索用の文字列) のうち、field の部分。 */
function fieldPart(doc: SQL, field: SearchField): SQL {
  const part = FIELD_PARTS[field];
  return part === 0 ? doc : sql`split_part(${doc}, chr(1), ${part}::int)`;
}

/**
 * 語の条件の作り方。
 * - index: 索引で候補を絞り、LIKE で確かめる (ふつうはこれ)。
 * - loose: 索引の語 (1 文字・2 文字の組) がそろうかだけを見る。当てはまるメールをすべて含むが、
 *   語が離れて現れるメールも含む (並べた候補を verify で確かめる前提)。
 * - verify: 1 通ずつ検索用の文字列を LIKE で確かめる (候補が少ないとき用)。
 */
export type TermMode = "index" | "loose" | "verify";

/** 索引の語がそろえば必ず含む (LIKE で確かめなくてよい) 語か。場所を限定しない 2 文字以下の語。 */
function isExactByGrams(term: SearchTerm, folded: string): boolean {
  return term.field === "any" && Array.from(folded).length <= 2;
}

/**
 * 検索の語 1 つを、messages への条件にする (部分一致)。検索と統合フォルダで共有する。
 *
 * 全角と半角・大文字と小文字・空白の有無を区別しない (DB の mail_search_normalize でそろえる)。
 * message_search の索引 (1 文字と、隣り合う 2 文字の組) で候補を絞り、LIKE で確かめる。
 * 索引がまだ無い (同期ワーカーが作っている途中の) ときは、メールから検索用の文字列をその場で作って探す。
 */
export function termCondition(term: SearchTerm, mode: TermMode = "index"): SQL {
  const folded = foldForSearch(term.text);
  let condition: SQL;
  if (folded === "") {
    // 空白だけの語などは、どのメールにも含まれるとみなす (空の文字列の部分一致と同じ)。
    condition = sql`true`;
  } else {
    const value = sql`mail_search_normalize(${term.text})`;
    const pattern = sql`mail_search_like_pattern(${value})`;
    const doc = sql`${messageSearch.doc}`;
    if (!searchIndex.ready) {
      // 作り済みの検索用の文字列があれば使い、無ければその場で作る。
      const built = sql`coalesce(
        (select ${messageSearch.doc} from ${messageSearch} where ${messageSearch.messageId} = ${messages.id}),
        mail_search_document(${messages.subject}, ${messages.from}, ${messages.to} || ${messages.cc} || ${messages.bcc}, ${messages.bodyText}, ${messages.bodyHtml}, ${messages.snippet})
      )`;
      condition = sql`${fieldPart(built, term.field)} like ${pattern}`;
    } else if (mode === "verify") {
      // 相関のあるスカラーの副問い合わせは、1 通ずつ主キーで引いて確かめる (表全体を探さない)。
      condition = sql`coalesce((
        select ${fieldPart(doc, term.field)} like ${pattern} from ${messageSearch}
        where ${messageSearch.messageId} = ${messages.id}
      ), false)`;
    } else {
      const like =
        mode === "loose" || isExactByGrams(term, folded)
          ? sql``
          : sql` and ${fieldPart(doc, term.field)} like ${pattern}`;
      // offset 0 で副問い合わせを外側と混ぜずに計画させ、必ず索引で引く
      // (混ぜると、1 行ずつ mail_search_grams を計算する重い計画を選ぶことがある)。
      condition = sql`${messages.id} in (
        select ${messageSearch.messageId} from ${messageSearch}
        where mail_search_grams(${messageSearch.doc}) @> mail_search_query_grams(${value})${like}
        offset 0
      )`;
    }
  }
  return term.negated ? not(condition) : condition;
}

/**
 * 条件に、loose で作ると確かめが要る語 (索引の語だけでは決まらない語) があるか。
 * 無ければ loose と index は同じ結果になる。
 */
export function needsVerification(
  search: Pick<ParsedSearch, "nodes">,
): boolean {
  if (!searchIndex.ready) return false;
  for (const { leaf } of searchLeaves(search.nodes)) {
    if (leaf.kind !== "text") continue;
    const folded = foldForSearch(leaf.text);
    if (folded !== "" && !isExactByGrams(leaf, folded)) return true;
  }
  return false;
}

/**
 * folder: で指定したフォルダを、messages への条件にする。名前は、アプリでの表示名、
 * 受信トレイなどの役割の名前 (表示名を付けていないとき)、メールサーバー上の名前とパスの
 * どれかと一致すればよい (大文字と小文字は区別しない)。アカウントはまたぐ。
 */
export function folderCondition(folder: FolderTerm): SQL {
  const roles = rolesNamed(folder.name);
  const roleMatch =
    roles.length > 0
      ? sql` or (${mailboxes.displayName} is null and ${mailboxes.specialUse}::text in (${sql.join(
          roles.map((role) => sql`${role}`),
          sql`, `,
        )}))`
      : sql``;
  const condition = sql`exists (
    select 1 from ${messageMailboxes}
    inner join ${mailboxes} on ${mailboxes.id} = ${messageMailboxes.mailboxId}
    where ${messageMailboxes.messageId} = ${messages.id} and (
      lower(${mailboxes.displayName}) = ${folder.name}
      or lower(${mailboxes.name}) = ${folder.name}
      or lower(${mailboxes.path}) = ${folder.name}${roleMatch}
    )
  )`;
  return folder.negated ? sql`not ${condition}` : condition;
}

/**
 * folder: で、そのフォルダにあるメールを探しているか (ごみ箱などを探す範囲から外さないため)。
 * OR の中や -( ) の中の指定も見る。
 */
export function hasPositiveFolder(
  search: Pick<ParsedSearch, "nodes">,
): boolean {
  for (const { leaf, inverted } of searchLeaves(search.nodes)) {
    if (leaf.kind === "folder" && leaf.negated === inverted) return true;
  }
  return false;
}

export type SearchConditionOptions = {
  /** 日付 (after: / before:) の区切りに使うタイムゾーン。省略すると UTC。 */
  timeZone?: string;
  /**
   * 語の条件の作り方 (TermMode)。loose は、当てはまるメールを必ず含むように作る
   * (含むことを求める語は索引の語だけで見て、含まないことを求める語 (- や NOT の中) は、
   * 索引の語だけで決まらなければ絞らない)。結果は verify で確かめること。
   */
  mode?: TermMode;
};

/**
 * 検索欄の書き方 (parseSearchQuery の結果) 全体を、messages への条件 1 つにする。
 * OR やかっこ、-( ) もここで組み立てる。条件が無ければ undefined。検索と統合フォルダで共有する。
 */
export function searchCondition(
  search: Pick<ParsedSearch, "nodes">,
  options: SearchConditionOptions = {},
): SQL | undefined {
  const timeZone = options.timeZone ?? "UTC";
  const startOfDay = (date: string) =>
    sql`(${date}::date::timestamp at time zone ${timeZone})`;
  const mode = options.mode ?? "index";
  const leafCondition = (leaf: SearchLeaf, inverted: boolean): SQL => {
    switch (leaf.kind) {
      case "text": {
        if (mode === "loose" && leaf.negated !== inverted) {
          // 含まないことを求める語。索引の語だけで決まらない語は、ここでは絞らない
          // (この葉が NOT の中で使われても、外側の結果が狭まらない値にする)。
          const folded = foldForSearch(leaf.text);
          if (folded !== "" && !isExactByGrams(leaf, folded)) {
            return leaf.negated ? sql`true` : sql`false`;
          }
          return termCondition(leaf, "index");
        }
        return termCondition(leaf, mode);
      }
      case "folder":
        return folderCondition(leaf);
      case "attachment":
        return eq(messages.hasAttachments, leaf.value);
      case "seen":
        return eq(messages.seen, leaf.value);
      case "flagged":
        return eq(messages.flagged, leaf.value);
      case "since":
        return sql`${messages.receivedAt} >= ${startOfDay(leaf.date)}`;
      case "before":
        return sql`${messages.receivedAt} < ${startOfDay(leaf.date)}`;
    }
  };
  // inverted: NOT の中 (含まないことを求める側) にあるか。
  const build = (node: SearchNode, inverted: boolean): SQL | undefined => {
    switch (node.kind) {
      case "and":
        return and(...node.children.map((child) => build(child, inverted)));
      case "or":
        return or(...node.children.map((child) => build(child, inverted)));
      case "not": {
        const inner = build(node.child, !inverted);
        return inner ? not(inner) : undefined;
      }
      default:
        return leafCondition(node, inverted);
    }
  };
  if (search.nodes.length === 0) return undefined;
  return and(...search.nodes.map((node) => build(node, false)));
}
