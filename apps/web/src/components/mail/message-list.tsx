"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import {
  ChevronRightIcon,
  FolderIcon,
  PaperclipIcon,
  ReplyIcon,
  StarIcon,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Hint } from "@/components/hint";
import { MessageMenuItems } from "@/components/mail/message-context-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageActionInput } from "@/lib/actions";
import type { MessageSummary, ThreadMessage } from "@/lib/api";
import { BodyPrefetcher, type PrefetchReason } from "@/lib/body-prefetch";
import { addressLabel, formatListDate } from "@/lib/format";
import { usePreferences } from "@/lib/preferences";
import { highlightParts } from "@/lib/search";
import { flattenRows, itemKey, type ThreadRows } from "@/lib/thread-rows";

/** 一覧を外から操作するための窓口。 */
export type MessageListHandle = {
  /**
   * その行が見える位置までスクロールする。まだ描画していない行でもよい。
   * childId を渡すと、広げた会話 (id) の中のその 1 通の行へ移る。
   */
  scrollToMessage: (id: string, childId?: string) => void;
};

/** 高さを測る前の 1 行の見積もり (差出人、件名、本文 2 行)。 */
/** 行の間隔の設定ごとの、行の上下の余白とチェックボックスの位置。 */
const rowPadding = {
  compact: "py-1.5",
  standard: "py-3",
  comfortable: "py-4",
} as const;
const checkboxTop = {
  compact: "top-2",
  standard: "top-3.5",
  comfortable: "top-4.5",
} as const;
/** 会話を広げる矢印の位置 (1 行目の文字の高さに合わせる)。 */
const chevronTop = {
  compact: "mt-2.5",
  standard: "mt-4",
  comfortable: "mt-5",
} as const;
const previewClamp = {
  0: "hidden",
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
} as const;

const ESTIMATED_ROW_HEIGHT = 88;
/** 広げた会話の中の 1 通の行の見積もり (差出人、本文 1 行)。 */
const ESTIMATED_CHILD_HEIGHT = 52;
/** 見えている範囲の前後に余分に描画しておく行数。 */
const OVERSCAN = 8;

type Props = {
  ref?: Ref<MessageListHandle>;
  /** 一覧をスクロールさせている要素。見えている範囲の行だけを描画するのに使う。 */
  scrollRef: RefObject<HTMLElement | null>;
  messages: MessageSummary[] | null;
  error: string | null;
  selectedId: string | null;
  /** 広げた会話の中の 1 通だけを開いているときの、その行 (rowId) とメール (id)。 */
  selectedChild: { rowId: string; id: string } | null;
  /** 広げている会話の行と、その中身。 */
  expandedIds: ReadonlySet<string>;
  threadRows: ThreadRows;
  /** 会話の行を広げる / 閉じる。 */
  onToggleExpand: (id: string) => void;
  /** 広げた会話の中の 1 通を開く。 */
  onSelectChild: (rowId: string, childId: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  /** 差出人の代わりに宛先を表示する (送信済み、下書き)。 */
  showRecipients?: boolean;
  /** 1 通も無いときの文言。 */
  emptyText?: string;
  /** 検索結果で目立たせる語。 */
  highlightTerms?: string[];
  /** 検索結果で、メールのある場所 (アカウントとフォルダ) を各行に出すための関数。 */
  locationLabel?: (message: MessageSummary) => string | null;
  /**
   * 複数のアカウントのメールが並ぶ一覧で、どのアカウントのメールかを示すための関数。
   * アカウントの印 (設定したアイコンか色の点) と、読み上げ用のアカウント名を返す。
   */
  accountMark?: (
    message: MessageSummary,
  ) => { mark: ReactNode; name: string } | null;
  /** チェックを付けた行 (複数選択)。 */
  checkedIds: ReadonlySet<string>;
  /** 選択中。各行にチェックボックスを出し、行を押すとチェックを切り替える。 */
  selecting: boolean;
  onSelect: (id: string) => void;
  /** 行のチェックを切り替える。range が true なら、直前に操作した行からこの行までを選ぶ。 */
  onToggleCheck: (id: string, range: boolean) => void;
  /** 右クリックメニューからの操作。 */
  onAction: (messageIds: string[], input: MessageActionInput) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  /**
   * 本文をまだ取り込んでいないメールの先読みを頼む (カーソルを載せた行、画面に見えている行)。
   * 渡さなければ頼まない。
   */
  onPrefetch?: (ids: string[], reason: PrefetchReason) => void;
};

/** 検索した語に当たる部分を目立たせて表示する。 */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return text;
  let offset = 0;
  return highlightParts(text, terms).map((part) => {
    const key = offset;
    offset += part.text.length;
    return part.match ? (
      <mark
        key={key}
        className="rounded-[2px] bg-amber-200 text-inherit dark:bg-amber-500/40"
      >
        {part.text}
      </mark>
    ) : (
      part.text
    );
  });
}

