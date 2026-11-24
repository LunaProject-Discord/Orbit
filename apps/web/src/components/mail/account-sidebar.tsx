"use client";

import {
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useDroppable,
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
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  EyeOffIcon,
  FolderOpenIcon,
  LayersPlusIcon,
  ListChecksIcon,
  ListPlusIcon,
  PencilIcon,
  PenSquareIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OrbitLogo } from "@/components/brand/orbit-logo";
import { Hint } from "@/components/hint";
import { MailboxMark } from "@/components/mail/mailbox-icon";
import {
  AccountMenuItems,
  CategoryMenu,
  FolderMenuItems,
  MoveItems,
  type SidebarMenuActions,
} from "@/components/mail/sidebar-menus";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { BuiltinMark, UnifiedMark } from "@/components/mail/unified-mark";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountMark } from "@/lib/account-icons";
import {
  type Account,
  type MailboxSummary,
  oauthProviderOf,
  type SidebarCategory,
  type UnifiedFolder,
  type UnifiedState,
  type User,
} from "@/lib/api";
import {
  buildMailboxTree,
  type MailboxNode,
  mailboxLabel,
  moveBy,
  moveTo,
} from "@/lib/mailboxes";
import type { SpecialView } from "@/lib/route";
import {
  groupSidebar,
  mergeSubsetOrder,
  toggleCategoryFolded,
  useFoldedCategories,
} from "@/lib/sidebar-categories";
import type { SyncStatus } from "@/lib/sync-status";
import {
  type BuiltinView,
  builtinLabel,
  builtinStyle,
  type SidebarEntry,
  sidebarEntries,
} from "@/lib/unified";

