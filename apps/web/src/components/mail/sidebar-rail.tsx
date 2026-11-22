"use client";

import { cn } from "cn";
import {
  CircleAlertIcon,
  FilePenLineIcon,
  InboxIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PenSquareIcon,
  SendIcon,
  SettingsIcon,
  StarIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { accountColor } from "@/lib/account-colors";
import { AccountMark } from "@/lib/account-icons";
import type { Account, MailboxSummary } from "@/lib/api";
import {
  hoveredOverlayScrollbarOwner,
  overlayScrollbarOwner,
} from "@/lib/overlay-scrollbars";
import type { SpecialView } from "@/lib/route";
import {
  PEEK_CLOSE_DELAY,
  PEEK_OPEN_DELAY,
  SIDEBAR_FOLD_KEY_LABEL,
} from "@/lib/sidebar-fold";

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
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={`${label} (${SIDEBAR_FOLD_KEY_LABEL})`}
      aria-expanded={!folded}
      aria-controls="mail-sidebar"
      onClick={onToggle}
      className={className}
    >
      {folded ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
    </Button>
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
          <Button
            size="icon"
            onClick={onCompose}
            aria-label="新規作成"
            title="新規作成 (C)"
          >
            <PenSquareIcon />
          </Button>
        </div>
      )}
      <nav
        aria-label="メールアカウントとフォルダ (折りたたみ中)"
        className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-hidden py-1"
      >
        <RailItem
          label="すべての受信トレイ"
          badge={inboxUnread > 0 ? `未読 ${inboxUnread} 件` : null}
          selected={folderView && selectedAccountId === null}
          onClick={() => onSelect(null, null)}
        >
          <InboxIcon />
        </RailItem>
        <RailItem
          label="スター付き"
          selected={special === "starred"}
          onClick={() => onSelectSpecial("starred")}
        >
          <StarIcon />
        </RailItem>
        <RailItem
          label="下書き"
          badge={draftCount > 0 ? `${draftCount} 件` : null}
          badgeTone="muted"
          selected={draftsSelected}
          onClick={onSelectDrafts}
        >
          <FilePenLineIcon />
        </RailItem>
        <RailItem
          label="送信待ち"
          badge={
            outgoingCount > 0
              ? outgoingFailed
                ? `送信できなかったメールあり、${outgoingCount} 件`
                : `${outgoingCount} 件`
              : null
          }
          badgeTone={outgoingFailed ? "problem" : "muted"}
          selected={special === "outgoing"}
          onClick={() => onSelectSpecial("outgoing")}
        >
          {outgoingFailed ? (
            <CircleAlertIcon className="text-destructive" />
          ) : (
            <SendIcon />
          )}
        </RailItem>
        <span className="h-2 shrink-0" aria-hidden="true" />
        {(accounts ?? []).map((account) => {
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
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full font-semibold text-[10px] text-white uppercase leading-none",
                    accountColor(accounts ?? [], account.id),
                  )}
                >
                  {[...name][0] ?? ""}
                </span>
              )}
            </RailItem>
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
  onClick,
  children,
}: {
  label: string;
  /** 右上の点の説明 (未読数など)。null なら点を出さない。 */
  badge?: string | null;
  badgeTone?: keyof typeof badgeTones;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={badge ? `${label} (${badge})` : label}
      title={badge ? `${label} (${badge})` : label}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4",
        selected && "bg-sidebar-accent text-sidebar-accent-foreground",
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