/** 広げた会話の中の 1 通。押すと、その 1 通だけを開く。 */
function ThreadChildRow({
  child,
  selected,
  showRecipients,
  onSelect,
}: {
  child: ThreadMessage;
  selected: boolean;
  showRecipients: boolean;
  onSelect: () => void;
}) {
  const preferences = usePreferences();
  const unread = !child.seen;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full select-none flex-col gap-0.5 py-1.5 pr-4 pl-9 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
        selected && "bg-muted",
      )}
    >
      <span className="flex items-center gap-2">
        {unread && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            unread ? "font-semibold" : "text-muted-foreground",
          )}
        >
          {unread && <span className="sr-only">未読 </span>}
          {child.draft && <span>下書き · </span>}
          {showRecipients
            ? child.to.length > 0
              ? `宛先: ${child.to.map(addressLabel).join("、")}`
              : "(宛先なし)"
            : addressLabel(child.from[0])}
        </span>
        <span className="flex-1" />
        {preferences.showListIcons && child.answered && (
          <ReplyIcon
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="返信済み"
          />
        )}
        {preferences.showListIcons && child.flagged && (
          <StarIcon
            className="size-3 shrink-0 fill-amber-400 text-amber-500"
            aria-label="スター付き"
          />
        )}
        {preferences.showListIcons && child.hasAttachments && (
          <PaperclipIcon
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="添付ファイルあり"
          />
        )}
        <time
          dateTime={child.receivedAt}
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
        >
          {formatListDate(child.receivedAt, new Date(), preferences)}
        </time>
      </span>
      {child.snippet && (
        <span className="line-clamp-1 text-muted-foreground text-xs">
          {child.snippet}
        </span>
      )}
    </button>
  );
}

