"use client";

import {
  ArchiveIcon,
  FolderInputIcon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  OctagonAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MoveTarget } from "@/components/mail/mailbox-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MessageActionInput } from "@/lib/actions";
import type { MailboxSummary, MessageSummary } from "@/lib/api";
import { actionTargets, useMailboxes } from "@/lib/mailboxes";

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
  onSelectAll: (checked: boolean) => void;
  /** 選択をやめる。 */
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
  onSelectAll,
  onClose,
}: Props) {
  const count = rows.length;
  const allSeen = rows.every((row) => row.seen);
  const inTrash = mailbox?.specialUse === "trash";
  const inArchive = mailbox?.specialUse === "archive";
  const inJunk = mailbox?.specialUse === "junk";
  const act = (input: MessageActionInput) => onAction(rows, input);
  // 移動先はアカウントごとに違うので、1 つのアカウントのメールだけを選んでいるときに出す。
  const accountId = rows[0]?.accountId ?? null;
  const singleAccount =
    accountId !== null && rows.every((row) => row.accountId === accountId);

  return (
    <header
      role="toolbar"
      aria-label="選択したメールの操作"
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
        {count > 0 ? `${count} 件を選択中` : "メールを選択"}
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={count === 0}
        aria-label={allSeen ? "未読にする" : "既読にする"}
        title={allSeen ? "未読にする" : "既読にする"}
        onClick={() => act({ action: "set_flags", seen: !allSeen })}
      >
        {allSeen ? <MailIcon /> : <MailOpenIcon />}
      </Button>
      {!inArchive && !inTrash && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={count === 0}
          aria-label="アーカイブ"
          title="アーカイブ"
          onClick={() => act({ action: "move", destination: "archive" })}
        >
          <ArchiveIcon />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={count === 0}
        aria-label={inTrash ? "完全に削除" : "削除"}
        title={inTrash ? "完全に削除" : "削除"}
        onClick={() =>
          act(
            inTrash
              ? { action: "delete" }
              : { action: "move", destination: "trash" },
          )
        }
      >
        <Trash2Icon />
      </Button>
      {inJunk ? (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={count === 0}
          aria-label="迷惑メールから戻す"
          title="迷惑メールから戻す"
          onClick={() => act({ action: "move", destination: "inbox" })}
        >
          <MailCheckIcon />
        </Button>
      ) : (
        junkAvailable && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={count === 0}
            aria-label="迷惑メールとして扱う"
            title="迷惑メールとして扱う"
            onClick={() => act({ action: "move", destination: "junk" })}
          >
            <OctagonAlertIcon />
          </Button>
        )
      )}
      {singleAccount && accountId && (
        <MoveMenu
          accountId={accountId}
          currentMailboxId={rows[0]?.mailboxId ?? null}
          moveRequest={moveRequest}
          onMove={(mailboxId) => act({ action: "move", mailboxId })}
        />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="選択をやめる"
        title="選択をやめる"
        onClick={onClose}
        className="-mr-2"
      >
        <XIcon />
      </Button>
    </header>
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
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="移動"
            title="移動"
          />
        }
      >
        <FolderInputIcon />
      </DropdownMenuTrigger>
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
