"use client";

import { cn } from "cn";
import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import { MailboxMark } from "@/components/mail/mailbox-icon";
import { AccountMark } from "@/lib/account-icons";
import type { Account, MailboxSummary } from "@/lib/api";
import { type MailboxNode, mailboxLabel } from "@/lib/mailboxes";

/**
 * 折りたたんだサイドバーの帯から右に出すポップアップの中身。
 * アカウントやカテゴリの中の、フォルダなどの深い階層までをここで選べる。
 * 並び替えや右クリックメニューは持たない (広げたサイドバーで行う)。
 */

const COLLAPSED_KEY = "mail.sidebar-collapsed";

/** サイドバーで折りたたんでいるアカウントとフォルダ。ポップアップの開き方の初期値に使う。 */
function loadCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(COLLAPSED_KEY) ?? "[]",
    );
    if (Array.isArray(saved)) {
      return new Set(saved.filter((id) => typeof id === "string"));
    }
  } catch {
    // 読めなければ、すべて開いた状態で始める。
  }
  return new Set();
}

/**
 * ポップアップの中で開閉した状態。ポップアップを開くたびにサイドバーの状態から始め、
 * サイドバーの開閉には書き戻さない。
 * closedByDefault の ID は、サイドバーの状態に関係なく閉じた状態から始める (カテゴリの中のアカウント)。
 */
export function useFlyoutCollapsed(closedByDefault: readonly string[] = []) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const initial = loadCollapsed();
    for (const id of closedByDefault) initial.add(id);
    return initial;
  });
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return { collapsed, toggle };
}

export type FlyoutSelection = {
  /** フォルダの一覧を表示している (下書きやスター付きなどではない)。 */
  folderView: boolean;
  selectedAccountId: string | null;
  selectedMailboxId: string | null;
};

function UnreadCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 font-medium text-muted-foreground text-xs tabular-nums leading-5">
      <span className="sr-only">未読 </span>
      {count > 9999 ? "9999+" : count}
    </span>
  );
}

/** 開閉の矢印。中身が無い項目では、列を揃えるために同じ幅だけ空ける。 */
function FlyoutToggle({
  open,
  label,
  onClick,
}: {
  open: boolean;
  label: string;
  onClick: (() => void) | null;
}) {
  if (!onClick) return <span className="size-5 shrink-0" aria-hidden="true" />;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${label}を${open ? "折りたたむ" : "開く"}`}
      onClick={onClick}
      className="relative flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn("size-3.5 transition-transform", open && "rotate-90")}
      />
    </button>
  );
}

/** ポップアップの 1 行 (押すとその場所を開く)。 */
export function FlyoutRow({
  icon,
  label,
  sublabel,
  count = 0,
  selected,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string | undefined;
  count?: number;
  selected: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      title={label}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-left text-sm pointer-coarse:min-h-11 outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
        selected && "bg-accent font-medium text-accent-foreground",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sublabel && (
          <span className="block truncate font-normal text-muted-foreground text-xs">
            {sublabel}
          </span>
        )}
      </span>
      <UnreadCount count={count} />
    </button>
  );
}

function FolderTree({
  nodes,
  depth,
  collapsed,
  onToggle,
  isSelected,
  onSelect,
}: {
  nodes: MailboxNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  isSelected: (mailbox: MailboxSummary) => boolean;
  onSelect: (mailbox: MailboxSummary) => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => {
        const { mailbox } = node;
        const hasChildren = node.children.length > 0;
        const open = hasChildren && !collapsed.has(mailbox.id);
        const label = mailboxLabel(mailbox);
        return (
          <li key={mailbox.id}>
            <div
              className="flex items-center"
              style={{ paddingLeft: `${depth * 0.75}rem` }}
            >
              <FlyoutToggle
                open={open}
                label={label}
                onClick={hasChildren ? () => onToggle(mailbox.id) : null}
              />
              <FlyoutRow
                icon={
                  <MailboxMark
                    mailbox={mailbox}
                    className="text-muted-foreground"
                  />
                }
                label={label}
                // 折りたたんでいる間は、中のフォルダの未読も合わせて表示する。
                count={open ? mailbox.unreadCount : node.unreadTotal}
                selected={isSelected(mailbox)}
                onClick={() => onSelect(mailbox)}
              />
            </div>
            {open && (
              <FolderTree
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                isSelected={isSelected}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

const problemLabel: Partial<Record<Account["status"], string>> = {
  auth_required: "再ログインが必要です",
  error: "同期でエラーが発生しています",
  disabled: "同期を停止しています",
};

/**
 * アカウント 1 件分 (名前の行と、その下のフォルダのツリー)。
 * 名前の行を押すとアカウント全体 (受信トレイ) を開く。
 */
export function FlyoutAccount({
  account,
  accounts,
  tree,
  unread,
  selection,
  collapsed,
  onToggle,
  onSelect,
}: {
  account: Account;
  /** 色を決めるのに使う、すべてのアカウント。 */
  accounts: Account[];
  tree: MailboxNode[];
  /** 受信トレイの未読数。 */
  unread: number;
  selection: FlyoutSelection;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (accountId: string, mailboxId: string | null) => void;
}) {
  const name = account.displayName || account.email;
  const open = tree.length > 0 && !collapsed.has(account.id);
  const problem = problemLabel[account.status];
  const here =
    selection.folderView && selection.selectedAccountId === account.id;
  return (
    <section aria-label={name} className="flex flex-col gap-0.5">
      <div className="flex items-center">
        <FlyoutToggle
          open={open}
          label={`${name} のフォルダ`}
          onClick={tree.length > 0 ? () => onToggle(account.id) : null}
        />
        <FlyoutRow
          icon={
            problem ? (
              <CircleAlertIcon
                className="text-destructive"
                aria-label={problem}
              />
            ) : (
              <AccountMark accounts={accounts} account={account} />
            )
          }
          label={name}
          sublabel={
            problem ?? (account.displayName ? account.email : undefined)
          }
          count={open ? 0 : unread}
          selected={
            here &&
            selection.selectedMailboxId === null &&
            (!open || tree.length === 0)
          }
          onClick={() => onSelect(account.id, null)}
        />
      </div>
      {open && (
        <FolderTree
          nodes={tree}
          depth={1}
          collapsed={collapsed}
          onToggle={onToggle}
          isSelected={(mailbox) =>
            here &&
            (selection.selectedMailboxId === null
              ? mailbox.specialUse === "inbox"
              : selection.selectedMailboxId === mailbox.id)
          }
          onSelect={(mailbox) =>
            onSelect(
              account.id,
              mailbox.specialUse === "inbox" ? null : mailbox.id,
            )
          }
        />
      )}
    </section>
  );
}

/** ポップアップ全体の枠。中が長いときは、ポップアップの中だけをスクロールする。 */
export const FLYOUT_CLASS =
  "w-72 max-h-(--available-height) gap-0.5 overflow-y-auto p-1.5";
