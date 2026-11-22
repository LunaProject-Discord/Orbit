import { cn } from "cn";
import { ACCOUNT_COLORS, accountColorName } from "@/lib/account-colors";
import type { Account } from "@/lib/api";
import { EMOJI_FONT_FAMILY, isEmojiIcon } from "@/lib/emoji/emoji";
import { LucideSvg, useIconNode } from "@/lib/lucide/icons";

/**
 * アカウントに付けられるアイコン。Lucide のアイコンの名前 (house、briefcase など) か、
 * 絵文字そのもの (🏠 など)。選んでいないアカウントには、色の点を出す。
 */
export type AccountIconName = string;

/**
 * アカウントの印。アイコンを選んでいればアカウントの色のアイコン、絵文字ならその絵文字、
 * 選んでいない (または無くなった名前の) ときは、アイコンと同じ幅の枠の中央に色の点を出す。
 */
export function AccountMark({
  accounts,
  account,
  className,
}: {
  accounts: readonly Pick<Account, "id" | "color" | "createdAt">[];
  account: Pick<Account, "id" | "icon">;
  className?: string;
}) {
  const name = accountColorName(accounts, account.id);
  const color = ACCOUNT_COLORS.find((item) => item.name === name);
  const emoji =
    account.icon !== null && isEmojiIcon(account.icon) ? account.icon : null;
  const node = useIconNode(emoji ? null : account.icon);
  if (emoji) {
    return (
      <span
        aria-hidden="true"
        style={{ fontFamily: EMOJI_FONT_FAMILY }}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center overflow-hidden text-sm leading-none",
          className,
        )}
      >
        {emoji}
      </span>
    );
  }
  if (node) {
    return (
      <LucideSvg
        node={node}
        className={cn("size-4 shrink-0", color?.text, className)}
      />
    );
  }
  // 図形を読み込んでいる間は、点を出さずに場所だけ空けておく (点からアイコンへ変わって見えないように)。
  if (node === undefined) {
    return (
      <span aria-hidden="true" className={cn("size-4 shrink-0", className)} />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", color?.dot)} />
    </span>
  );
}
