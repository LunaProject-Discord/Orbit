import { cn } from "cn";
import {
  ACCOUNT_COLORS,
  accountColor,
  accountColorName,
} from "@/lib/account-colors";
import type { Account } from "@/lib/api";
import { EMOJI_FONT_FAMILY, isEmojiIcon } from "@/lib/emoji/emoji";
import { LucideSvg, useIconNode } from "@/lib/lucide/icons";
import { usePreferences } from "@/lib/preferences";

/**
 * アカウントに付けられるアイコン。Lucide のアイコンの名前 (house、briefcase など) か、
 * 絵文字そのもの (🏠 など)。選んでいないアカウントには、色の点を出す。
 */
export type AccountIconName = string;

const SIZES = {
  /** サイドバーや設定画面。 */
  md: { box: "size-6 rounded-md", icon: "size-4", emoji: "text-sm" },
  /** メールの一覧など、文字の横に小さく出すとき。 */
  sm: { box: "size-5 rounded", icon: "size-3.5", emoji: "text-xs" },
} as const;

/**
 * アカウントの印。アイコンか絵文字を選んでいれば、アカウントの色を薄めた背景の上に、
 * アカウントの色のアイコン (絵文字はそのままの色) を出す。
 * 選んでいない (または無くなった名前の) ときは、背景を付けずに色の点を出す。
 */
export function AccountMark({
  accounts,
  account,
  size = "md",
  className,
}: {
  accounts: readonly Pick<Account, "id" | "color" | "createdAt">[];
  account: Pick<Account, "id" | "icon">;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const name = accountColorName(accounts, account.id);
  const color = ACCOUNT_COLORS.find((item) => item.name === name);
  const emoji =
    account.icon !== null && isEmojiIcon(account.icon) ? account.icon : null;
  const node = useIconNode(emoji ? null : account.icon);
  const sizes = SIZES[size];
  const box = cn(
    "flex shrink-0 items-center justify-center",
    sizes.box,
    color?.tint,
    className,
  );
  if (emoji) {
    return (
      <span aria-hidden="true" className={cn(box, "overflow-hidden")}>
        <span
          style={{ fontFamily: EMOJI_FONT_FAMILY }}
          className={cn("leading-none", sizes.emoji)}
        >
          {emoji}
        </span>
      </span>
    );
  }
  // 図形を読み込んでいる間 (undefined) は、背景だけを出しておく (点からアイコンへ変わって見えないように)。
  if (node !== null) {
    return (
      <span aria-hidden="true" className={box}>
        {node && (
          <LucideSvg node={node} className={cn(sizes.icon, color?.text)} />
        )}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "md" ? "size-6" : "size-2",
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", color?.dot)} />
    </span>
  );
}

/**
 * 複数のアカウントのメールが並ぶ所で、どのアカウントのものかを示す小さな印。
 * 設定 (一覧の表示 → アカウントの印の見た目) が「設定したアイコン」で、アイコンか絵文字を
 * 選んでいるアカウントなら、その印を出す。それ以外は色の点を出す。
 */
export function AccountListMark({
  accounts,
  account,
  dotClass = "size-2",
  className,
}: {
  accounts: readonly Pick<Account, "id" | "color" | "createdAt">[];
  account: Pick<Account, "id" | "icon">;
  /** 色の点の大きさ。 */
  dotClass?: string;
  className?: string;
}) {
  const { accountMarkStyle } = usePreferences();
  if (accountMarkStyle === "icon" && account.icon !== null) {
    return (
      <AccountMark
        accounts={accounts}
        account={account}
        size="sm"
        className={className}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "shrink-0 rounded-full",
        dotClass,
        accountColor(accounts, account.id),
        className,
      )}
    />
  );
}
