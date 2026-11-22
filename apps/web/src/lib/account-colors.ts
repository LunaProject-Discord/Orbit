import type { CSSProperties } from "react";
import type { Account } from "@/lib/api";
import { normalizeHex, readableOn, textOn } from "@/lib/color";

/**
 * アカウントを見分けるための色。一覧の点、サイドバー、作成画面の差出人で同じ色を使う。
 * 保存するのは "#rrggbb" の色そのもの (mail_accounts.color)。見本から選んでも、
 * 自由に作った色でもよい。
 */

/** 色の見本。上の段が明るい色、下の段が同じ色合いの濃い色。 */
export const ACCOUNT_COLOR_PRESETS = [
  { hex: "#f43f5e", label: "赤" },
  { hex: "#f97316", label: "オレンジ" },
  { hex: "#f59e0b", label: "黄" },
  { hex: "#10b981", label: "緑" },
  { hex: "#14b8a6", label: "青緑" },
  { hex: "#0ea5e9", label: "水色" },
  { hex: "#6366f1", label: "藍" },
  { hex: "#8b5cf6", label: "紫" },
  { hex: "#ec4899", label: "ピンク" },
  { hex: "#64748b", label: "グレー" },
  { hex: "#be123c", label: "濃い赤" },
  { hex: "#c2410c", label: "濃いオレンジ" },
  { hex: "#b45309", label: "濃い黄" },
  { hex: "#047857", label: "濃い緑" },
  { hex: "#0f766e", label: "濃い青緑" },
  { hex: "#0369a1", label: "濃い水色" },
  { hex: "#4338ca", label: "濃い藍" },
  { hex: "#6d28d9", label: "濃い紫" },
  { hex: "#be185d", label: "濃いピンク" },
  { hex: "#334155", label: "濃いグレー" },
] as const;

/** 見本の 1 段に並べる数。 */
export const ACCOUNT_COLOR_COLUMNS = 10;

/**
 * 以前の保存形式 (色の名前)。マイグレーション 0016 で色そのものに直したが、
 * 端末に保存した古い内容 (オフライン用) にも残りうるので、読むときは受け付ける。
 * 色を選んでいないアカウントには、この並びの順に割り当てる。
 */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  sky: "#0ea5e9",
  violet: "#8b5cf6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  teal: "#14b8a6",
  orange: "#f97316",
  slate: "#64748b",
};
const AUTO_COLORS = Object.values(NAMED_COLORS);

type Colored = Pick<Account, "id" | "color" | "createdAt">;

/**
 * アカウントの色 ("#rrggbb")。選んでいなければ、追加した順に割り当てる
 * (並び替えたり、ほかのアカウントの色を変えたりしても、色が入れ替わらないようにする)。
 */
export function accountColorHex(
  accounts: readonly Colored[],
  accountId: string,
): string {
  const chosen = accounts.find((account) => account.id === accountId)?.color;
  if (chosen) {
    const hex = NAMED_COLORS[chosen] ?? normalizeHex(chosen);
    if (hex) return hex;
  }
  const index = [...accounts]
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    .findIndex((account) => account.id === accountId);
  return AUTO_COLORS[(index < 0 ? 0 : index) % AUTO_COLORS.length] ?? "#0ea5e9";
}

/** 色の名前 (見本にある色だけ)。読み上げや説明に使う。 */
export function accountColorLabel(hex: string): string | null {
  return (
    ACCOUNT_COLOR_PRESETS.find((preset) => preset.hex === hex)?.label ?? null
  );
}

/** 明るい配色と暗い配色の、地の色のめやす (暗い方はカードやサイドバーの色)。 */
const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#171717";
/** アイコンの背景に重ねる色の割合。下の ACCOUNT_TINT_CLASS と揃える。 */
const LIGHT_TINT = 0.15;
const DARK_TINT = 0.2;

const styles = new Map<string, CSSProperties>();

/**
 * 色を、下の ACCOUNT_*_CLASS が使う CSS 変数にする。
 * 選んだ色のままだと、白に近い色は明るい配色で、黒に近い色は暗い配色で見えなくなるので、
 * 配色ごとに、地の色と見分けられる明るさへ寄せた色を渡す (足りている色はそのまま)。
 */
export function accountColorStyle(hex: string): CSSProperties {
  let style = styles.get(hex);
  if (!style) {
    const light = readableOn(hex, LIGHT_BACKGROUND, { tint: LIGHT_TINT });
    const dark = readableOn(hex, DARK_BACKGROUND, { tint: DARK_TINT });
    style = {
      "--ac-l": light,
      "--ac-d": dark,
      "--ac-on-l": textOn(light),
      "--ac-on-d": textOn(dark),
    } as CSSProperties;
    styles.set(hex, style);
  }
  return style;
}

/** アカウントの色の変数 (accountColorStyle) を持つ要素か、その中で使うクラス。 */
/** 点などの塗り。 */
export const ACCOUNT_DOT_CLASS = "bg-(--ac-l) dark:bg-(--ac-d)";
/** アイコンの色。 */
export const ACCOUNT_TEXT_CLASS = "text-(--ac-l) dark:text-(--ac-d)";
/** アイコンの背景 (同じ色を薄めたもの)。 */
export const ACCOUNT_TINT_CLASS = "bg-(--ac-l)/15 dark:bg-(--ac-d)/20";
/** 塗りの上に置く文字の色。 */
export const ACCOUNT_ON_CLASS = "text-(--ac-on-l) dark:text-(--ac-on-d)";

/** 最近使った色を覚えておく場所 (端末ごと)。 */
export const RECENT_COLORS_KEY = "mail.account-color-recent.v1";