const statusLabel: Partial<Record<Account["status"], string>> = {
  auth_required: "再ログインが必要です",
  error: "同期でエラーが発生しています",
  disabled: "同期を停止しています",
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

/**
 * 並び替えられる項目に持たせる情報。同じ group の中で順番を入れ替えられる。
 * アカウントと上部の項目は、別のカテゴリの同じ種類の項目や、カテゴリの見出しの上にも落とせる。
 */
type SortData = {
  group: string;
  /** 同じ group の項目の ID (いまの表示順)。 */
  ids: string[];
  kind: "account" | "mailbox" | "view" | "category";
  /** 読み上げに使う名前。 */
  label: string;
  /** 項目が入っているカテゴリの ID (カテゴリの見出しなら、そのカテゴリ)。入っていなければ null。 */
  category?: string | null;
};

/** カテゴリの見出しの、項目を落とせる場所に持たせる情報。 */
type CategoryDropData = { kind: "category-drop"; category: string };

const CATEGORY_GROUP = "categories";
/** 並び替えの単位。カテゴリごとに分ける (カテゴリなしは空の文字列)。 */
const accountGroup = (category: string | null) => `accounts:${category ?? ""}`;
const viewGroup = (category: string | null) => `views:${category ?? ""}`;

/** カテゴリの見出しの右クリックメニューなどから呼ぶ操作。 */
export type CategoryActions = {
  /** 新しいカテゴリを作る。key を渡すと、その項目を作ったカテゴリへ入れる。 */
  onCreate: (key?: string) => void;
  onRename: (category: SidebarCategory) => void;
  onDelete: (category: SidebarCategory) => void;
  /** 項目を別のカテゴリへ移す。categoryId が null ならカテゴリから外す。 */
  onAssign: (key: string, categoryId: string | null) => void;
  /** カテゴリを並び替えた。ids は新しい表示順。 */
  onReorder: (ids: string[]) => void;
};

/** サイドバー上部の項目 (初めからある項目と統合フォルダ) の右クリックメニューから呼ぶ操作。 */
export type ViewMenuActions = {
  onCreate: () => void;
  onEdit: (folder: UnifiedFolder) => void;
  /** 初めからある項目の名前・アイコン・色を変える。 */
  onEditBuiltin: (view: BuiltinView) => void;
  onDelete: (folder: UnifiedFolder) => void;
  /** 項目をサイドバーから隠す。key は初めからある項目の名前か、統合フォルダの ID。 */
  onHide: (key: string) => void;
  /** 表示する項目を選ぶ画面 (設定) を開く。 */
  onManage: () => void;
};

/**
 * ドラッグ中の項目と同じ並びの項目だけを、入れ替え先の候補にする。
 * アカウントと上部の項目は、別のカテゴリの同じ種類の項目と、カテゴリの見出しも候補にする。
 */
const sameGroup: CollisionDetection = (args) => {
  const active = args.active.data.current as SortData | undefined;
  const crossCategory = active?.kind === "account" || active?.kind === "view";
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => {
      const data = container.data.current as
        | SortData
        | CategoryDropData
        | undefined;
      if (!data || !active) return false;
      if (data.kind === "category-drop") return crossCategory;
      return crossCategory
        ? data.kind === active.kind
        : "group" in data && data.group === active.group;
    }),
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
  /** サーバーに保存してある下書きの数 (全アカウント分)。 */
  draftCount: number;
  /** 下書きの一覧を表示している。その間はフォルダを選択中として扱わない。 */
  draftsSelected: boolean;
  onSelectDrafts: () => void;
  /** フォルダ以外の表示 (スター付き、送信待ち、設定)。その間もフォルダを選択中として扱わない。 */
  special: SpecialView | null;
  onSelectSpecial: (view: SpecialView) => void;
  /** 統合フォルダと、サイドバー上部の項目の並び順。 */
  unified: UnifiedState;
  /** 表示している統合フォルダ。その間もフォルダを選択中として扱わない。 */
  selectedUnifiedId: string | null;
  onSelectUnified: (id: string) => void;
  /** サイドバー上部の項目を並び替えた。keys は、見えている項目の新しい表示順。 */
  onReorderViews: (keys: string[]) => void;
  viewActions: ViewMenuActions;
  categoryActions: CategoryActions;
  /** まだ送り終えていないメールの数と、その中に送信できなかったものがあるか。 */
  outgoingCount: number;
  outgoingFailed: boolean;
  /** 新しいメールを書き始める。アカウントが無い間は null。 */
  onCompose: (() => void) | null;
  onAdd: () => void;
  /** アカウントとフォルダの右クリックメニューから呼ぶ操作。 */
  menuActions: SidebarMenuActions;
  /** 再ログインが必要な Google / Microsoft のアカウントで、ログインし直す。 */
  onReauth: (account: Account) => void;
  syncStatus: SyncStatus;
  /** 見出しの左端に置くもの (サイドバーを折りたたむボタン)。 */
  headerStart?: React.ReactNode;
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
  draftCount,
  draftsSelected,
  onSelectDrafts,
  special,
  onSelectSpecial,
  unified,
  selectedUnifiedId,
  onSelectUnified,
  onReorderViews,
  viewActions,
  categoryActions,
  outgoingCount,
  outgoingFailed,
  onCompose,
  onAdd,
  menuActions,
  onReauth,
  syncStatus,
  headerStart,
}: Props) {
  /** フォルダの一覧を表示している (下書きやスター付きなどではない)。 */
  const folderView =
    !draftsSelected && special === null && selectedUnifiedId === null;
  const { collapsed, toggle } = useCollapsed();
  const foldedCategories = useFoldedCategories();
  const viewKeys = useMemo(
    () => sidebarEntries(unified).visible.map((entry) => entry.key),
    [unified],
  );
  const groups = useMemo(
    () => groupSidebar(unified, accounts ?? []),
    [unified, accounts],
  );
  const categoryIds = unified.categories.map((category) => category.id);
  const byAccount = useMemo(() => {
    const result = new Map<string, MailboxSummary[]>();
    for (const mailbox of mailboxes ?? []) {
      const list = result.get(mailbox.accountId);
      if (list) list.push(mailbox);
      else result.set(mailbox.accountId, [mailbox]);
    }
    return result;
  }, [mailboxes]);
  const trees = useMemo(
    () =>
      new Map(
        [...byAccount].map(([accountId, list]) => [
          accountId,
          buildMailboxTree(list),
        ]),
      ),
    [byAccount],
  );
  const inboxUnread = (mailboxes ?? []).reduce(
    (sum, mailbox) =>
      mailbox.specialUse === "inbox" ? sum + mailbox.unreadCount : sum,
    0,
  );
  const inboxUnreadOf = (accountId: string) =>
    (byAccount.get(accountId) ?? []).reduce(
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
  }, [accounts, mailboxes, unified]);

  /**
   * タッチでは、長押しがドラッグの開始と右クリックメニューの両方に当たる。
   * 動かさずに押し続けてメニューが開いたら、始まっていたドラッグを取り消す
   * (ドラッグは Escape で取り消せるので、それを使う)。指を離したときのクリックで
   * フォルダが開かないよう、離すまではクリックも抑える。
   */
  const menuPressRef = useRef(false);
  const handleMenuOpenChange = (open: boolean) => {
    if (!open || !draggedRef.current) return;
    menuPressRef.current = true;
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape" }),
    );
    const release = () => {
      window.removeEventListener("touchend", release, true);
      window.removeEventListener("touchcancel", release, true);
      setTimeout(() => {
        menuPressRef.current = false;
        draggedRef.current = false;
      }, 50);
    };
    window.addEventListener("touchend", release, true);
    window.addEventListener("touchcancel", release, true);
  };

  const accountIds = (accounts ?? []).map((account) => account.id);
  /** ids は同じ group (カテゴリの中など) の新しい順。全体の並びに戻して保存する。 */
  const move = (data: SortData, ids: string[], id: string) => {
    if (data.kind === "account") {
      onReorderAccounts(mergeSubsetOrder(accountIds, ids));
    } else if (data.kind === "view") {
      onReorderViews(mergeSubsetOrder(viewKeys, ids));
    } else if (data.kind === "category") categoryActions.onReorder(ids);
    else onReorderMailboxes(ids);
    setAnnouncement(
      `${data.label} を ${ids.length} 件中 ${ids.indexOf(id) + 1} 番目に移動しました`,
    );
  };
  const categoryName = (id: string | null) =>
    unified.categories.find((category) => category.id === id)?.name;
  /** 項目を別のカテゴリへ移した (ドラッグで)。 */
  const assign = (data: SortData, key: string, category: string | null) => {
    categoryActions.onAssign(key, category);
    const name = categoryName(category);
    setAnnouncement(
      name
        ? `${data.label} をカテゴリ「${name}」に移動しました`
        : `${data.label} をカテゴリから外しました`,
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
    const target = over?.data.current as
      | SortData
      | CategoryDropData
      | undefined;
    if (!data || !over || !target) return;
    const key = String(active.id);
    const from = data.category ?? null;
    // カテゴリの見出しに落とした: そのカテゴリの最後に入れる。
    if (target.kind === "category-drop") {
      if (target.category !== from) assign(data, key, target.category);
      return;
    }
    // 別のカテゴリの項目に落とした: そのカテゴリへ移し、落とした項目の位置に並べる。
    const to = target.category ?? null;
    if (
      (data.kind === "account" || data.kind === "view") &&
      target.group !== data.group
    ) {
      const all = data.kind === "account" ? accountIds : viewKeys;
      const ids = moveTo(all, key, String(over.id));
      assign(data, key, to);
      if (ids) {
        if (data.kind === "account") onReorderAccounts(ids);
        else onReorderViews(ids);
      }
      return;
    }
    const ids = moveTo(data.ids, key, String(over.id));
    if (ids) move(data, ids, key);
  };

  /** サイドバー上部の項目 (カテゴリなし、または 1 つのカテゴリの中)。 */
  const renderViews = (entries: SidebarEntry[], category: string | null) => {
    const keys = entries.map((entry) => entry.key);
    return (
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        {entries.map((entry) => {
          const view = entry.builtin;
          const outgoingProblem = view === "outgoing" && outgoingFailed;
          return (
            <ViewItem
              key={entry.key}
              entry={entry}
              label={
                entry.folder
                  ? entry.folder.name
                  : builtinLabel(unified, entry.builtin)
              }
              keys={keys}
              category={category}
              categories={unified.categories}
              categoryActions={categoryActions}
              icon={
                entry.folder ? (
                  <UnifiedMark folder={entry.folder} className="mt-0.5" />
                ) : outgoingProblem ? (
                  <CircleAlertIcon className="text-destructive" />
                ) : (
                  <BuiltinMark
                    view={entry.builtin}
                    style={builtinStyle(unified, entry.builtin)}
                    className="mt-0.5"
                  />
                )
              }
              count={
                entry.folder
                  ? entry.folder.unreadCount
                  : view === "inbox"
                    ? inboxUnread
                    : view === "drafts"
                      ? draftCount
                      : view === "outgoing"
                        ? outgoingCount
                        : undefined
              }
              countLabel={
                view === "drafts"
                  ? "件数"
                  : view === "outgoing"
                    ? outgoingFailed
                      ? "送信できなかったメールあり、件数"
                      : "件数"
                    : undefined
              }
              selected={
                entry.folder
                  ? selectedUnifiedId === entry.folder.id
                  : view === "inbox"
                    ? folderView && selectedAccountId === null
                    : view === "drafts"
                      ? draftsSelected
                      : special === view
              }
              onOpen={() => {
                if (entry.folder) onSelectUnified(entry.folder.id);
                else if (view === "inbox") onSelect(null, null);
                else if (view === "drafts") onSelectDrafts();
                else if (view === "starred" || view === "outgoing") {
                  onSelectSpecial(view);
                }
              }}
              onKeyboardMove={moveByKeyboard}
              actions={viewActions}
              onMenuOpenChange={handleMenuOpenChange}
            />
          );
        })}
      </SortableContext>
    );
  };
  /** アカウント (カテゴリなし、または 1 つのカテゴリの中)。 */
  const renderAccounts = (list: Account[], category: string | null) => {
    const ids = list.map((account) => account.id);
    return (
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {list.map((account) => (
          <AccountItem
            key={account.id}
            account={account}
            accountIds={ids}
            category={category}
            categories={unified.categories}
            categoryActions={categoryActions}
            tree={trees.get(account.id) ?? []}
            collapsed={collapsed}
            onToggle={toggle}
            accounts={accounts ?? []}
            selected={folderView && selectedAccountId === account.id}
            selectedMailboxId={selectedMailboxId}
            onSelect={onSelect}
            onMove={move}
            onKeyboardMove={moveByKeyboard}
            onReauth={onReauth}
            mailboxes={byAccount.get(account.id) ?? NO_MAILBOXES}
            menuActions={menuActions}
            onMenuOpenChange={handleMenuOpenChange}
          />
        ))}
      </SortableContext>
    );
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        {headerStart}
        <span className="flex flex-1 items-center">
          <OrbitLogo className="h-7" />
        </span>
      </div>
      {onCompose && (
        // 左右の端は、下の項目の行 (選択中の背景) と同じ位置にする。
        <div className="shrink-0 px-2 pb-2">
          <Hint label="新規作成" shortcut="C">
            <Button onClick={onCompose} className="w-full justify-center gap-2">
              <PenSquareIcon />
              新規作成
            </Button>
          </Hint>
        </div>
      )}

      <nav
        aria-label="メールアカウントとフォルダ"
        // 左右の余白は同じにする。スクロールバーは内容の上に重ねて描く (幅を取らない) ので、
        // 右だけ広く空けると、新規作成のボタンや項目が左に寄って見える。
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1"
        onClickCapture={(event) => {
          if (!draggedRef.current) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
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
            // メニューを開くために取り消したときは、指を離すまでクリックを抑えたままにする。
            if (!menuPressRef.current) draggedRef.current = false;
          }}
        >
          {renderViews(groups.views, null)}
          <button
            type="button"
            onClick={viewActions.onCreate}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm pointer-coarse:py-3 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <LayersPlusIcon />
            統合フォルダを作成
          </button>
          <span className="h-2 shrink-0" aria-hidden="true" />
          {accounts === null ? (
            <div className="flex flex-col gap-2 px-2 py-2" aria-hidden="true">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-32" />
            </div>
          ) : (
            renderAccounts(groups.accounts, null)
          )}
          <SortableContext
            items={categoryIds}
            strategy={verticalListSortingStrategy}
          >
            {groups.categories.map((group) => {
              const { category } = group;
              const empty =
                group.views.length === 0 && group.accounts.length === 0;
              return (
                <CategorySection
                  key={category.id}
                  category={category}
                  ids={categoryIds}
                  folded={foldedCategories.has(category.id)}
                  unread={group.accounts.reduce(
                    (sum, account) => sum + inboxUnreadOf(account.id),
                    0,
                  )}
                  empty={empty}
                  onKeyboardMove={moveByKeyboard}
                  actions={categoryActions}
                  onMenuOpenChange={handleMenuOpenChange}
                >
                  {renderViews(group.views, category.id)}
                  {renderAccounts(group.accounts, category.id)}
                </CategorySection>
              );
            })}
          </SortableContext>
        </DndContext>
        <Button
          variant="ghost"
          onClick={onAdd}
          // ボタンには 1px の枠があるので、その分を引いてアイコンを上の項目の列に揃える。
          // タッチ操作ではボタンの左右の余白が広がるので、同じ値に戻す。
          className="mt-1 justify-start gap-2 px-[7px] pointer-coarse:px-[7px] text-muted-foreground"
        >
          <PlusIcon />
          アカウントを追加
        </Button>
        <Button
          variant="ghost"
          onClick={() => categoryActions.onCreate()}
          className="justify-start gap-2 px-[7px] pointer-coarse:px-[7px] text-muted-foreground"
        >
          <ListPlusIcon />
          カテゴリを作成
        </Button>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
      </nav>

      <SyncIndicator
        status={syncStatus}
        // アイコンと文字を、上の項目のアイコンの列 (16px) と文字の列 (40px) に揃える。
        className="shrink-0 gap-2.5 border-t py-2 pr-2 pl-4"
      />
      <div className="flex shrink-0 items-center gap-2 border-t py-3 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">{user.name}</p>
          <p className="truncate text-muted-foreground text-xs">{user.email}</p>
        </div>
        <Hint label="設定" side="top">
          <Button
            variant="outline"
            size="icon"
            aria-label="設定"
            aria-current={special === "settings" ? "page" : undefined}
            onClick={() => onSelectSpecial("settings")}
            className={cn(special === "settings" && "bg-sidebar-accent")}
          >
            <SettingsIcon />
          </Button>
        </Hint>
      </div>
    </div>
  );
}

