"use client";

import { ChevronDownIcon, PenSquareIcon } from "lucide-react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountMark } from "@/lib/account-icons";
import type { Account } from "@/lib/api";

/** 新しいメールを書き始める。accountId を省くと、いま選んでいるアカウント (無ければ先頭)。 */
export type ComposeHandler = (accountId?: string) => void;

const MENU_TITLE = "差出人を選んで新規作成";

/** メニューの 1 行に出す、アカウントの印・名前・アドレス。 */
function AccountLabel({
  account,
  accounts,
}: {
  account: Account;
  accounts: Account[];
}) {
  const name = account.displayName || account.email;
  return (
    <>
      <AccountMark accounts={accounts} account={account} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{name}</span>
        {account.displayName && (
          <span className="truncate text-muted-foreground text-xs">
            {account.email}
          </span>
        )}
      </span>
    </>
  );
}

/** 右クリックメニュー版の、差出人の一覧。 */
function ContextAccountItems({
  accounts,
  onCompose,
}: {
  accounts: Account[];
  onCompose: ComposeHandler;
}) {
  return (
    <ContextMenuGroup>
      <ContextMenuLabel>{MENU_TITLE}</ContextMenuLabel>
      {accounts.map((account) => (
        <ContextMenuItem key={account.id} onClick={() => onCompose(account.id)}>
          <AccountLabel account={account} accounts={accounts} />
        </ContextMenuItem>
      ))}
    </ContextMenuGroup>
  );
}

/**
 * サイドバーの「新規作成」ボタン。アカウントが 2 つ以上あれば、右側の ▼ と
 * 右クリックから差出人のアカウントを選んで書き始められる (スプリットボタン)。
 */
export function ComposeButton({
  accounts,
  onCompose,
}: {
  accounts: Account[];
  onCompose: ComposeHandler;
}) {
  const choosable = accounts.length > 1;
  const main = (
    <Hint label="新規作成" shortcut="C">
      <Button
        onClick={() => onCompose()}
        className={
          choosable
            ? "min-w-0 flex-1 justify-center gap-2 rounded-r-none"
            : "w-full justify-center gap-2"
        }
      >
        <PenSquareIcon />
        新規作成
      </Button>
    </Hint>
  );
  if (!choosable) return main;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex w-full" />}>
        {main}
        <DropdownMenu>
          <Hint label="差出人を選ぶ">
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon"
                  aria-label={MENU_TITLE}
                  // 左の部分との間に、ボタンの文字色を薄くした区切り線を引く。
                  className="shrink-0 rounded-l-none border-l border-l-primary-foreground/25"
                />
              }
            >
              <ChevronDownIcon />
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{MENU_TITLE}</DropdownMenuLabel>
              {accounts.map((account) => (
                <DropdownMenuItem
                  key={account.id}
                  onClick={() => onCompose(account.id)}
                >
                  <AccountLabel account={account} accounts={accounts} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextAccountItems accounts={accounts} onCompose={onCompose} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 折りたたみ中の帯の「新規作成」ボタン。アカウントが 2 つ以上あれば、
 * 右クリックで差出人のアカウントを選んで書き始められる。
 */
export function RailComposeButton({
  accounts,
  onCompose,
}: {
  accounts: Account[];
  onCompose: ComposeHandler;
}) {
  const button = (
    <Hint label="新規作成" shortcut="C" side="right">
      <Button size="icon" onClick={() => onCompose()} aria-label="新規作成">
        <PenSquareIcon />
      </Button>
    </Hint>
  );
  if (accounts.length < 2) return button;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex" />}>
        {button}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextAccountItems accounts={accounts} onCompose={onCompose} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
