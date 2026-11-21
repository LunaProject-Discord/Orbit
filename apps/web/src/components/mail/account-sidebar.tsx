"use client";

import { cn } from "cn";
import {
  CircleAlertIcon,
  InboxIcon,
  LogOutIcon,
  MailIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Account, User } from "@/lib/api";

const statusLabel: Partial<Record<Account["status"], string>> = {
  auth_required: "再ログインが必要です",
  error: "同期でエラーが発生しています",
  disabled: "同期を停止しています",
};

type Props = {
  user: User;
  accounts: Account[] | null;
  /** null は「すべての受信トレイ」。 */
  selectedAccountId: string | null;
  onSelect: (accountId: string | null) => void;
  onAdd: () => void;
  onDelete: (account: Account) => void;
  onSignOut: () => void;
};

export function AccountSidebar({
  user,
  accounts,
  selectedAccountId,
  onSelect,
  onAdd,
  onDelete,
  onSignOut,
}: Props) {
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-4">
        <span className="font-heading font-semibold text-xl tracking-tight">
          Mail
        </span>
      </div>

      <nav
        aria-label="メールアカウント"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1"
      >
        <SidebarItem
          icon={<InboxIcon />}
          label="すべての受信トレイ"
          selected={selectedAccountId === null}
          onClick={() => onSelect(null)}
        />
        {accounts === null ? (
          <div className="flex flex-col gap-2 px-2 py-2" aria-hidden="true">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-32" />
          </div>
        ) : (
          accounts.map((account) => {
            const problem = statusLabel[account.status];
            return (
              <div key={account.id} className="group/account relative">
                <SidebarItem
                  icon={
                    problem ? (
                      <CircleAlertIcon className="text-destructive" />
                    ) : (
                      <MailIcon />
                    )
                  }
                  label={account.displayName || account.email}
                  sublabel={account.displayName ? account.email : undefined}
                  problem={
                    problem
                      ? account.lastError
                        ? `${problem}: ${account.lastError}`
                        : problem
                      : undefined
                  }
                  selected={selectedAccountId === account.id}
                  onClick={() => onSelect(account.id)}
                  className="pr-9"
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${account.email} を削除`}
                  onClick={() => onDelete(account)}
                  className="absolute top-2 right-1.5 opacity-0 focus-visible:opacity-100 group-hover/account:opacity-100 pointer-coarse:opacity-100"
                >
                  <Trash2Icon />
                </Button>
              </div>
            );
          })
        )}
        <Button
          variant="ghost"
          onClick={onAdd}
          className="mt-1 justify-start gap-2 px-2 text-muted-foreground"
        >
          <PlusIcon />
          アカウントを追加
        </Button>
      </nav>

      <div className="flex shrink-0 items-center gap-2 border-t p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">{user.name}</p>
          <p className="truncate text-muted-foreground text-xs">{user.email}</p>
        </div>
        <ThemeToggle />
        <Button
          variant="outline"
          size="icon"
          aria-label="ログアウト"
          title="ログアウト"
          onClick={onSignOut}
        >
          <LogOutIcon />
        </Button>
      </div>
    </div>
  );
}

function SidebarItem(props: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string | undefined;
  problem?: string | undefined;
  selected: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.selected ? "page" : undefined}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
        props.selected &&
          "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        props.className,
      )}
    >
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.label}</span>
        {props.sublabel && (
          <span className="block truncate font-normal text-muted-foreground text-xs">
            {props.sublabel}
          </span>
        )}
        {props.problem && (
          <span className="mt-0.5 line-clamp-3 block font-normal text-destructive text-xs">
            {props.problem}
          </span>
        )}
      </span>
    </button>
  );
}
