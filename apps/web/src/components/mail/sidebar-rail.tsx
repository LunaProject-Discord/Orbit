"use client";

import { cn } from "cn";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  LayersPlusIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PenSquareIcon,
  SettingsIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Hint } from "@/components/hint";
import { BuiltinMark, UnifiedMark } from "@/components/mail/unified-mark";
import { Button } from "@/components/ui/button";
import { ACCOUNT_ON_CLASS } from "@/lib/account-colors";
import { AccountDot, AccountMark } from "@/lib/account-icons";
import type { Account, MailboxSummary, UnifiedState } from "@/lib/api";
import {
  hoveredOverlayScrollbarOwner,
  overlayScrollbarOwner,
} from "@/lib/overlay-scrollbars";
import type { SpecialView } from "@/lib/route";
import {
  groupSidebar,
  toggleCategoryFolded,
  useFoldedCategories,
} from "@/lib/sidebar-categories";
import {
  PEEK_CLOSE_DELAY,
  PEEK_OPEN_DELAY,
  SIDEBAR_FOLD_KEY_LABEL,
} from "@/lib/sidebar-fold";
import { builtinLabel, builtinStyle, type SidebarEntry } from "@/lib/unified";

/** サイドバーを折りたたむ / 広げたままにするボタン。帯とサイドバーの同じ位置に置く。 */
export function SidebarFoldButton({
  folded,
  onToggle,
  className,
}: {
  folded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const label = folded
    ? "サイドバーを広げたままにする"
    : "サイドバーを折りたたむ";
  return (
    <Hint label={label} shortcut={SIDEBAR_FOLD_KEY_LABEL}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-expanded={!folded}
        aria-controls="mail-sidebar"
        onClick={onToggle}
        className={className}
      >
        {folded ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
      </Button>
    </Hint>
  );
}

type RailProps = {
  accounts: Account[] | null;
  mailboxes: MailboxSummary[] | null;
  selectedAccountId: string | null;
  /** フォルダの一覧を表示している (下書きやスター付きなどではない)。 */
  folderView: boolean;
  draftCount: number;
  draftsSelected: boolean;
  special: SpecialView | null;
  outgoingCount: number;
  outgoingFailed: boolean;
  onSelect: (accountId: string | null, mailboxId: string | null) => void;
  onSelectDrafts: () => void;
  onSelectSpecial: (view: SpecialView) => void;
  /** 統合フォルダと、サイドバー上部の項目の並び順。 */
  unified: UnifiedState;
  selectedUnifiedId: string | null;
  onSelectUnified: (id: string) => void;
  onCreateUnified: () => void;
  onCompose: (() => void) | null;
  onToggleFold: () => void;
  /** サイドバーが上に重なっている間は true。隠れている帯を操作や読み上げの対象から外す。 */
  inert: boolean;
  className?: string;
};

/**
 * 折りたたんだサイドバーの代わりに出す、アイコンだけの細い帯。
 * マウスではカーソルを乗せるとサイドバーが上に重なるので、
 * 上から順の並びと高さをサイドバーと揃え、重なった後に押しても同じ項目に当たるようにしている。
 */
export function SidebarRail({
  accounts,
  mailboxes,
  selectedAccountId,
  folderView,
  draftCount,
  draftsSelected,
  special,
  outgoingCount,
  outgoingFailed,
  onSelect,
  onSelectDrafts,
  onSelectSpecial,
  unified,
  selectedUnifiedId,
  onSelectUnified,
  onCreateUnified,
  onCompose,
  onToggleFold,
  inert,
  className,
}: RailProps) {
  const unreadByAccount = new Map<string, number>();
  for (const mailbox of mailboxes ?? []) {
    if (mailbox.specialUse !== "inbox") continue;
    unreadByAccount.set(
      mailbox.accountId,
      (unreadByAccount.get(mailbox.accountId) ?? 0) + mailbox.unreadCount,
    );
  }
  const inboxUnread = [...unreadByAccount.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const groups = groupSidebar(unified, accounts ?? []);
  const folded = useFoldedCategories();
  const renderView = (entry: SidebarEntry) => {
    if (entry.folder) {
      const { folder } = entry;
      return (
        <RailItem
          key={entry.key}
          label={folder.name}
          badge={
            folder.unreadCount > 0 ? `未読 ${folder.unreadCount} 件` : null
          }
          selected={selectedUnifiedId === folder.id}
          onClick={() => onSelectUnified(folder.id)}
        >
          <UnifiedMark folder={folder} />
        </RailItem>
      );
    }
    const view = entry.builtin;
    const count =
      view === "inbox"
        ? inboxUnread
        : view === "drafts"
          ? draftCount
          : view === "outgoing"
            ? outgoingCount
            : 0;
    const problem = view === "outgoing" && outgoingFailed;
    return (
      <RailItem
        key={entry.key}
        label={builtinLabel(unified, view)}
        badge={
          count > 0
            ? view === "inbox"
              ? `未読 ${count} 件`
              : problem
                ? `送信できなかったメールあり、${count} 件`
                : `${count} 件`
            : null
        }
        badgeTone={view === "inbox" ? "unread" : problem ? "problem" : "muted"}
        selected={
          view === "inbox"
            ? folderView && selectedAccountId === null
            : view === "drafts"
              ? draftsSelected
              : special === view
        }
        onClick={() => {
          if (view === "inbox") onSelect(null, null);
          else if (view === "drafts") onSelectDrafts();
          else onSelectSpecial(view);
        }}
      >
        {problem ? (
          <CircleAlertIcon className="text-destructive" />
        ) : (
          <BuiltinMark view={view} style={builtinStyle(unified, view)} />
        )}
      </RailItem>
    );
  };
  const renderAccount = (account: Account) => {
    const unread = unreadByAccount.get(account.id) ?? 0;
    const name = account.displayName || account.email;
    const problem =
      account.status === "auth_required" ||
      account.status === "error" ||
      account.status === "disabled";
    return (
      <RailItem
        key={account.id}
        label={name}
        badge={
          problem
            ? "同期に問題があります"
            : unread > 0
              ? `未読 ${unread} 件`
              : null
        }
        badgeTone={problem ? "problem" : "unread"}
        selected={folderView && selectedAccountId === account.id}
        onClick={() => onSelect(account.id, null)}
      >
        {account.icon ? (
          // アイコンや絵文字を選んでいるアカウントは、サイドバーと同じ印を出す。
          <AccountMark accounts={accounts ?? []} account={account} />
        ) : (
          <AccountDot
            accounts={accounts ?? []}
            accountId={account.id}
            className={cn(
              "flex size-5 items-center justify-center font-semibold text-[10px] uppercase leading-none",
              ACCOUNT_ON_CLASS,
            )}
          >
            {[...name][0] ?? ""}
          </AccountDot>
        )}
      </RailItem>
    );
  };
  return (
    <div
      inert={inert}
      className={cn(
        "h-full w-12 flex-col items-center border-r bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <div className="flex h-14 shrink-0 items-center">
        <SidebarFoldButton folded onToggle={onToggleFold} />
      </div>
      {onCompose && (
        <div className="shrink-0 pb-2">
          <Hint label="新規作成" shortcut="C" side="right">
            <Button size="icon" onClick={onCompose} aria-label="新規作成">
              <PenSquareIcon />
            </Button>
          </Hint>
        </div>
      )}
      <nav
        aria-label="メールアカウントとフォルダ (折りたたみ中)"
        className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden py-1 [scrollbar-width:none]"
      >
        {groups.views.map(renderView)}
        <RailItem
          label="統合フォルダを作成"
          selected={false}
          onClick={onCreateUnified}
        >
          <LayersPlusIcon className="text-muted-foreground" />
        </RailItem>
        <span className="h-2 shrink-0" aria-hidden="true" />
        {groups.accounts.map(renderAccount)}
        {groups.categories.map(({ category, views, accounts: members }) => {
          const isFolded = folded.has(category.id);
          const unread = members.reduce(
            (sum, account) => sum + (unreadByAccount.get(account.id) ?? 0),
            0,
          );
          return (
            <div
              key={category.id}
              className="flex shrink-0 flex-col items-center gap-0.5"
            >
              {/* カテゴリの区切り。押すと、カテゴリを折りたたむ / 開く。 */}
              <RailItem
                label={`${category.name} (${isFolded ? "折りたたみ中" : "カテゴリ"})`}
                badge={isFolded && unread > 0 ? `未読 ${unread} 件` : null}
                selected={false}
                expanded={!isFolded}
                onClick={() => toggleCategoryFolded(category.id)}
                className="mt-2 h-5"
              >
                <span
                  aria-hidden="true"
                  className="flex w-6 items-center gap-0.5 text-muted-foreground"
                >
                  <span className="h-px flex-1 bg-border" />
                  <ChevronRightIcon
                    className={cn(
                      "size-3! transition-transform",
                      !isFolded && "rotate-90",
                    )}
                  />
                  <span className="h-px flex-1 bg-border" />
                </span>
              </RailItem>
              {!isFolded && (
                <>
                  {views.map(renderView)}
                  {members.map(renderAccount)}
                </>
              )}
            </div>
          );
        })}
      </nav>
      <div className="shrink-0 py-2">
        <RailItem
          label="設定"
          selected={special === "settings"}
          onClick={() => onSelectSpecial("settings")}
        >
          <SettingsIcon />
        </RailItem>
      </div>
    </div>
  );
}

const badgeTones = {
  unread: "bg-primary",
  muted: "bg-muted-foreground/60",
  problem: "bg-destructive",
};

function RailItem({
  label,
  badge = null,
  badgeTone = "unread",
  selected,
  expanded,
  onClick,
  className,
  children,
}: {
  label: string;
  /** 右上の点の説明 (未読数など)。null なら点を出さない。 */
  badge?: string | null;
  badgeTone?: keyof typeof badgeTones;
  selected: boolean;
  /** 開閉を切り替える項目なら、開いているか。 */
  expanded?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Hint label={badge ? `${label} (${badge})` : label} side="right">
      <button
        type="button"
        onClick={onClick}
        aria-label={badge ? `${label} (${badge})` : label}
        aria-current={selected ? "page" : undefined}
        aria-expanded={expanded}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4",
          selected && "bg-sidebar-accent text-sidebar-accent-foreground",
          className,
        )}
      >
        {children}
        {badge && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar",
              badgeTones[badgeTone],
            )}
          />
        )}
      </button>
    </Hint>
  );
}

