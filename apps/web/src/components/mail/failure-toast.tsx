"use client";

import { cn } from "cn";
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  InfoIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Account, FailedOperation, MailboxSummary } from "@/lib/api";
import {
  failureDescription,
  failureReport,
  failureSummary,
} from "@/lib/failures";
import { formatFullDate } from "@/lib/format";

/** 画面の下に重ねて出す知らせの置き場。操作の邪魔にならないよう、中身だけがクリックを受ける。 */
export function ToastRegion({ children }: { children: React.ReactNode }) {
  return (
    // スマホ幅では、右下の「作成」ボタンに重ならない高さに出す。
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2 px-4 max-sm:bottom-24">
      {children}
    </div>
  );
}

const toastClass =
  "pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border bg-popover px-4 py-3 text-popover-foreground text-sm shadow-xl";

/** しばらくすると消える、短い知らせ。 */
export function NoticeToast({
  message,
  tone = "error",
  onClose,
}: {
  message: string;
  tone?: "error" | "info";
  onClose: () => void;
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={toastClass}>
      {tone === "error" ? (
        <CircleAlertIcon
          className="size-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
      ) : (
        <InfoIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <p className="min-w-0">{message}</p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="閉じる"
        onClick={onClose}
        className="-mr-2 shrink-0"
      >
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * 削除や移動のあとに出す知らせ。「元に戻す」を押すと、操作を取り消す。
 * 出ている間は、操作をまだサーバーへ送っていない。
 */
export function UndoToast({
  message,
  onUndo,
  onClose,
}: {
  message: string;
  onUndo: () => void;
  onClose: () => void;
}) {
  return (
    <output
      data-slot="undo-toast"
      className={cn(
        toastClass,
        // 暗い地に明るい文字にして、一覧の上でも目に入るようにする。
        "border-transparent bg-foreground py-2 pr-2 text-background",
      )}
    >
      <p className="min-w-0 py-1">{message}</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onUndo}
        className="shrink-0 font-semibold text-background hover:bg-background/15 hover:text-background dark:hover:bg-background/15"
      >
        <Undo2Icon data-icon="inline-start" />
        元に戻す
        <kbd className="ml-1 hidden font-normal font-sans text-background/60 text-xs pointer-fine:inline">
          Z
        </kbd>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="閉じる"
        onClick={onClose}
        className="shrink-0 text-background/70 hover:bg-background/15 hover:text-background dark:hover:bg-background/15"
      >
        <XIcon />
      </Button>
    </output>
  );
}

type Props = {
  failures: FailedOperation[];
  accounts: Account[];
  mailboxes: MailboxSummary[];
  /** やり直している、または破棄している間は true。 */
  busy: boolean;
  onRetry: (failures: FailedOperation[]) => void;
  onDismiss: (failures: FailedOperation[]) => void;
};

/**
 * メールサーバーへ反映できなかった操作の知らせ。やり直すか破棄するまで出し続ける。
 * 「詳細」で、操作ごとの理由を確かめて個別にやり直せる。
 */
export function FailureToast({
  failures,
  accounts,
  mailboxes,
  busy,
  onRetry,
  onDismiss,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const accountName = (accountId: string) => {
    const account = accounts.find((item) => item.id === accountId);
    return account
      ? account.displayName || account.email
      : "削除済みのアカウント";
  };

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(
        failureReport(failures, mailboxes, accountName),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // コピーできない環境では、表示されている内容を選んでコピーしてもらう。
    }
  }

  return (
    <>
      {failures.length > 0 && (
        <div role="alert" className={`${toastClass} flex-wrap sm:flex-nowrap`}>
          <CircleAlertIcon
            className="size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 sm:flex-none">
            {failureSummary(failures, mailboxes)}
          </p>
          <div className="flex shrink-0 gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRetry(failures)}
            >
              再試行
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDetailsOpen(true)}
            >
              <CopyIcon />
              詳細
            </Button>
          </div>
        </div>
      )}

      <Dialog
        // すべて片付いたら、開いていた詳細も閉じる。
        open={detailsOpen && failures.length > 0}
        onOpenChange={setDetailsOpen}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>サーバーに反映できなかった操作</DialogTitle>
            <DialogDescription>
              画面の表示は、メールサーバーの状態に戻しています。再試行すると、もう一度反映します。
            </DialogDescription>
          </DialogHeader>
          <ul className="-my-2 flex max-h-[50dvh] flex-col divide-y overflow-y-auto">
            {failures.map((failure) => (
              <li key={failure.id} className="flex flex-col gap-2 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {failureDescription(failure, mailboxes)}
                  </p>
                  <p className="truncate text-muted-foreground text-xs">
                    {accountName(failure.accountId)} ·{" "}
                    {formatFullDate(failure.failedAt)}
                  </p>
                </div>
                <p className="select-text break-words rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
                  {failure.error ?? "理由は記録されていません。"}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => onRetry([failure])}
                  >
                    再試行
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => onDismiss([failure])}
                  >
                    破棄
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => void copyReport()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "コピーしました" : "内容をコピー"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onDismiss(failures)}
            >
              すべて破棄
            </Button>
            <Button disabled={busy} onClick={() => onRetry(failures)}>
              すべて再試行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
