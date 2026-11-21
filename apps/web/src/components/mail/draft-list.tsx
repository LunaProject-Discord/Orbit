"use client";

import { cn } from "cn";
import { PaperclipIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Account, ServerDraft } from "@/lib/api";
import { addressLabel, formatListDate } from "@/lib/format";

type Props = {
  /** サーバーに保存してある下書き。読み込み前は null。 */
  drafts: ServerDraft[] | null;
  accounts: Account[];
  /** 作成画面で開いている下書き。 */
  openId: string | null;
  onOpen: (draft: ServerDraft) => void;
  onDiscard: (draft: ServerDraft) => void;
};

function recipientsOf(draft: ServerDraft): string {
  const all = [...draft.to.list, ...draft.cc.list, ...draft.bcc.list];
  if (all.length > 0) return `宛先: ${all.map(addressLabel).join("、")}`;
  // 確定していない入力途中の宛先も、手がかりとして出す。
  const typing = [draft.to.text, draft.cc.text, draft.bcc.text]
    .map((text) => text.trim())
    .filter(Boolean);
  return typing.length > 0 ? `宛先: ${typing.join("、")}` : "(宛先なし)";
}

/** 下書きの一覧。どの端末で書いたものも並び、選ぶと作成画面で続きを書ける。 */
export function DraftList({
  drafts,
  accounts,
  openId,
  onOpen,
  onDiscard,
}: Props) {
  if (drafts === null) {
    return (
      <div className="flex flex-col" aria-busy="true">
        <output className="sr-only">下書きを読み込み中</output>
        {["a", "b", "c"].map((key) => (
          <div key={key} className="flex flex-col gap-2 border-b px-4 py-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (drafts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-muted-foreground text-sm">
          下書きはありません。書きかけのメールは自動でここに保存され、ほかの端末からも続きを書けます。
        </p>
      </div>
    );
  }
  return (
    <ul>
      {drafts.map((draft) => {
        const account = accounts.find((item) => item.id === draft.accountId);
        const subject = draft.subject.trim() || "(件名なし)";
        return (
          <li key={draft.id} className="group/draft relative border-b">
            <button
              type="button"
              onClick={() => onOpen(draft)}
              aria-current={openId === draft.id ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-0.5 py-3 pr-12 pl-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                openId === draft.id && "bg-muted",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
                  {recipientsOf(draft)}
                </span>
                {draft.attachments.length > 0 && (
                  <PaperclipIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label="添付ファイルあり"
                  />
                )}
                <time
                  dateTime={draft.updatedAt}
                  className="shrink-0 text-muted-foreground text-xs tabular-nums"
                >
                  {formatListDate(draft.updatedAt)}
                </time>
              </span>
              <span className="truncate font-medium text-sm">{subject}</span>
              {draft.snippet && (
                <span className="line-clamp-2 text-muted-foreground text-xs">
                  {draft.snippet}
                </span>
              )}
              {accounts.length > 1 && account && (
                <span className="truncate text-muted-foreground text-xs">
                  差出人: {account.displayName || account.email}
                </span>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`下書き「${subject}」を破棄`}
              title="下書きを破棄"
              onClick={() => onDiscard(draft)}
              className="absolute right-2 bottom-2 opacity-0 focus-visible:opacity-100 group-hover/draft:opacity-100 pointer-coarse:opacity-100"
            >
              <Trash2Icon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
