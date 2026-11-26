"use client";

import { CircleAlertIcon, SendIcon, WifiOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OutgoingMail } from "@/lib/api";
import { addressLabel } from "@/lib/format";
import type { QueuedSend } from "@/lib/offline";

type Props = {
  outgoing: OutgoingMail[];
  /** 端末で預かっている、接続後に送るメール。 */
  queued?: QueuedSend[];
  /** サーバーに届く状態か。 */
  online?: boolean;
  /** 預かっているメールを、編集に戻す。 */
  onEditQueued?: (item: QueuedSend) => void;
  /** 預かっているメールの送信を取り消す。 */
  onRemoveQueued?: (item: QueuedSend) => void;
  /** 送信できなかったメールを、編集して再送信。 */
  onEdit: (mail: OutgoingMail) => void;
  /** 送信待ちなら取り消し、失敗していれば一覧から消す。 */
  onRemove: (mail: OutgoingMail) => void;
  /** 一覧の枠いっぱいに表示する (送信待ちの表示)。1 通も無ければ、その旨を出す。 */
  full?: boolean;
};

function recipients(mail: Pick<OutgoingMail, "to" | "cc" | "bcc">): string {
  const all = [...mail.to, ...mail.cc, ...mail.bcc];
  const first = all[0];
  if (!first) return "";
  return all.length > 1
    ? `${addressLabel(first)} ほか ${all.length - 1} 件`
    : addressLabel(first);
}

/** 預かっていたメールをサーバーに断られた理由。 */
function queuedErrorLabel(code: string | null): string {
  switch (code) {
    case "account_not_found":
      return "差出人のアカウントが見つかりません。編集して、別のアカウントを選んでください。";
    case "receive_only":
      return "差出人のアカウントは受信専用のため、送信できません。編集して、別のアカウントを選んでください。";
    case "attachment_not_found":
      return "添付ファイルがサーバーに残っていません。編集して、もう一度添付してください。";
    case "attachments_too_large":
      return "添付ファイルが大きすぎます。";
    case "no_recipients":
    case "too_many_recipients":
      return "宛先を確認してください。";
    default:
      return "サーバーに拒否されました。内容を確認して、もう一度送信してください。";
  }
}

/** まだ送り終えていないメール (接続待ち、送信中、やり直し待ち、失敗) の一覧。 */
export function OutgoingList({
  outgoing,
  queued = [],
  online = true,
  onEdit,
  onRemove,
  onEditQueued,
  onRemoveQueued,
  full = false,
}: Props) {
  if (outgoing.length === 0 && queued.length === 0) {
    if (!full) return null;
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-muted-foreground text-sm">
          送信待ちのメールはありません。送信したメールは、送り終えるまでここに表示されます。
        </p>
      </div>
    );
  }
  return (
    <ul
      aria-label="送信中のメール"
      className={full ? "border-b" : "shrink-0 border-b"}
    >
      {queued.map((item) => {
        const rejected = item.error !== null;
        return (
          <li
            key={item.id}
            className={
              rejected
                ? "flex flex-col gap-1 border-b bg-destructive/10 px-4 py-2 last:border-b-0"
                : "flex flex-col gap-1 border-b bg-muted/50 px-4 py-2 last:border-b-0"
            }
          >
            <div className="flex items-start gap-2">
              {rejected ? (
                <CircleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
              ) : online ? (
                <SendIcon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <WifiOffIcon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1 text-xs">
                <p
                  role={rejected ? "alert" : "status"}
                  className={rejected ? "font-medium text-destructive" : ""}
                >
                  {rejected
                    ? "送信できませんでした"
                    : online
                      ? "送信中…"
                      : "接続後に自動で送信します"}
                </p>
                <p className="truncate text-muted-foreground">
                  {item.input.subject || "(件名なし)"} —{" "}
                  {recipients(item.input)}
                </p>
                {rejected && (
                  <p className="mt-0.5 line-clamp-3 break-words text-muted-foreground">
                    {queuedErrorLabel(item.error)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 pl-6">
              <Button
                variant="outline"
                size="xs"
                onClick={() => onEditQueued?.(item)}
              >
                {rejected ? "編集して再送信" : "編集する"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onRemoveQueued?.(item)}
              >
                {rejected ? "破棄" : "送信を取り消す"}
              </Button>
            </div>
          </li>
        );
      })}
      {outgoing.map((mail) => {
        const failed = mail.status === "failed";
        // やり直しを待っている間は、理由を添えて取り消せるようにする。
        const waiting = mail.status === "pending" && mail.lastError !== null;
        return (
          <li
            key={mail.id}
            className={
              failed
                ? "flex flex-col gap-1 border-b bg-destructive/10 px-4 py-2 last:border-b-0"
                : "flex flex-col gap-1 border-b bg-muted/50 px-4 py-2 last:border-b-0"
            }
          >
            <div className="flex items-start gap-2">
              {failed ? (
                <CircleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
              ) : (
                <SendIcon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1 text-xs">
                <p
                  role={failed ? "alert" : "status"}
                  className={failed ? "font-medium text-destructive" : ""}
                >
                  {failed
                    ? "送信できませんでした"
                    : waiting
                      ? "再送信しています"
                      : "送信中…"}
                </p>
                <p className="truncate text-muted-foreground">
                  {mail.subject || "(件名なし)"} — {recipients(mail)}
                </p>
                {mail.lastError && (
                  <p className="mt-0.5 line-clamp-3 break-words text-muted-foreground">
                    {mail.lastError}
                  </p>
                )}
              </div>
            </div>
            {(failed || waiting) && (
              <div className="flex gap-2 pl-6">
                {failed && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onEdit(mail)}
                  >
                    編集して再送信
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onRemove(mail)}
                >
                  {failed ? "破棄" : "送信を取り消す"}
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
