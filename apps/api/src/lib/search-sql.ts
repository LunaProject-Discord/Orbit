import { mailboxes, messageMailboxes, messages } from "@orbit/db";
import { not, or, type SQL, sql } from "drizzle-orm";
import {
  type FolderTerm,
  likePattern,
  rolesNamed,
  type SearchTerm,
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

/** folder: で、そのフォルダにあるメールを探しているか (ごみ箱などを探す範囲から外さないため)。 */
export function hasPositiveFolder(search: { folders?: FolderTerm[] }): boolean {
  return search.folders?.some((folder) => !folder.negated) ?? false;
}
