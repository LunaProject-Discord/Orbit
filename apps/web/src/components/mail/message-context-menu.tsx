"use client";

import {
  ArchiveIcon,
  FolderInputIcon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  OctagonAlertIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { MoveTarget } from "@/components/mail/mailbox-icon";
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
import { actionTargets, useMailboxes } from "@/lib/mailboxes";
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
  const { archive, trash, inTrash, junk, notJunk, destinations } =
    actionTargets(mailboxes, message.mailboxId);
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
          <ContextMenuSubContent className="w-56" title="移動">
            {destinations.map((entry) => (
              <ContextMenuItem
                key={entry.mailbox.id}
                onClick={() =>
                  act({ action: "move", mailboxId: entry.mailbox.id })
                }
              >
                <MoveTarget entry={entry} />
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {/* 迷惑メールと削除は、押し間違えにくいよう最後にまとめる。 */}
      {(junk || notJunk || trash || inTrash) && <ContextMenuSeparator />}
      {junk && (
        <ContextMenuItem
          onClick={() => act({ action: "move", mailboxId: junk.id })}
        >
          <OctagonAlertIcon />
          迷惑メールにする
          <ContextMenuShortcut>{shortcutLabels.junk}</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      {notJunk && (
        <ContextMenuItem
          onClick={() => act({ action: "move", mailboxId: notJunk.id })}
        >
          <MailCheckIcon />
          迷惑メールから戻す
          <ContextMenuShortcut>{shortcutLabels.junk}</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      {(trash || inTrash) && (
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
      )}
    </>
  );
}
