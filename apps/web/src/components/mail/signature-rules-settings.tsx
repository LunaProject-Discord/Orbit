"use client";

import {
  MessagesSquareIcon,
  PencilIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import type { Account, SignatureRule } from "@/lib/api";
import { htmlToText } from "@/lib/compose";

/** 一覧に出す、署名の 1 行目 (書式なし)。 */
function preview(rule: SignatureRule): string {
  if (rule.signatureHtml === null) return "署名を付けない";
  return htmlToText(rule.signatureHtml).replace(/\s+/g, " ").trim();
}

/**
 * 設定画面の「連絡先・会話ごとの署名」。決めてある署名の一覧で、ここから編集と解除ができる。
 * 新しく決めるのは、メールの相手のプロフィールカードと、メール表示のツールバーから。
 */
export function SignatureRulesSettings({
  rules,
  accounts,
  onEdit,
  onDelete,
}: {
  rules: readonly SignatureRule[];
  accounts: Account[];
  onEdit: (rule: SignatureRule) => void;
  onDelete: (rule: SignatureRule) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-base">連絡先・会話ごとの署名</h3>
        <p className="text-muted-foreground text-sm">
          会話の署名、連絡先の署名、アカウントの署名の順に優先して使います。連絡先の署名は、メールの相手の名前を押すと表示されるカードから、会話の署名は、メールを開いたときのツールバーから設定できます。
        </p>
      </div>
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
          まだ設定されていません。
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {rules.map((rule) => {
            const account = accounts.find((item) => item.id === rule.accountId);
            const title =
              rule.kind === "contact"
                ? rule.label
                  ? `${rule.label} <${rule.key}>`
                  : rule.key
                : rule.label || "(件名なし)";
            return (
              <li key={rule.id} className="flex items-center gap-3 p-3">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground [&>svg]:size-4"
                >
                  {rule.kind === "contact" ? (
                    <UserRoundIcon />
                  ) : (
                    <MessagesSquareIcon />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    {rule.kind === "contact" ? "連絡先" : "会話"}
                    {account ? ` (${account.email})` : ""} · {preview(rule)}
                  </p>
                </div>
                <Hint label="編集">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${title} の署名を編集`}
                    onClick={() => onEdit(rule)}
                  >
                    <PencilIcon />
                  </Button>
                </Hint>
                <Hint label="設定を解除">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${title} の署名の設定を解除`}
                    onClick={() => onDelete(rule)}
                  >
                    <Trash2Icon />
                  </Button>
                </Hint>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
