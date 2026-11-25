import { mailboxes, messageMailboxes, messages } from "@orbit/db";
import { and, eq, not, or, type SQL, sql } from "drizzle-orm";
import {
  type FolderTerm,
  likePattern,
  type ParsedSearch,
  rolesNamed,
  type SearchLeaf,
  type SearchNode,
  type SearchTerm,
  searchLeaves,
} from "./search-query.js";

/** 検索の語 1 つを、messages への条件にする (部分一致)。検索と統合フォルダで共有する。 */
export function termCondition(term: SearchTerm): SQL {
  const pattern = likePattern(term.text);
  const matches = (column: SQL | typeof messages.subject) =>
    sql`${column} ilike ${pattern}`;
  let condition: SQL;
  switch (term.field) {
    case "from":
      condition = matches(sql`${messages.searchFrom}`);
      break;
    case "to":
      condition = matches(sql`${messages.searchRecipients}`);
      break;
    case "subject":
      condition = matches(messages.subject);
      break;
    case "body":
      condition = matches(sql`${messages.searchBody}`);
      break;
    default:
      condition = or(
        matches(messages.subject),
        matches(sql`${messages.searchFrom}`),
        matches(sql`${messages.searchRecipients}`),
        matches(sql`${messages.searchBody}`),
      ) as SQL;
  }
  return term.negated ? not(condition) : condition;
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
  const leafCondition = (leaf: SearchLeaf): SQL => {
    switch (leaf.kind) {
      case "text":
        return termCondition(leaf);
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
  const build = (node: SearchNode): SQL | undefined => {
    switch (node.kind) {
      case "and":
        return and(...node.children.map(build));
      case "or":
        return or(...node.children.map(build));
      case "not": {
        const inner = build(node.child);
        return inner ? not(inner) : undefined;
      }
      default:
        return leafCondition(node);
    }
  };
  if (search.nodes.length === 0) return undefined;
  return and(...search.nodes.map(build));
}
