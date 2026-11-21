"use client";

import { cn } from "cn";
import {
  ArchiveIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FilePenLineIcon,
  FolderIcon,
  InboxIcon,
  LogOutIcon,
  MailIcon,
  MailsIcon,
  OctagonAlertIcon,
  PlusIcon,
  SendIcon,
  SignatureIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Account, MailboxSummary, User } from "@/lib/api";
import {
  buildMailboxTree,
  type MailboxNode,
  mailboxLabel,
} from "@/lib/mailboxes";

const statusLabel: Partial<Record<Account["status"], string>> = {
  auth_required: "再ログインが必要です",
  error: "同期でエラーが発生しています",
  disabled: "同期を停止しています",
};

const folderIcons: Record<
  NonNullable<MailboxSummary["specialUse"]>,
  React.ReactNode
> = {
  inbox: <InboxIcon />,
  flagged: <StarIcon />,
  drafts: <FilePenLineIcon />,
  sent: <SendIcon />,
  archive: <ArchiveIcon />,
  all: <MailsIcon />,
  junk: <OctagonAlertIcon />,
  trash: <Trash2Icon />,
};

const COLLAPSED_KEY = "mail.sidebar-collapsed";

/** 折りたたんだアカウントとフォルダの ID。端末ごとに覚えておく。 */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(
        window.localStorage.getItem(COLLAPSED_KEY) ?? "[]",
      );
      if (Array.isArray(saved)) {
        setCollapsed(new Set(saved.filter((id) => typeof id === "string")));
      }
    } catch {
      // 読めなければ、すべて開いた状態で始める。
    }
  }, []);
  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 保存できなくても、このページを開いている間は有効。
      }
      return next;
    });
  };
  return { collapsed, toggle };
}

type Props = {
  user: User;
  accounts: Account[] | null;
  /** 全アカウントのフォルダ。読み込み前は null。 */
  mailboxes: MailboxSummary[] | null;
  /** null は「すべての受信トレイ」。 */
  selectedAccountId: string | null;
  /** null は受信トレイ (アカウントを選んでいればそのアカウントの受信トレイ)。 */
  selectedMailboxId: string | null;
  onSelect: (accountId: string | null, mailboxId: string | null) => void;
  /** サーバーに保存してある下書きの数 (全アカウント分)。 */
  draftCount: number;
  /** 下書きの一覧を表示している。その間はフォルダを選択中として扱わない。 */
  draftsSelected: boolean;
  onSelectDrafts: () => void;
  onAdd: () => void;
  onDelete: (account: Account) => void;
  /** アカウントの署名を編集する。 */
  onEditSignature: (account: Account) => void;
  /** 再ログインが必要な Microsoft アカウントで、ログインし直す。 */
  onReauth: (account: Account) => void;
  onSignOut: () => void;
};

