"use client";

import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  OrbitAppIcon,
  type OrbitProduct,
  OrbitStackedLogo,
} from "@/components/brand/orbit-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MAIL_PATH, navigateApp } from "@/lib/app-navigation";
import { CALENDAR_PATH } from "@/lib/calendar/route";

const APPS: {
  product: OrbitProduct;
  label: string;
  sub: string;
  path: string | null;
}[] = [
  { product: "mail", label: "Mail", sub: "メール", path: MAIL_PATH },
  {
    product: "calendar",
    label: "Calendar",
    sub: "カレンダー",
    path: CALENDAR_PATH,
  },
  // 連絡先はまだ無い。
  { product: "contacts", label: "Contacts", sub: "準備中", path: null },
];

/**
 * ロゴと下向きの矢印を 1 つのボタンにして、押すとアプリ (メール・カレンダー・連絡先) を
 * 切り替えるメニューを出す。
 */
export function AppSwitcher({
  current,
  className,
  logoClassName = "h-6",
  onNavigate,
}: {
  current: OrbitProduct;
  className?: string;
  logoClassName?: string;
  /** 切り替える前に呼ぶ (スマホのサイドバーを閉じるなど)。 */
  onNavigate?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="アプリを切り替える"
        className={cn(
          "flex h-9 items-center gap-1 rounded-md pr-1.5 pl-2 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent",
          className,
        )}
      >
        <OrbitStackedLogo product={current} className={logoClassName} />
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="start">
        {APPS.map((app) => (
          <DropdownMenuItem
            key={app.product}
            disabled={app.path === null}
            className="gap-3 py-2"
            onClick={() => {
              if (!app.path || app.product === current) return;
              onNavigate?.();
              navigateApp(app.path);
            }}
          >
            <OrbitAppIcon product={app.product} className="size-8" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-sm">{app.label}</span>
              <span className="block text-muted-foreground text-xs">
                {app.sub}
              </span>
            </span>
            {app.product === current && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
