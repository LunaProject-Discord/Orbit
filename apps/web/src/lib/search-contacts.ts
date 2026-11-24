import { useMemo } from "react";
import { useContactSuggestions, useContacts } from "@/lib/contacts";

/** 検索欄の候補に出す相手。 */
export type ContactSuggestion = { name: string | null; address: string };

/**
 * 検索欄の候補に出す相手のアドレス。宛先の欄と同じ候補 (lib/contacts.ts) を使う。
 * query が空 (「from:」まで入れたところ) なら、よくやり取りする相手を上から出す。
 * limit が 0 なら何も出さない。
 */
export function useSearchContacts(
  query: string,
  limit: number,
): ContactSuggestion[] {
  const contacts = useContacts();
  const matched = useContactSuggestions(query, { limit: Math.max(limit, 1) });
  return useMemo(() => {
    if (limit === 0) return [];
    return query.trim() === "" ? contacts.slice(0, limit) : matched;
  }, [contacts, matched, query, limit]);
}