export function AccountSidebar({
  user,
  accounts,
  mailboxes,
  selectedAccountId,
  selectedMailboxId,
  onSelect,
  draftCount,
  draftsSelected,
  onSelectDrafts,
  onAdd,
  onDelete,
  onEditSignature,
  onReauth,
  onSignOut,
}: Props) {
  const { collapsed, toggle } = useCollapsed();
  const trees = useMemo(() => {
    const byAccount = new Map<string, MailboxSummary[]>();
    for (const mailbox of mailboxes ?? []) {
      const list = byAccount.get(mailbox.accountId);
      if (list) list.push(mailbox);
      else byAccount.set(mailbox.accountId, [mailbox]);
    }
    return new Map(
      [...byAccount].map(([accountId, list]) => [
        accountId,
        buildMailboxTree(list),
      ]),
    );
  }, [mailboxes]);
  const inboxUnread = (mailboxes ?? []).reduce(
    (sum, mailbox) =>
      mailbox.specialUse === "inbox" ? sum + mailbox.unreadCount : sum,
    0,
  );

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-4">
        <span className="font-heading font-semibold text-xl tracking-tight">
          Mail
        </span>
      </div>

      <nav
        aria-label="メールアカウントとフォルダ"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1"
      >
        <SidebarItem
          icon={<InboxIcon />}
          label="すべての受信トレイ"
          count={inboxUnread}
          selected={!draftsSelected && selectedAccountId === null}
          onClick={() => onSelect(null, null)}
        />
        <SidebarItem
          icon={<FilePenLineIcon />}
          label="下書き"
          count={draftCount}
          countLabel="件数"
          selected={draftsSelected}
          onClick={onSelectDrafts}
        />
        {accounts === null ? (
          <div className="flex flex-col gap-2 px-2 py-2" aria-hidden="true">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-32" />
          </div>
        ) : (
          accounts.map((account) => {
            const problem = statusLabel[account.status];
            const tree = trees.get(account.id) ?? [];
            const open = !collapsed.has(account.id);
            const selected =
              !draftsSelected && selectedAccountId === account.id;
            const name = account.displayName || account.email;
            return (
              <div key={account.id} className="group/account relative">
                <div className="flex items-start">
                  <ToggleButton
                    open={open}
                    label={`${name} のフォルダ`}
                    onClick={() => toggle(account.id)}
                    className="mt-2"
                  />
                  <SidebarItem
                    icon={
                      problem ? (
                        <CircleAlertIcon className="text-destructive" />
                      ) : (
                        <MailIcon />
                      )
                    }
                    label={name}
                    sublabel={account.displayName ? account.email : undefined}
                    problem={
                      problem
                        ? account.lastError
                          ? `${problem}: ${account.lastError}`
                          : problem
                        : undefined
                    }
                    // フォルダを表示している間は、選択中のフォルダの行を強調する。
                    selected={
                      selected &&
                      (!open || tree.length === 0) &&
                      selectedMailboxId === null
                    }
                    onClick={() => onSelect(account.id, null)}
                    className="min-w-0 flex-1 pr-16 pl-1"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${account.email} の署名を編集`}
                  title="署名を編集"
                  onClick={() => onEditSignature(account)}
                  className="absolute top-2 right-8 opacity-0 focus-visible:opacity-100 group-hover/account:opacity-100 pointer-coarse:opacity-100"
                >
                  <SignatureIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${account.email} を削除`}
                  onClick={() => onDelete(account)}
                  className="absolute top-2 right-1.5 opacity-0 focus-visible:opacity-100 group-hover/account:opacity-100 pointer-coarse:opacity-100"
                >
                  <Trash2Icon />
                </Button>
                {account.status === "auth_required" &&
                  account.protocol === "graph" && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => onReauth(account)}
                      className="mt-1 mb-2 ml-8"
                    >
                      Microsoft にログインし直す
                    </Button>
                  )}
                {open && tree.length > 0 && (
                  <FolderList
                    nodes={tree}
                    depth={1}
                    collapsed={collapsed}
                    onToggle={toggle}
                    isSelected={(mailbox) =>
                      selected &&
                      (selectedMailboxId === null
                        ? mailbox.specialUse === "inbox"
                        : selectedMailboxId === mailbox.id)
                    }
                    onSelect={(mailbox) =>
                      onSelect(
                        account.id,
                        mailbox.specialUse === "inbox" ? null : mailbox.id,
                      )
                    }
                  />
                )}
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

/** 開閉の切り替え。open で下向き、閉じていれば右向きの矢印になる。 */
function ToggleButton(props: {
  open: boolean;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-label={`${props.label}を${props.open ? "折りたたむ" : "開く"}`}
      onClick={props.onClick}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        props.className,
      )}
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 transition-transform",
          props.open && "rotate-90",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function UnreadCount({
  count,
  label = "未読",
}: {
  count: number;
  label?: string | undefined;
}) {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 font-medium text-muted-foreground text-xs tabular-nums">
      <span className="sr-only">{label} </span>
      {count > 9999 ? "9999+" : count}
    </span>
  );
}

function FolderList(props: {
  nodes: MailboxNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  isSelected: (mailbox: MailboxSummary) => boolean;
  onSelect: (mailbox: MailboxSummary) => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.nodes.map((node) => {
        const { mailbox } = node;
        const hasChildren = node.children.length > 0;
        const open = hasChildren && !props.collapsed.has(mailbox.id);
        const selected = props.isSelected(mailbox);
        const label = mailboxLabel(mailbox);
        return (
          <li key={mailbox.id}>
            <div
              className="flex items-center"
              style={{ paddingLeft: `${props.depth * 0.75}rem` }}
            >
              {hasChildren ? (
                <ToggleButton
                  open={open}
                  label={label}
                  onClick={() => props.onToggle(mailbox.id)}
                />
              ) : (
                <span className="size-5 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => props.onSelect(mailbox)}
                aria-current={selected ? "page" : undefined}
                title={label}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                  selected &&
                    "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                )}
              >
                {(mailbox.specialUse && folderIcons[mailbox.specialUse]) || (
                  <FolderIcon />
                )}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {/* 折りたたんでいる間は、中のフォルダの未読も合わせて表示する。 */}
                <UnreadCount
                  count={open ? mailbox.unreadCount : node.unreadTotal}
                />
              </button>
            </div>
            {open && (
              <FolderList
                {...props}
                nodes={node.children}
                depth={props.depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SidebarItem(props: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string | undefined;
  problem?: string | undefined;
  /** 未読数。0 なら表示しない。 */
  count?: number;
  /** 数が未読数でないときの、読み上げ用の説明。 */
  countLabel?: string;
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
      {props.count !== undefined && (
        <UnreadCount count={props.count} label={props.countLabel} />
      )}
    </button>
  );
}