/** メニューを開いている間と、並び替えのドラッグ中は、カーソルが離れても閉じない。 */
function sidebarBusy(aside: HTMLElement): boolean {
  return (
    document.querySelector('[role="menu"], [role="dialog"]') !== null ||
    aside.querySelector('[aria-pressed="true"]') !== null ||
    // サイドバーのスクロールバーは外に重ねて描いているので、その上にいる間も中として扱う。
    aside.contains(hoveredOverlayScrollbarOwner())
  );
}

/**
 * 折りたたんだサイドバーを、カーソルを乗せている間だけ一時的に広げる。
 * タッチ操作では帯を押すと広がり、外を押すと戻る。
 */
export function useSidebarPeek(
  asideRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [peek, setPeek] = useState(false);
  const insideRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const aside = asideRef.current;
    if (!enabled || !aside) return;
    const clear = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const tryClose = () => {
      timerRef.current = null;
      if (insideRef.current) return;
      if (sidebarBusy(aside)) {
        timerRef.current = setTimeout(tryClose, PEEK_CLOSE_DELAY);
        return;
      }
      setPeek(false);
    };
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      insideRef.current = true;
      clear();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setPeek(true);
      }, PEEK_OPEN_DELAY);
    };
    const onLeave = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      insideRef.current = false;
      clear();
      timerRef.current = setTimeout(tryClose, PEEK_CLOSE_DELAY);
    };
    // タッチ操作では、帯のどこを押しても広げる (押した項目の操作はそのまま行う)。
    const onClick = () => setPeek(true);
    const onDocumentDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || aside.contains(target)) return;
      if (aside.contains(overlayScrollbarOwner(target))) return;
      // サイドバーから開いたメニューやダイアログの中は、外として扱わない。
      if (
        target instanceof Element &&
        target.closest('[role="menu"], [role="dialog"]')
      ) {
        return;
      }
      insideRef.current = false;
      clear();
      setPeek(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || sidebarBusy(aside)) return;
      clear();
      setPeek(false);
    };
    aside.addEventListener("pointerenter", onEnter);
    aside.addEventListener("pointerleave", onLeave);
    aside.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onDocumentDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clear();
      insideRef.current = false;
      aside.removeEventListener("pointerenter", onEnter);
      aside.removeEventListener("pointerleave", onLeave);
      aside.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onDocumentDown);
      document.removeEventListener("keydown", onKeyDown);
      setPeek(false);
    };
  }, [asideRef, enabled]);

  return enabled && peek;
}
