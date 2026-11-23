"use client";

import { MoveTarget } from "@/components/mail/mailbox-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MessageSummary } from "@/lib/api";
import { actionTargets, useMailboxes } from "@/lib/mailboxes";

/**
 * 移動先のフォルダを選ぶ画面。一覧の行のスワイプ (「フォルダを選んで移動」) から開く。
 * スマホ幅では画面の下に貼り付くシートにし、行は指で押しやすい高さにする。
 */
export function MoveDialog({
  message,
  onMove,
  onClose,
}: {
  /** 移動するメール (会話)。null なら閉じている。 */
  message: MessageSummary | null;
  onMove: (message: MessageSummary, mailboxId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={message !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="move-dialog"
        // スマホ幅では、画面の下に貼り付くシートにする。
        sheet
        className="flex max-h-[min(36rem,calc(100dvh-2rem))] flex-col gap-0 p-0 max-sm:max-h-[80dvh] sm:max-w-sm"
      >
        {message && (
          <MoveDialogBody message={message} onMove={onMove} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoveDialogBody({
  message,
  onMove,
  onClose,
}: {
  message: MessageSummary;
  onMove: (message: MessageSummary, mailboxId: string) => void;
  onClose: () => void;
}) {
  const mailboxes = useMailboxes(message.accountId);
  const { destinations } = actionTargets(mailboxes, message.mailboxId);
  return (
    <>
      <DialogHeader className="shrink-0 px-6 pt-6 pb-3 max-sm:px-4 max-sm:pt-5">
        <DialogTitle>移動先を選ぶ</DialogTitle>
        <DialogDescription className="truncate">
          {message.subject || "(件名なし)"}
        </DialogDescription>
      </DialogHeader>
      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {destinations.length === 0 && (
          <li className="px-4 py-6 text-center text-muted-foreground text-sm">
            移動できるフォルダがありません。
          </li>
        )}
        {destinations.map((entry) => (
          <li key={entry.mailbox.id}>
            <button
              type="button"
              onClick={() => {
                onMove(message, entry.mailbox.id);
                onClose();
              }}
              className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-12 pointer-coarse:gap-3 pointer-coarse:text-base max-sm:min-h-12 max-sm:gap-3 max-sm:text-base [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground pointer-coarse:[&_svg]:size-5"
            >
              <MoveTarget entry={entry} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
