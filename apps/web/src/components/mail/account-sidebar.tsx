"use client";

import {
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type Account,
  type MailboxSummary,
  oauthProviderOf,
  type User,
} from "@/lib/api";
import {
  buildMailboxTree,
  type MailboxNode,
  mailboxLabel,
  moveBy,
  moveTo,
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

/** 並び替えられる項目に持たせる情報。同じ group の中でだけ順番を入れ替えられる。 */
type SortData = {
  group: string;
  /** 同じ group の項目の ID (いまの表示順)。 */
  ids: string[];
  kind: "account" | "mailbox";
  /** 読み上げに使う名前。 */
  label: string;
};

const ACCOUNT_GROUP = "accounts";

/** ドラッグ中の項目と同じ並びの項目だけを、入れ替え先の候補にする。 */
const sameGroup: CollisionDetection = (args) => {
  const group = (args.active.data.current as SortData | undefined)?.group;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) =>
        (container.data.current as SortData | undefined)?.group === group,
    ),
  });
};

const labelOf = (item: { data: { current?: unknown } }) =>
  (item.data.current as SortData | undefined)?.label ?? "";

/** ドラッグ中の読み上げ。移動した結果は、キーボードでの移動と同じ文言で別に知らせる。 */
const dragAnnouncements: Announcements = {
  onDragStart: ({ active }) => `${labelOf(active)} を動かしています`,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: ({ active }) => `${labelOf(active)} の移動を取り消しました`,
};

/** ドラッグできる項目。行のボタンに付ける属性と、キーボードでの並び替えを用意する。 */
function useSortableItem(
  id: string,
  data: SortData,
  onMove: (data: SortData, ids: string[], id: string) => void,
) {
  const sortable = useSortable({ id, data });
  return {
    setNodeRef: sortable.setNodeRef,
    isDragging: sortable.isDragging,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
    },
    handle: {
      ...sortable.listeners,
      "data-sort-id": id,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      onKeyDown: (event: React.KeyboardEvent) => {
        if (!event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const ids = moveBy(data.ids, id, event.key === "ArrowUp" ? -1 : 1);
        if (ids) onMove(data, ids, id);
      },
    },
  };
}

