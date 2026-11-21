"use client";

import { cn } from "cn";
import { PaperclipIcon, StarIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageSummary } from "@/lib/api";
import { addressLabel, formatListDate } from "@/lib/format";

type Props = {
  messages: MessageSummary[] | null;
  error: string | null;
  selectedId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** 差出人の代わりに宛先を表示する (送信済み、下書き)。 */
  showRecipients?: boolean;
  /** 1 通も無いときの文言。 */
  emptyText?: string;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

export function MessageList({
  messages,
  error,
  selectedId,
  hasMore,
  loadingMore,
  showRecipients = false,
  emptyText = "メールはまだありません。同期が終わるとここに表示されます。",
  onSelect,
  onLoadMore,
  onRetry,
}: Props) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // 一覧の末尾 (「さらに読み込む」ボタン) が見えたら、続きを自動で読み込む。
  // 読み込みに失敗したあとは繰り返さず、ボタンを押してやり直してもらう。
  // 件数が変わるたびに監視し直すので、読み込んでも末尾が見えたままなら次も読み込む。
  const count = messages?.length ?? 0;
  const autoLoad = hasMore && !loadingMore && !error && count > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: count は監視し直すきっかけとして使う
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!autoLoad || !target) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMoreRef.current();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [autoLoad, count]);

  if (messages === null) {
    if (error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p role="alert" className="text-muted-foreground text-sm">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            再試行
          </Button>
        </div>
      );
    }
    return (
      <div className="flex flex-col" aria-busy="true">
        <output className="sr-only">メールを読み込み中</output>
        {["a", "b", "c", "d", "e", "f"].map((key) => (
          <div key={key} className="flex flex-col gap-2 border-b px-4 py-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {error && (
        <p
          role="alert"
          className="border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
        >
          {error}
        </p>
      )}
      <ul>
        {messages.map((message) => {
          const unread = !message.seen;
          return (
            <li key={message.id} className="border-b">
              <button
                type="button"
                onClick={() => onSelect(message.id)}
                aria-current={selectedId === message.id ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col gap-0.5 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                  selectedId === message.id && "bg-muted",
                )}
              >
                <span className="flex items-center gap-2">
                  {unread && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      unread ? "font-semibold" : "text-muted-foreground",
                    )}
                  >
                    {unread && <span className="sr-only">未読 </span>}
                    {showRecipients
                      ? message.to.length > 0
                        ? `宛先: ${message.to.map(addressLabel).join("、")}`
                        : "(宛先なし)"
                      : addressLabel(message.from[0])}
                  </span>
                  {message.flagged && (
                    <StarIcon
                      className="size-3.5 shrink-0 fill-amber-400 text-amber-500"
                      aria-label="スター付き"
                    />
                  )}
                  {message.hasAttachments && (
                    <PaperclipIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-label="添付ファイルあり"
                    />
                  )}
                  <time
                    dateTime={message.receivedAt}
                    className="shrink-0 text-muted-foreground text-xs tabular-nums"
                  >
                    {formatListDate(message.receivedAt)}
                  </time>
                </span>
                <span
                  className={cn("truncate text-sm", unread && "font-semibold")}
                >
                  {message.subject || "(件名なし)"}
                </span>
                {message.snippet && (
                  <span className="line-clamp-2 text-muted-foreground text-xs">
                    {message.snippet}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div ref={loadMoreRef} className="flex justify-center p-4">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? "読み込み中…" : "さらに読み込む"}
          </Button>
        </div>
      )}
    </div>
  );
}