export function MessageList({
  ref,
  scrollRef,
  messages,
  error,
  selectedId,
  selectedChild,
  expandedIds,
  threadRows,
  onToggleExpand,
  onSelectChild,
  hasMore,
  loadingMore,
  showRecipients = false,
  emptyText = "メールはまだありません。同期が終わるとここに表示されます。",
  highlightTerms = [],
  locationLabel,
  accountMark,
  checkedIds,
  selecting,
  onSelect,
  onToggleCheck,
  onAction,
  onLoadMore,
  onRetry,
  onPrefetch,
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

  // 一覧の上に出すもの (エラーの帯) の分だけ、行の並びはスクロール領域の先頭からずれる。
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const hasError = error !== null;
  const hasRows = count > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 帯や行の有無が変わったときに測り直す
  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0);
  }, [hasError, hasRows]);

  // 見えている範囲の行だけを描画する (仮想化)。行の高さは本文の行数などで変わるので、
  // 描画した行を実測して位置を決める。
  // 並べるのは、会話の行と、広げた会話の中のメール。
  const preferences = usePreferences();
  const items = useMemo(
    () => flattenRows(messages ?? [], expandedIds, threadRows),
    [messages, expandedIds, threadRows],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      items[index]?.kind === "row"
        ? ESTIMATED_ROW_HEIGHT
        : ESTIMATED_CHILD_HEIGHT,
    getItemKey: (index) => {
      const item = items[index];
      return item ? itemKey(item) : index;
    },
    overscan: OVERSCAN,
    scrollMargin,
    // 狭い画面でメールを開くと一覧は隠れ (display: none)、行の高さは 0 と測られる。
    // それを覚えると戻ったときに行の位置がずれるので、隠れている間は前の高さのままにする。
    measureElement: (element, _entry, instance) => {
      const height = (element as HTMLElement).offsetHeight;
      if (height > 0) return height;
      const index = instance.indexFromElement(element);
      return instance.measurementsCache[index]?.size ?? ESTIMATED_ROW_HEIGHT;
    },
  });

  // 本文をまだ取り込んでいないメール (アカウントを追加した直後など) は、見ているものから
  // 先に取得してもらう。スクロールが止まっている間の、カーソルを載せた行と見えている行が対象。
  const onPrefetchRef = useRef(onPrefetch);
  onPrefetchRef.current = onPrefetch;
  const [prefetcher] = useState(
    () =>
      new BodyPrefetcher((ids, reason) => onPrefetchRef.current?.(ids, reason)),
  );
  useEffect(() => {
    const element = scrollRef.current;
    const onScroll = () => prefetcher.scrolled();
    element?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element?.removeEventListener("scroll", onScroll);
      prefetcher.dispose();
    };
  }, [prefetcher, scrollRef]);
  const viewTop = virtualizer.scrollOffset ?? 0;
  const viewBottom = viewTop + (virtualizer.scrollRect?.height ?? 0);
  const pendingVisibleKey = virtualizer
    .getVirtualItems()
    .filter((row) => row.end > viewTop && row.start < viewBottom)
    .flatMap((row) => {
      const item = items[row.index];
      return item?.kind === "row" && item.message.bodyPending
        ? [item.message.id]
        : [];
    })
    .join(",");
  useEffect(() => {
    prefetcher.visible(pendingVisibleKey ? pendingVisibleKey.split(",") : []);
  }, [prefetcher, pendingVisibleKey]);

  useImperativeHandle(ref, () => ({
    scrollToMessage(id, childId) {
      const index = items.findIndex((item) =>
        childId === undefined
          ? item.kind === "row" && item.message.id === id
          : item.kind === "child" &&
            item.parent.id === id &&
            item.child.id === childId,
      );
      if (index !== -1) virtualizer.scrollToIndex(index, { align: "auto" });
    },
  }));

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
      <ul
        ref={listRef}
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (!item) return null;
          const position = {
            ref: virtualizer.measureElement,
            "data-index": row.index,
            style: { transform: `translateY(${row.start - scrollMargin}px)` },
          };
          if (item.kind === "status") {
            return (
              <li
                key={itemKey(item)}
                {...position}
                className="absolute top-0 left-0 w-full border-b bg-muted/30 py-2 pr-4 pl-9 text-muted-foreground text-xs"
              >
                {item.status === "loading" ? (
                  <output>会話のメールを読み込み中…</output>
                ) : (
                  <span role="alert">
                    会話のメールを読み込めませんでした。閉じてから、もう一度広げてください。
                  </span>
                )}
              </li>
            );
          }
          if (item.kind === "child") {
            return (
              <li
                key={itemKey(item)}
                {...position}
                data-thread-child={item.child.id}
                className="absolute top-0 left-0 w-full border-b bg-muted/30"
              >
                <ThreadChildRow
                  child={item.child}
                  selected={
                    selectedChild?.rowId === item.parent.id &&
                    selectedChild.id === item.child.id
                  }
                  showRecipients={showRecipients}
                  onSelect={() => onSelectChild(item.parent.id, item.child.id)}
                />
              </li>
            );
          }
          const message = item.message;
          const expandable = message.threadCount > 1;
          const expanded = expandable && expandedIds.has(message.id);
          const unread = !message.seen;
          const preview = message.excerpt || message.snippet;
          const location = locationLabel?.(message);
          const checked = checkedIds.has(message.id);
          const mark = preferences.showAccountMark
            ? accountMark?.(message)
            : undefined;
          return (
            <ContextMenu key={message.id}>
              <ContextMenuTrigger
                render={
                  <li
                    ref={virtualizer.measureElement}
                    data-index={row.index}
                    data-message-id={message.id}
                    aria-setsize={hasMore ? -1 : count}
                    aria-posinset={item.index + 1}
                    className="absolute top-0 left-0 w-full border-b"
                    onPointerEnter={(event) => {
                      if (event.pointerType === "mouse") {
                        prefetcher.hover(
                          message.bodyPending ? message.id : null,
                        );
                      }
                    }}
                    onPointerLeave={() => prefetcher.hover(null)}
                    style={{
                      transform: `translateY(${row.start - scrollMargin}px)`,
                    }}
                  />
                }
              >
                {expandable && (
                  // 行の左端の余白に置く。行そのもの (メールを開くボタン) とは別のボタン。
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={
                      expanded
                        ? "会話のメールの一覧を閉じる"
                        : `会話のメール ${message.threadCount} 通を一覧に出す`
                    }
                    onClick={() => onToggleExpand(message.id)}
                    className="absolute top-0 left-0 z-10 flex h-full w-5 items-start justify-start rounded-sm pl-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:w-7"
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3.5 transition-transform",
                        chevronTop[preferences.density],
                        expanded && "rotate-90",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                )}
                {selecting && (
                  <Checkbox
                    checked={checked}
                    aria-label={`${message.subject || "(件名なし)"} を選択`}
                    // Shift を押しているかを知るため、切り替えは onClick で受ける。
                    onClick={(event) =>
                      onToggleCheck(message.id, event.shiftKey)
                    }
                    className={cn(
                      "absolute left-4 z-10",
                      checkboxTop[preferences.density],
                    )}
                  />
                )}
                <button
                  type="button"
                  onClick={(event) => {
                    // Shift / Ctrl (Cmd) を押しながら、または選択中は、開かずにチェックを切り替える。
                    if (event.shiftKey) onToggleCheck(message.id, true);
                    else if (selecting || event.ctrlKey || event.metaKey) {
                      onToggleCheck(message.id, false);
                    } else onSelect(message.id);
                  }}
                  aria-current={selectedId === message.id ? "true" : undefined}
                  className={cn(
                    "flex w-full select-none flex-col gap-0.5 px-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                    rowPadding[preferences.density],
                    selecting && "pl-11",
                    selectedId === message.id && "bg-muted",
                    checked && "bg-primary/10 hover:bg-primary/15",
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
                        "min-w-0 truncate text-sm",
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
                    {message.threadCount > 1 && (
                      <span
                        role="img"
                        className="shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground tabular-nums leading-4"
                        aria-label={`${message.threadCount} 通のやり取り`}
                      >
                        {message.threadCount}
                      </span>
                    )}
                    {/* 差出人と件数を左に寄せ、残りを右端に置く。 */}
                    <span className="flex-1" />
                    {preferences.showListIcons && message.answered && (
                      <ReplyIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label="返信済み"
                      />
                    )}
                    {preferences.showListIcons && message.flagged && (
                      <StarIcon
                        className="size-3.5 shrink-0 fill-amber-400 text-amber-500"
                        aria-label="スター付き"
                      />
                    )}
                    {preferences.showListIcons && message.hasAttachments && (
                      <PaperclipIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label="添付ファイルあり"
                      />
                    )}
                    {mark && (
                      <Hint label={mark.name}>
                        <span
                          role="img"
                          aria-label={mark.name}
                          className="flex shrink-0"
                        >
                          {mark.mark}
                        </span>
                      </Hint>
                    )}
                    <time
                      dateTime={message.receivedAt}
                      className="shrink-0 text-muted-foreground text-xs tabular-nums"
                    >
                      {formatListDate(
                        message.receivedAt,
                        new Date(),
                        preferences,
                      )}
                    </time>
                  </span>
                  <span
                    className={cn(
                      "truncate text-sm",
                      unread && "font-semibold",
                    )}
                  >
                    {message.subject ? (
                      <Highlighted
                        text={message.subject}
                        terms={highlightTerms}
                      />
                    ) : (
                      "(件名なし)"
                    )}
                  </span>
                  {preview && preferences.previewLines > 0 && (
                    <span
                      className={cn(
                        "text-muted-foreground text-xs",
                        previewClamp[preferences.previewLines],
                      )}
                    >
                      <Highlighted text={preview} terms={highlightTerms} />
                    </span>
                  )}
                  {location && (
                    <span className="mt-0.5 flex items-center gap-1 text-muted-foreground text-xs">
                      <FolderIcon
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="truncate">{location}</span>
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-56">
                <MessageMenuItems message={message} onAction={onAction} />
              </ContextMenuContent>
            </ContextMenu>
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
