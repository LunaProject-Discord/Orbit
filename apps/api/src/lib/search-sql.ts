import { messages } from "@orbit/db";
import { not, or, type SQL, sql } from "drizzle-orm";
import { likePattern, type SearchTerm } from "./search-query.js";

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