type SortHandle = ReturnType<typeof useSortableItem>["handle"];

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
  /** アカウントを並び替えた。ids は新しい表示順。 */
  onReorderAccounts: (ids: string[]) => void;
  /** 同じ親を持つフォルダを並び替えた。ids は新しい表示順。 */
  onReorderMailboxes: (ids: string[]) => void;
  onAdd: () => void;
  onDelete: (account: Account) => void;
  /** アカウントの署名を編集する。 */
  onEditSignature: (account: Account) => void;
  /** 再ログインが必要な Google / Microsoft のアカウントで、ログインし直す。 */
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
  onReorderAccounts,
  onReorderMailboxes,
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

  const sensors = useSensors(
    // クリックや画面のスクロールと区別するため、少し動かすか長押しでドラッグを始める。
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );
  const [announcement, setAnnouncement] = useState("");
  /** ドラッグの直後に起きるクリックで、フォルダが開かないようにする。 */
  const draggedRef = useRef(false);
  /** キーボードで動かした項目。並び替えの後もフォーカスを保つ。 */
  const refocusRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 並びが変わるたびにフォーカスを戻す。
  useEffect(() => {
    const id = refocusRef.current;
    if (!id) return;
    refocusRef.current = null;
    document.querySelector<HTMLElement>(`[data-sort-id="${id}"]`)?.focus();
  }, [accounts, mailboxes]);

  const move = (data: SortData, ids: string[], id: string) => {
    if (data.kind === "account") onReorderAccounts(ids);
    else onReorderMailboxes(ids);
    setAnnouncement(
      `${data.label} を ${ids.length} 件中 ${ids.indexOf(id) + 1} 番目に移動しました`,
    );
  };
  const moveByKeyboard: typeof move = (data, ids, id) => {
    refocusRef.current = id;
    move(data, ids, id);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setTimeout(() => {
      draggedRef.current = false;
    }, 0);
    const data = active.data.current as SortData | undefined;
    if (!data || !over) return;
    const ids = moveTo(data.ids, String(active.id), String(over.id));
    if (ids) move(data, ids, String(active.id));
  };
  const accountIds = (accounts ?? []).map((account) => account.id);

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
        onClickCapture={(event) => {
          if (!draggedRef.current) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <SidebarItem
          icon={<InboxIcon />}
          label="すべての受信トレイ"
          count={inboxUnread}
          selected={selectedAccountId === null}
          onClick={() => onSelect(null, null)}
        />
        {accounts === null ? (
          <div className="flex flex-col gap-2 px-2 py-2" aria-hidden="true">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-32" />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={sameGroup}
            modifiers={[restrictToVerticalAxis]}
            accessibility={{ announcements: dragAnnouncements }}
            onDragStart={() => {
              draggedRef.current = true;
            }}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              draggedRef.current = false;
            }}
          >
            <SortableContext
              items={accountIds}
              strategy={verticalListSortingStrategy}
            >
              {accounts.map((account) => (
                <AccountItem
                  key={account.id}
                  account={account}
                  accountIds={accountIds}
                  tree={trees.get(account.id) ?? []}
                  collapsed={collapsed}
                  onToggle={toggle}
                  selected={selectedAccountId === account.id}
                  selectedMailboxId={selectedMailboxId}
                  onSelect={onSelect}
                  onMove={move}
                  onKeyboardMove={moveByKeyboard}
                  onDelete={onDelete}
                  onEditSignature={onEditSignature}
                  onReauth={onReauth}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
        <Button
          variant="ghost"
          onClick={onAdd}
          className="mt-1 justify-start gap-2 px-2 text-muted-foreground"
        >
          <PlusIcon />
          アカウントを追加
        </Button>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
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

type MoveHandler = (data: SortData, ids: string[], id: string) => void;

function AccountItem({
  account,
  accountIds,
  tree,
  collapsed,
  onToggle,
  selected,
  selectedMailboxId,
  onSelect,
  onMove,
  onKeyboardMove,
  onDelete,
  onEditSignature,
  onReauth,
}: {
  account: Account;
  accountIds: string[];
  tree: MailboxNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selected: boolean;
  selectedMailboxId: string | null;
  onSelect: Props["onSelect"];
  onMove: MoveHandler;
  onKeyboardMove: MoveHandler;
  onDelete: Props["onDelete"];
  onEditSignature: Props["onEditSignature"];
  onReauth: Props["onReauth"];
}) {
  const problem = statusLabel[account.status];
  const open = !collapsed.has(account.id);
  const name = account.displayName || account.email;
  const item = useSortableItem(
    account.id,
    {
      group: ACCOUNT_GROUP,
      ids: accountIds,
      kind: "account",
      label: name,
    },
    onKeyboardMove,
  );
  return (
    <div
      ref={item.setNodeRef}
      style={item.style}
      className={cn(
        "group/account relative",
        item.isDragging && "z-10 opacity-70",
      )}
    >
      <div className="flex items-start">
        <ToggleButton
          open={open}
          label={`${name} のフォルダ`}
          onClick={() => onToggle(account.id)}
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
          handle={item.handle}
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
      {account.status === "auth_required" && oauthProviderOf(account) && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => onReauth(account)}
          className="mt-1 mb-2 ml-8"
        >
          {oauthProviderOf(account) === "google"
            ? "Google にログインし直す"
            : "Microsoft にログインし直す"}
        </Button>
      )}
      {open && tree.length > 0 && (
        <FolderList
          nodes={tree}
          depth={1}
          group={`${account.id}:`}
          onMove={onMove}
          onKeyboardMove={onKeyboardMove}
          collapsed={collapsed}
          onToggle={onToggle}
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

function UnreadCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 font-medium text-muted-foreground text-xs tabular-nums">
      <span className="sr-only">未読 </span>
      {count > 9999 ? "9999+" : count}
    </span>
  );
}

type FolderListProps = {
  nodes: MailboxNode[];
  depth: number;
  /** 並び替えの単位 (アカウントと親フォルダ)。この中でだけ順番を入れ替えられる。 */
  group: string;
  onMove: MoveHandler;
  onKeyboardMove: MoveHandler;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  isSelected: (mailbox: MailboxSummary) => boolean;
  onSelect: (mailbox: MailboxSummary) => void;
};

function FolderList(props: FolderListProps) {
  const ids = props.nodes.map((node) => node.mailbox.id);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <ul className="flex flex-col gap-0.5">
        {props.nodes.map((node) => (
          <FolderItem key={node.mailbox.id} {...props} node={node} ids={ids} />
        ))}
      </ul>
    </SortableContext>
  );
}

function FolderItem({
  node,
  ids,
  ...props
}: FolderListProps & { node: MailboxNode; ids: string[] }) {
  const { mailbox } = node;
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !props.collapsed.has(mailbox.id);
  const selected = props.isSelected(mailbox);
  const label = mailboxLabel(mailbox);
  const item = useSortableItem(
    mailbox.id,
    { group: props.group, ids, kind: "mailbox", label },
    props.onKeyboardMove,
  );
  return (
    <li
      ref={item.setNodeRef}
      style={item.style}
      className={cn("relative", item.isDragging && "z-10 opacity-70")}
    >
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
            "flex min-w-0 flex-1 touch-manipulation select-none items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
            selected &&
              "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
            item.isDragging && "bg-sidebar-accent",
          )}
          {...item.handle}
        >
          {(mailbox.specialUse && folderIcons[mailbox.specialUse]) || (
            <FolderIcon />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {/* 折りたたんでいる間は、中のフォルダの未読も合わせて表示する。 */}
          <UnreadCount count={open ? mailbox.unreadCount : node.unreadTotal} />
        </button>
      </div>
      {open && (
        <FolderList
          {...props}
          nodes={node.children}
          depth={props.depth + 1}
          group={`${mailbox.accountId}:${mailbox.id}`}
        />
      )}
    </li>
  );
}

function SidebarItem(props: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string | undefined;
  problem?: string | undefined;
  /** 未読数。0 なら表示しない。 */
  count?: number;
  selected: boolean;
  onClick: () => void;
  className?: string;
  /** 並び替えられる行に付ける、ドラッグとキーボード操作の受け口。 */
  handle?: SortHandle;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.selected ? "page" : undefined}
      {...props.handle}
      className={cn(
        props.handle && "touch-manipulation select-none",
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
      {props.count !== undefined && <UnreadCount count={props.count} />}
    </button>
  );
}
