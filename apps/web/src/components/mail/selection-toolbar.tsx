"use client";

import {
  ArchiveIcon,
  FolderInputIcon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  OctagonAlertIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MoveTarget } from "@/components/mail/mailbox-icon";
import {
  ToolbarButton,
  ToolbarSeparator,
  ToolbarTooltip,
} from "@/components/toolbar-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MessageActionInput } from "@/lib/actions";
import type { MailboxSummary, MessageSummary } from "@/lib/api";
import { actionTargets, useMailboxes } from "@/lib/mailboxes";
import { skipsDeleteConfirm } from "@/lib/permanent-delete";
import { shortcutLabels } from "@/lib/shortcuts";

type Props = {
  /** チェックを付けた行。 */
  rows: MessageSummary[];
  /** 一覧に読み込み済みの行の数。 */
  total: number;
  /** 表示中のフォルダ。受信トレイをまとめて表示している間は null。 */
  mailbox: MailboxSummary | null;
  /** 選んだメールのアカウントすべてに、迷惑メールのフォルダがある。 */
  junkAvailable: boolean;
  /** 値が増えると、移動先のメニューを開く (ショートカットキー用)。 */
  moveRequest: number;
  onAction: (rows: MessageSummary[], input: MessageActionInput) => void;
  /** 選んだメールがすべてごみ箱にある (削除は完全な削除になる)。 */
  permanentDelete: boolean;
  /**
   * 選んだメールを削除する。ごみ箱にあるものは完全に削除する。
   * skipConfirm は Shift を押しながら押したとき。
   */
  onDelete: (skipConfirm: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  /** 選択を解除。 */
  onClose: () => void;
};

/** 一覧で複数のメールを選んでいる間、見出しの代わりに出す操作用のツールバー。 */
export function SelectionToolbar({
  rows,
  total,
  mailbox,
  junkAvailable,
  moveRequest,
  onAction,
  permanentDelete,
  onDelete,
  onSelectAll,
  onClose,
}: Props) {
  const count = rows.length;
  const allSeen = rows.every((row) => row.seen);
  // 選んだメールがすべてスター付きなら外し、1 つでも付いていなければ付ける。
  const allFlagged = count > 0 && rows.every((row) => row.flagged);
  const inTrash = mailbox?.specialUse === "trash";
  const inArchive = mailbox?.specialUse === "archive";
  const inJunk = mailbox?.specialUse === "junk";
  const act = (input: MessageActionInput) => onAction(rows, input);
  // 移動先はアカウントごとに違うので、1 つのアカウントのメールだけを選んでいるときに出す。
  const accountId = rows[0]?.accountId ?? null;
  const singleAccount =
    accountId !== null && rows.every((row) => row.accountId === accountId);

  return (
    <TooltipProvider>
      <header
        role="toolbar"
        aria-label="選択したメールの操作"
        data-titlebar=""
        className="flex h-14 shrink-0 items-center gap-1 border-b px-4"
      >
        <Checkbox
          checked={total > 0 && count === total}
          aria-label="すべて選択"
          onCheckedChange={(checked) => onSelectAll(checked)}
        />
        <p
          className="min-w-0 flex-1 truncate pl-3 font-medium text-sm"
          aria-live="polite"
        >
          {count > 0 ? (
            <>
              {count} 件{/* スマホ幅ではボタンに場所を譲り、件数だけを出す。 */}
              <span className="max-sm:hidden">を選択中</span>
            </>
          ) : (
            "メールを選択"
          )}
        </p>
        <ToolbarButton
          disabled={count === 0}
          label={allSeen ? "未読にする" : "既読にする"}
          onClick={() => act({ action: "set_flags", seen: !allSeen })}
        >
          {allSeen ? <MailIcon /> : <MailOpenIcon />}
        </ToolbarButton>
        <ToolbarButton
          disabled={count === 0}
          label={allFlagged ? "スターを外す" : "スターを付ける"}
          shortcut={shortcutLabels.toggleStar}
          onClick={() => act({ action: "set_flags", flagged: !allFlagged })}
        >
          {allFlagged ? <StarOffIcon /> : <StarIcon />}
        </ToolbarButton>
        {!inArchive && !inTrash && (
          <ToolbarButton
            disabled={count === 0}
            label="アーカイブ"
            onClick={() => act({ action: "move", destination: "archive" })}
          >
            <ArchiveIcon />
          </ToolbarButton>
        )}
        {singleAccount && accountId && (
          <MoveMenu
            accountId={accountId}
            currentMailboxId={rows[0]?.mailboxId ?? null}
            moveRequest={moveRequest}
            onMove={(mailboxId) => act({ action: "move", mailboxId })}
          />
        )}
        {/* 迷惑メールと削除は、押し間違えにくいよう最後にまとめる。 */}
        <ToolbarSeparator />
        {inJunk ? (
          <ToolbarButton
            disabled={count === 0}
            label="迷惑メールから戻す"
            onClick={() => act({ action: "move", destination: "inbox" })}
          >
            <MailCheckIcon />
          </ToolbarButton>
        ) : (
          junkAvailable && (
            <ToolbarButton
              disabled={count === 0}
              label="迷惑メールにする"
              onClick={() => act({ action: "move", destination: "junk" })}
            >
              <OctagonAlertIcon />
            </ToolbarButton>
          )
        )}
        <ToolbarButton
          disabled={count === 0}
          label={permanentDelete ? "完全に削除" : "削除"}
          shortcut={shortcutLabels.delete}
          onClick={(event) => onDelete(skipsDeleteConfirm(event))}
        >
          <Trash2Icon />
        </ToolbarButton>
        <ToolbarButton label="選択を解除" onClick={onClose} className="-mr-2">
          <XIcon />
        </ToolbarButton>
      </header>
    </TooltipProvider>
  );
}

function MoveMenu({
  accountId,
  currentMailboxId,
  moveRequest,
  onMove,
}: {
  accountId: string;
  currentMailboxId: string | null;
  moveRequest: number;
  onMove: (mailboxId: string) => void;
}) {
  const mailboxes = useMailboxes(accountId);
  const { destinations } = actionTargets(mailboxes, currentMailboxId);
  const [open, setOpen] = useState(false);
  const handled = useRef(moveRequest);
  useEffect(() => {
    if (moveRequest === handled.current) return;
    handled.current = moveRequest;
    setOpen(true);
  }, [moveRequest]);
  if (destinations.length === 0) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ToolbarTooltip label="移動" shortcut={shortcutLabels.move}>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="移動" />}
        >
          <FolderInputIcon />
        </DropdownMenuTrigger>
      </ToolbarTooltip>
      <DropdownMenuContent align="end" className="w-56">
        {destinations.map((entry) => (
          <DropdownMenuItem
            key={entry.mailbox.id}
            onClick={() => onMove(entry.mailbox.id)}
          >
            <MoveTarget entry={entry} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
