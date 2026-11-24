/** 検索欄の候補に出す相手。 */
export type ContactSuggestion = { name: string | null; address: string };

/**
 * 検索欄の候補に出す相手のアドレス。query に当たるものを、よくやり取りする順に返す。
 * TODO: 宛先の候補 (lib/contacts.ts) がマージされたら、そちらの取得処理に置き換える。
 */
export function useSearchContacts(
  _query: string,
  _limit: number,
): ContactSuggestion[] {
  return [];
}