type MoveHandler = (data: SortData, ids: string[], id: string) => void;

/**
 * サイドバー上部の 1 項目 (初めからある項目か、統合フォルダ)。
 * ドラッグや Alt+↑↓ で並び替えられ、右クリックで編集や非表示などのメニューを出す。
 */
function ViewItem({
  entry,
  label,
  keys,
  category,
  categories,
  categoryActions,
  icon,
  count,
  countLabel,
  selected,
  onOpen,
  onKeyboardMove,
  actions,
  onMenuOpenChange,
}: {
  entry: SidebarEntry;
  label: string;
  /** 同じ並び (カテゴリなし、または同じカテゴリ) の見えている項目 (いまの表示順)。 */
  keys: string[];
  /** 入っているカテゴリの ID。入っていなければ null。 */
  category: string | null;
  categories: SidebarCategory[];
  categoryActions: CategoryActions;
  icon: React.ReactNode;
  count: number | undefined;
  countLabel: string | undefined;
  selected: boolean;
  onOpen: () => void;
  onKeyboardMove: MoveHandler;
  actions: ViewMenuActions;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const sortData: SortData = {
    group: viewGroup(category),
    ids: keys,
    kind: "view",
    label,
    category,
  };
  const item = useSortableItem(entry.key, sortData, onKeyboardMove);
  const { folder } = entry;
  return (
    <div
      ref={item.setNodeRef}
      style={item.style}
      className={cn("relative", item.isDragging && "z-10 opacity-70")}
    >
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger render={<div />}>
          <Hint label={label} side="right" whenClipped>
            <SidebarItem
              icon={icon}
              label={label}
              {...(count !== undefined ? { count } : {})}
              {...(countLabel !== undefined ? { countLabel } : {})}
              selected={selected}
              onClick={onOpen}
              handle={item.handle}
              className={cn(item.isDragging && "bg-sidebar-accent")}
            />
          </Hint>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuItem onClick={onOpen}>
            <FolderOpenIcon />
            開く
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              folder
                ? actions.onEdit(folder)
                : actions.onEditBuiltin(entry.builtin)
            }
          >
            <PencilIcon />
            {folder ? "編集…" : "名前・アイコン・色を変更…"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <MoveItems
            id={entry.key}
            ids={keys}
            onReorder={(ids) => onKeyboardMove(sortData, ids, entry.key)}
          />
          <CategoryMenu
            categories={categories}
            current={category}
            onAssign={(next) => categoryActions.onAssign(entry.key, next)}
            onCreate={() => categoryActions.onCreate(entry.key)}
          />
          <ContextMenuItem onClick={() => actions.onHide(entry.key)}>
            <EyeOffIcon />
            サイドバーから隠す
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={actions.onCreate}>
            <LayersPlusIcon />
            統合フォルダを作成…
          </ContextMenuItem>
          <ContextMenuItem onClick={actions.onManage}>
            <ListChecksIcon />
            表示する項目を選ぶ…
          </ContextMenuItem>
          {folder && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onClick={() => actions.onDelete(folder)}
              >
                <Trash2Icon />
                削除…
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/**
 * カテゴリの見出しと、その中の項目。見出しを押すと折りたたみ、ドラッグや Alt+↑↓ で
 * カテゴリごと並び替えられる。見出しの上には、アカウントや上部の項目をドラッグして入れられる。
 */
function CategorySection({
  category,
  ids,
  folded,
  unread,
  empty,
  onKeyboardMove,
  actions,
  onMenuOpenChange,
  children,
}: {
  category: SidebarCategory;
  /** すべてのカテゴリの ID (いまの表示順)。 */
  ids: string[];
  folded: boolean;
  /** 中のアカウントの受信トレイの未読数 (折りたたんでいる間に出す)。 */
  unread: number;
  /** 中に見えている項目が 1 つも無い。 */
  empty: boolean;
  onKeyboardMove: MoveHandler;
  actions: CategoryActions;
  onMenuOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const sortData: SortData = {
    group: CATEGORY_GROUP,
    ids,
    kind: "category",
    label: category.name,
    category: category.id,
  };
  const item = useSortableItem(category.id, sortData, onKeyboardMove);
  const drop = useDroppable({
    id: `category-drop:${category.id}`,
    data: {
      kind: "category-drop",
      category: category.id,
    } satisfies CategoryDropData,
  });
  const toggle = () => toggleCategoryFolded(category.id);
  return (
    <section
      ref={item.setNodeRef}
      style={item.style}
      aria-label={category.name}
      className={cn("relative mt-3", item.isDragging && "z-10 opacity-70")}
    >
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger render={<div ref={drop.setNodeRef} />}>
          <Hint label={category.name} side="right" whenClipped>
            <button
              type="button"
              aria-expanded={!folded}
              onClick={toggle}
              {...item.handle}
              className={cn(
                "flex w-full touch-manipulation select-none items-center gap-2 rounded-md px-2 py-1 text-left font-medium text-muted-foreground text-xs pointer-coarse:min-h-11 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                (item.isDragging || drop.isOver) &&
                  "bg-sidebar-accent text-sidebar-foreground",
              )}
            >
              {/* 矢印は上の項目のアイコンの列 (中心 24px) に、名前は文字の列 (40px) に揃える。 */}
              <span className="flex size-4 shrink-0 items-center justify-center">
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 transition-transform",
                    !folded && "rotate-90",
                  )}
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{category.name}</span>
              {folded && <UnreadCount count={unread} />}
            </button>
          </Hint>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuItem onClick={toggle}>
            {folded ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
            {folded ? "開く" : "折りたたむ"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => actions.onRename(category)}>
            <PencilIcon />
            名前を変更…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <MoveItems
            id={category.id}
            ids={ids}
            onReorder={(next) => onKeyboardMove(sortData, next, category.id)}
          />
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => actions.onCreate()}>
            <ListPlusIcon />
            新しいカテゴリ…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => actions.onDelete(category)}
          >
            <Trash2Icon />
            カテゴリを削除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!folded &&
        (empty ? (
          <p className="py-1.5 pr-2 pl-10 text-muted-foreground text-xs">
            アカウントや統合フォルダをここへドラッグするか、右クリックメニューの「カテゴリ」から入れられます。
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">{children}</div>
        ))}
    </section>
  );
}

const NO_MAILBOXES: MailboxSummary[] = [];

function AccountItem({
  account,
  accounts,
  accountIds,
  category,
  categories,
  categoryActions,
  tree,
  collapsed,
  onToggle,
  selected,
  selectedMailboxId,
  onSelect,
  onMove,
  onKeyboardMove,
  onReauth,
  mailboxes,
  menuActions,
  onMenuOpenChange,
}: {
  account: Account;
  /** 色を決めるのに使う、すべてのアカウント。 */
  accounts: Account[];
  /** 同じ並び (カテゴリなし、または同じカテゴリ) のアカウント (いまの表示順)。 */
  accountIds: string[];
  /** 入っているカテゴリの ID。入っていなければ null。 */
  category: string | null;
  categories: SidebarCategory[];
  categoryActions: CategoryActions;
  tree: MailboxNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selected: boolean;
  selectedMailboxId: string | null;
  onSelect: Props["onSelect"];
  onMove: MoveHandler;
  onKeyboardMove: MoveHandler;
  onReauth: Props["onReauth"];
  /** このアカウントのフォルダ。 */
  mailboxes: MailboxSummary[];
  menuActions: SidebarMenuActions;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const problem = statusLabel[account.status];
  const open = !collapsed.has(account.id);
  const name = account.displayName || account.email;
  const sortData: SortData = {
    group: accountGroup(category),
    ids: accountIds,
    kind: "account",
    label: name,
    category,
  };
  const item = useSortableItem(account.id, sortData, onKeyboardMove);
  return (
    <div
      ref={item.setNodeRef}
      style={item.style}
      className={cn(
        "group/account relative mt-2",
        item.isDragging && "z-10 opacity-70",
      )}
    >
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger render={<div className="flex items-start" />}>
          <AccountToggle
            open={open}
            label={`${name} のフォルダ`}
            // フォルダが無いアカウントは開閉できないので、印だけを出す。
            onClick={tree.length > 0 ? () => onToggle(account.id) : null}
          >
            {problem ? (
              <CircleAlertIcon
                className="size-4 text-destructive"
                aria-hidden="true"
              />
            ) : (
              <AccountMark accounts={accounts} account={account} />
            )}
          </AccountToggle>
          <SidebarItem
            icon={null}
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
            className="min-w-0 flex-1 pl-1"
            handle={item.handle}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <AccountMenuItems
            account={account}
            accountIds={accountIds}
            mailboxes={mailboxes}
            open={open}
            onOpen={() => onSelect(account.id, null)}
            onToggle={() => onToggle(account.id)}
            onReorder={(ids) => onKeyboardMove(sortData, ids, account.id)}
            actions={menuActions}
            categoryMenu={
              <CategoryMenu
                categories={categories}
                current={category}
                onAssign={(next) => categoryActions.onAssign(account.id, next)}
                onCreate={() => categoryActions.onCreate(account.id)}
              />
            }
          />
        </ContextMenuContent>
      </ContextMenu>
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
          menuActions={menuActions}
          account={account}
          onMenuOpenChange={onMenuOpenChange}
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

/**
 * アカウントのマーク (アイコンか色の点)。印の上にポインターを置くか、キーボードで選ぶと
 * 開閉の矢印に入れ替わり、押すとフォルダを折りたたむ / 開く。
 */
function AccountToggle(props: {
  open: boolean;
  label: string;
  /** null なら開閉できない (印だけを出す)。 */
  onClick: (() => void) | null;
  children: React.ReactNode;
}) {
  // 左に 4px 空けて、アイコンの中心を上の項目 (受信トレイなど) のアイコンの列に揃える。
  // タッチ操作では名前の行が上下に 6px ずつ広がるので、同じだけ下げて中心を揃える。
  const frame =
    "mt-1 ml-1 flex size-6 shrink-0 items-center justify-center pointer-coarse:mt-2.5";
  if (!props.onClick) return <span className={frame}>{props.children}</span>;
  return (
    <Hint label={props.open ? "折りたたむ" : "開く"}>
      <button
        type="button"
        aria-expanded={props.open}
        aria-label={`${props.label}を${props.open ? "折りたたむ" : "開く"}`}
        onClick={props.onClick}
        className={cn(
          frame,
          "group/toggle relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 rounded-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        <span className="flex transition-opacity group-hover/toggle:opacity-0 group-focus-visible/toggle:opacity-0">
          {props.children}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100",
            props.open && "rotate-90",
          )}
        />
      </button>
    </Hint>
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
        // タッチ操作でも大きさは変えず (フォルダのアイコンの列がずれるため)、押せる範囲だけを
        // 行の高さいっぱいと左側へ広げる。右側はフォルダの行に重ならない幅にとどめる。
        "relative flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:-right-1.5 pointer-coarse:after:-left-3.5 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
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
    <span className="shrink-0 font-medium text-muted-foreground text-xs tabular-nums leading-5">
      <span className="sr-only">{label} </span>
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
  menuActions: SidebarMenuActions;
  /** フォルダの持ち主のアカウント。 */
  account: Account;
  /** 右クリックメニューを開閉したとき (タッチの長押しでドラッグと重なるのを避ける)。 */
  onMenuOpenChange: (open: boolean) => void;
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
  const sortData: SortData = {
    group: props.group,
    ids,
    kind: "mailbox",
    label,
  };
  const item = useSortableItem(mailbox.id, sortData, props.onKeyboardMove);
  return (
    <li
      ref={item.setNodeRef}
      style={item.style}
      className={cn("relative", item.isDragging && "z-10 opacity-70")}
    >
      <ContextMenu onOpenChange={props.onMenuOpenChange}>
        <ContextMenuTrigger
          render={
            <div
              className="flex items-center"
              // 開閉の矢印はアカウントのアイコンの列に、フォルダのアイコンはアカウント名の列に揃える。
              style={{
                paddingLeft: `calc(${props.depth * 0.75}rem - 0.375rem)`,
              }}
            />
          }
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
          <Hint label={label} side="right" whenClipped>
            <button
              type="button"
              onClick={() => props.onSelect(mailbox)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-1 touch-manipulation select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-left text-sm pointer-coarse:min-h-11 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                selected &&
                  "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                item.isDragging && "bg-sidebar-accent",
              )}
              {...item.handle}
            >
              <MailboxMark mailbox={mailbox} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {/* 折りたたんでいる間は、中のフォルダの未読も合わせて表示する。 */}
              <UnreadCount
                count={open ? mailbox.unreadCount : node.unreadTotal}
              />
            </button>
          </Hint>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <FolderMenuItems
            account={props.account}
            mailbox={mailbox}
            unread={mailbox.unreadCount}
            siblings={props.nodes.map((sibling) => sibling.mailbox)}
            hasChildren={hasChildren}
            open={open}
            onOpen={() => props.onSelect(mailbox)}
            onToggle={() => props.onToggle(mailbox.id)}
            onReorder={(next) =>
              props.onKeyboardMove(sortData, next, mailbox.id)
            }
            actions={props.menuActions}
          />
        </ContextMenuContent>
      </ContextMenu>
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

function SidebarItem({
  icon,
  label,
  sublabel,
  problem,
  count,
  countLabel,
  selected,
  className,
  handle,
  ...rest
}: {
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
  /** 並び替えられる行に付ける、ドラッグとキーボード操作の受け口。 */
  handle?: SortHandle;
  // 説明 (Hint) で包んだときに渡される、ボタンの属性。
} & Omit<React.ComponentProps<"button">, "onClick" | "className">) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      {...rest}
      {...handle}
      className={cn(
        handle && "touch-manipulation select-none",
        // アイコンは 1 行目の文字の中央に合わせて 2px 下げる。枠で包んだ印 (BuiltinMark など) は
        // 枠の側で下げているので、中の svg まで下げない (二重に下がってしまう)。
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm pointer-coarse:py-3 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&>svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
        selected &&
          "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
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
        {problem && (
          <span className="mt-0.5 line-clamp-3 block font-normal text-destructive text-xs">
            {problem}
          </span>
        )}
      </span>
      {count !== undefined && <UnreadCount count={count} label={countLabel} />}
    </button>
  );
}
