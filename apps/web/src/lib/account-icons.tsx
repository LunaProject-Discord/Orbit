import { cn } from "cn";
import {
  BellIcon,
  BookIcon,
  BriefcaseIcon,
  Building2Icon,
  CameraIcon,
  CodeIcon,
  Gamepad2Icon,
  GlobeIcon,
  GraduationCapIcon,
  HeartIcon,
  HomeIcon,
  type LucideIcon,
  MailIcon,
  MusicIcon,
  PlaneIcon,
  ShoppingCartIcon,
  StarIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
  WrenchIcon,
} from "lucide-react";
import { ACCOUNT_COLORS, accountColorName } from "@/lib/account-colors";
import type { Account } from "@/lib/api";

/**
 * アカウントに付けられるアイコン。名前は API (apps/api の accounts.ts) と揃える。
 * 選んでいないアカウントには、色の点を出す。
 */
export const ACCOUNT_ICONS = [
  { name: "mail", label: "メール", icon: MailIcon },
  { name: "user", label: "個人", icon: UserIcon },
  { name: "users", label: "グループ", icon: UsersIcon },
  { name: "briefcase", label: "仕事", icon: BriefcaseIcon },
  { name: "building", label: "会社", icon: Building2Icon },
  { name: "home", label: "家", icon: HomeIcon },
  { name: "graduation-cap", label: "学校", icon: GraduationCapIcon },
  { name: "heart", label: "ハート", icon: HeartIcon },
  { name: "star", label: "星", icon: StarIcon },
  { name: "shopping-cart", label: "買い物", icon: ShoppingCartIcon },
  { name: "wallet", label: "お金", icon: WalletIcon },
  { name: "code", label: "開発", icon: CodeIcon },
  { name: "gamepad", label: "ゲーム", icon: Gamepad2Icon },
  { name: "globe", label: "地球", icon: GlobeIcon },
  { name: "book", label: "本", icon: BookIcon },
  { name: "music", label: "音楽", icon: MusicIcon },
  { name: "camera", label: "カメラ", icon: CameraIcon },
  { name: "plane", label: "旅行", icon: PlaneIcon },
  { name: "wrench", label: "道具", icon: WrenchIcon },
  { name: "bell", label: "お知らせ", icon: BellIcon },
] as const satisfies readonly {
  name: string;
  label: string;
  icon: LucideIcon;
}[];

export type AccountIconName = (typeof ACCOUNT_ICONS)[number]["name"];

/** 名前に対応するアイコン。選んでいない、または知らない名前なら null。 */
export function accountIconOf(name: string | null): LucideIcon | null {
  return ACCOUNT_ICONS.find((item) => item.name === name)?.icon ?? null;
}

/**
 * アカウントの印。アイコンを選んでいればアカウントの色のアイコン、
 * 選んでいなければ、アイコンと同じ幅の枠の中央に色の点を出す。
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
  const Icon = accountIconOf(account.icon);
  if (Icon) {
    return (
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", color?.text, className)}
      />
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
