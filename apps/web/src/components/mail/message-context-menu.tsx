"use client";

import {
  ArchiveIcon,
  FolderInputIcon,
  MailIcon,
  MailOpenIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import type { MessageActionInput } from "@/lib/actions";
import type { MessageSummary } from "@/lib/api";
import { actionTargets, mailboxLabel, useMailboxes } from "@/lib/mailboxes";
import { shortcutLabels } from "@/lib/shortcuts";

/**
 * 一覧のメールを右クリックしたときのメニューの中身。ツールバーと同じ操作を出す。
 * メニューを開いたときにだけ描画されるので、フォルダ一覧もそのときに取得する。
 */
export function MessageMenuItems({
  message,
  onAction,
}: {
  message: MessageSummary;
  onAction: (messageIds: string[], input: MessageActionInput) => void;
}) {
  const mailboxes = useMailboxes(message.accountId);
  const { archive, trash, inTrash, destinations } = actionTargets(
    mailboxes,
    message.mailboxId,
  );
  // 一覧の 1 行は会話 1 つなので、会話のうちこのフォルダにある分をまとめて操作する。
  const act = (input: MessageActionInput) =>
    onAction(message.threadMessageIds, input);

  return (
    <>
      <ContextMenuItem
        onClick={() => act({ action: "set_flags", seen: !message.seen })}
      >
        {message.seen ? <MailIcon /> : <MailOpenIcon />}
        {message.seen ? "未読にする" : "既読にする"}
        <ContextMenuShortcut>
          {message.seen ? shortcutLabels.markUnread : shortcutLabels.markRead}
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => act({ action: "set_flags", flagged: !message.flagged })}
      >
        <StarIcon />
        {message.flagged ? "スターを外す" : "スターを付ける"}
        <ContextMenuShortcut>{shortcutLabels.toggleStar}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {archive && (
        <ContextMenuItem
          onClick={() => act({ action: "move", mailboxId: archive.id })}
        >
          <ArchiveIcon />
          アーカイブ
          <ContextMenuShortcut>{shortcutLabels.archive}</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      {destinations.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <FolderInputIcon />
            移動
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {destinations.map((mailbox) => (
              <ContextMenuItem
                key={mailbox.id}
                onClick={() => act({ action: "move", mailboxId: mailbox.id })}
              >
                <span className="truncate">{mailboxLabel(mailbox)}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {(trash || inTrash) && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() =>
              act(
                inTrash || !trash
                  ? { action: "delete" }
                  : { action: "move", mailboxId: trash.id },
              )
            }
          >
            <Trash2Icon />
            {inTrash ? "完全に削除" : "削除"}
            <ContextMenuShortcut>{shortcutLabels.delete}</ContextMenuShortcut>
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
