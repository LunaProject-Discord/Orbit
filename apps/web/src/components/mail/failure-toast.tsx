"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hideFailures, showFailures } from "@/components/mail/toasts";
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
import { useDateStyle } from "@/lib/date-format-settings";
import {
  failureDescription,
  failureReport,
  failureSummary,
} from "@/lib/failures";
import { formatFullDate } from "@/lib/format";

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
 * 知らせそのものは sonner に出し、ここでは詳細の画面を持つ。
 */
export function FailureToast({
  failures,
  accounts,
  mailboxes,
  busy,
  onRetry,
  onDismiss,
}: Props) {
  const dateStyle = useDateStyle();
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

  // 知らせを出す。失敗が片付いたら消す。ボタンから呼ぶ処理は、常に最新のものを使う。
  const latest = useRef({ failures, busy, onRetry });
  latest.current = { failures, busy, onRetry };
  const summary =
    failures.length > 0 ? failureSummary(failures, mailboxes) : null;
  useEffect(() => {
    if (summary === null) {
      hideFailures();
      return;
    }
    showFailures(
      summary,
      () => {
        const now = latest.current;
        if (!now.busy) now.onRetry(now.failures);
      },
      () => setDetailsOpen(true),
    );
  }, [summary]);
  // 画面を離れるとき (ログアウトなど) は消す。
  useEffect(() => hideFailures, []);

  return (
    <Dialog
      // すべて片付いたら、開いていた詳細も閉じる。
      open={detailsOpen && failures.length > 0}
      onOpenChange={setDetailsOpen}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>サーバーに反映できなかった操作</DialogTitle>
          <DialogDescription>
            画面の表示は、メールサーバーの状態に戻してあります。再試行すると、もう一度反映を試みます。
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
                  {formatFullDate(failure.failedAt, dateStyle)}
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
  );
}
