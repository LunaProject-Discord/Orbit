import type { Account } from "@/lib/api";

/**
 * アカウントを見分けるための色。一覧の点、サイドバー、作成画面の差出人で同じ色を使う。
 * 名前は API (apps/api の accounts.ts) と揃える。
 */
export const ACCOUNT_COLORS = [
  { name: "sky", label: "水色", dot: "bg-sky-500" },
  { name: "violet", label: "紫", dot: "bg-violet-500" },
  { name: "emerald", label: "緑", dot: "bg-emerald-500" },
  { name: "amber", label: "黄", dot: "bg-amber-500" },
  { name: "rose", label: "赤", dot: "bg-rose-500" },
  { name: "teal", label: "青緑", dot: "bg-teal-500" },
  { name: "orange", label: "オレンジ", dot: "bg-orange-500" },
  { name: "slate", label: "グレー", dot: "bg-slate-500" },
] as const;

export type AccountColorName = (typeof ACCOUNT_COLORS)[number]["name"];

type Colored = Pick<Account, "id" | "color" | "createdAt">;

/**
 * アカウントの色の名前。選んでいなければ、追加した順に割り当てる
 * (並び替えたり、ほかのアカウントの色を変えたりしても、色が入れ替わらないようにする)。
 */
export function accountColorName(
  accounts: readonly Colored[],
  accountId: string,
): AccountColorName {
  const chosen = accounts.find((account) => account.id === accountId)?.color;
  if (chosen && ACCOUNT_COLORS.some((color) => color.name === chosen)) {
    return chosen;
  }
  const index = [...accounts]
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    .findIndex((account) => account.id === accountId);
  return (
    ACCOUNT_COLORS[(index < 0 ? 0 : index) % ACCOUNT_COLORS.length] ??
    ACCOUNT_COLORS[0]
  ).name;
}

/** アカウントの色の点に付けるクラス (背景色)。 */
export function accountColor(
  accounts: readonly Colored[],
  accountId: string,
): string {
  const name = accountColorName(accounts, accountId);
  return (
    ACCOUNT_COLORS.find((color) => color.name === name)?.dot ??
    ACCOUNT_COLORS[0].dot
  );
}
