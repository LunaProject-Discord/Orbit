"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderCogIcon,
  FolderOpenIcon,
  FolderPenIcon,
  FolderPlusIcon,
  InboxIcon,
  ListRestartIcon,
  LogInIcon,
  MailCheckIcon,
  RefreshCwIcon,
  SettingsIcon,
  SignatureIcon,
  Trash2Icon,
} from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { type Account, type MailboxSummary, oauthProviderOf } from "@/lib/api";
import { moveBy } from "@/lib/mailboxes";

/** サイドバーの右クリックメニューから呼ぶ操作。 */
export type SidebarMenuActions = {
  /** フォルダの未読のメールを、すべて既読にする。 */
  onMarkAllRead: (mailbox: MailboxSummary) => void;
  /** 並び替えたフォルダを、既定の順に戻す。 */
  onResetOrder: (mailboxIds: string[]) => void;
  /** 次の定期確認を待たずに、いますぐ同期する。 */
  onSyncNow: (account: Account) => void;
  onEditSignature: (account: Account) => void;
  onDeleteAccount: (account: Account) => void;
  onOpenSettings: () => void;
  onReauth: (account: Account) => void;
  /** フォルダを作る。parent が null ならアカウントの最上位に作る。 */
  onCreateFolder: (account: Account, parent: MailboxSummary | null) => void;
  onRenameFolder: (mailbox: MailboxSummary) => void;
  onDeleteFolder: (mailbox: MailboxSummary) => void;
  /** アプリ内での役割・表示名・アイコン・色を変える。 */
  onCustomizeFolder: (mailbox: MailboxSummary) => void;
};

/** 上へ / 下へ動かす 2 項目。ids は同じ並びの項目 (いまの表示順)。 */
export function MoveItems({
  id,
  ids,
  onReorder,
}: {
  id: string;
  ids: string[];
  onReorder: (ids: string[]) => void;
}) {
  const up = moveBy(ids, id, -1);
  const down = moveBy(ids, id, 1);
  return (
    <>
      <ContextMenuItem disabled={!up} onClick={() => up && onReorder(up)}>
        <ArrowUpIcon />
        上へ移動
        <ContextMenuShortcut>Alt+↑</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!down} onClick={() => down && onReorder(down)}>
        <ArrowDownIcon />
        下へ移動
        <ContextMenuShortcut>Alt+↓</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

/** サイドバーのフォルダを右クリックしたときのメニューの中身。 */
export function FolderMenuItems({
  account,
  mailbox,
  unread,
  siblings,
  hasChildren,
  open,
  onOpen,
  onToggle,
  onReorder,
  actions,
}: {
  account: Account;
  mailbox: MailboxSummary;
  /** このフォルダの未読数 (中のフォルダは含めない)。 */
  unread: number;
  /** 同じ親を持つフォルダ (いまの表示順)。 */
  siblings: MailboxSummary[];
  hasChildren: boolean;
  /** 中のフォルダを表示している。 */
  open: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onReorder: (ids: string[]) => void;
  actions: SidebarMenuActions;
}) {
  const ids = siblings.map((sibling) => sibling.id);
  const sorted = siblings.some((sibling) => sibling.sortOrder !== null);
  return (
    <>
      <ContextMenuItem onClick={onOpen}>
        <FolderOpenIcon />
        開く
      </ContextMenuItem>
      <ContextMenuItem
        disabled={unread === 0}
        onClick={() => actions.onMarkAllRead(mailbox)}
      >
        <MailCheckIcon />
        すべて既読にする
      </ContextMenuItem>
      {hasChildren && (
        <ContextMenuItem onClick={onToggle}>
          {open ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
          {open ? "中のフォルダを折りたたむ" : "中のフォルダを表示"}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <MoveItems id={mailbox.id} ids={ids} onReorder={onReorder} />
      <ContextMenuItem
        disabled={!sorted}
        onClick={() => actions.onResetOrder(ids)}
      >
        <ListRestartIcon />
        並び順を元に戻す
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => actions.onCreateFolder(account, mailbox)}>
        <FolderPlusIcon />
        新しいサブフォルダ…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onCustomizeFolder(mailbox)}>
        <FolderCogIcon />
        役割と見た目を変更…
      </ContextMenuItem>
      {/* 受信トレイなどの役割があるフォルダは、名前の変更や削除ができない。 */}
      {mailbox.specialUse === null && !mailbox.detectedSpecialUse && (
        <>
          <ContextMenuItem onClick={() => actions.onRenameFolder(mailbox)}>
            <FolderPenIcon />
            名前を変更…
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={hasChildren}
            onClick={() => actions.onDeleteFolder(mailbox)}
          >
            <Trash2Icon />
            フォルダを削除…
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

/** サイドバーのアカウントを右クリックしたときのメニューの中身。 */
export function AccountMenuItems({
  account,
  accountIds,
  mailboxes,
  open,
  onOpen,
  onToggle,
  onReorder,
  actions,
}: {
  account: Account;
  /** すべてのアカウント (いまの表示順)。 */
  accountIds: string[];
  /** このアカウントのフォルダ。 */
  mailboxes: MailboxSummary[];
  /** フォルダを表示している。 */
  open: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onReorder: (ids: string[]) => void;
  actions: SidebarMenuActions;
}) {
  const sorted = mailboxes.filter((mailbox) => mailbox.sortOrder !== null);
  const provider =
    account.status === "auth_required" ? oauthProviderOf(account) : null;
  return (
    <>
      <ContextMenuItem onClick={onOpen}>
        <InboxIcon />
        受信トレイを開く
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onSyncNow(account)}>
        <RefreshCwIcon />
        今すぐ同期
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.onCreateFolder(account, null)}>
        <FolderPlusIcon />
        新しいフォルダ…
      </ContextMenuItem>
      {provider && (
        <ContextMenuItem onClick={() => actions.onReauth(account)}>
          <LogInIcon />
          {provider === "google" ? "Google" : "Microsoft"} にログインし直す
        </ContextMenuItem>
      )}
      {mailboxes.length > 0 && (
        <ContextMenuItem onClick={onToggle}>
          {open ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
          {open ? "フォルダを折りたたむ" : "フォルダを表示"}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <MoveItems id={account.id} ids={accountIds} onReorder={onReorder} />
      <ContextMenuItem
        disabled={sorted.length === 0}
        onClick={() =>
          actions.onResetOrder(sorted.map((mailbox) => mailbox.id))
        }
      >
        <ListRestartIcon />
        フォルダの並び順を元に戻す
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => actions.onEditSignature(account)}>
        <SignatureIcon />
        署名を編集
      </ContextMenuItem>
      <ContextMenuItem onClick={actions.onOpenSettings}>
        <SettingsIcon />
        設定を開く
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() => actions.onDeleteAccount(account)}
      >
        <Trash2Icon />
        アカウントを削除
      </ContextMenuItem>
    </>
  );
}
