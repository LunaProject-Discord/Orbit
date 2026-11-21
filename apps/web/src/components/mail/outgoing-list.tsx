"use client";

import { CircleAlertIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OutgoingMail } from "@/lib/api";
import { addressLabel } from "@/lib/format";

type Props = {
  outgoing: OutgoingMail[];
  /** 送信できなかったメールを、編集して送り直す。 */
  onEdit: (mail: OutgoingMail) => void;
  /** 送信待ちなら取り消し、失敗していれば一覧から消す。 */
  onRemove: (mail: OutgoingMail) => void;
};

function recipients(mail: OutgoingMail): string {
  const all = [...mail.to, ...mail.cc, ...mail.bcc];
  const first = all[0];
  if (!first) return "";
  return all.length > 1
    ? `${addressLabel(first)} ほか ${all.length - 1} 件`
    : addressLabel(first);
}

/** まだ送り終えていないメール (送信中、やり直し待ち、失敗) の一覧。 */
export function OutgoingList({ outgoing, onEdit, onRemove }: Props) {
  if (outgoing.length === 0) return null;
  return (
    <ul aria-label="送信中のメール" className="shrink-0 border-b">
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
                      ? "送信をやり直しています"
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
                    編集して送り直す
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
