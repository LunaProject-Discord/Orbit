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
  memo,
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
import { ExactTime } from "@/components/mail/exact-time";
import { MessageMenuItems } from "@/components/mail/message-context-menu";
import {
  TABLE_LEFT_PAD,
  TABLE_LEFT_PAD_SELECTING,
  TABLE_ROW_HEIGHT,
  TableCells,
  TableHeader,
  toggledCell,
} from "@/components/mail/message-table";
import {
  BAND_IGNORE_ATTRIBUTE,
  useRubberBand,
} from "@/components/mail/rubber-band";
import { SwipeRow } from "@/components/mail/swipe-row";
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
import { useDateStyle } from "@/lib/date-format-settings";
import { addressLabel, formatListDate } from "@/lib/format";
import type { ListSort } from "@/lib/list-sort";
import type { ActionHandler, ActionOptions } from "@/lib/permanent-delete";
import { usePreferences } from "@/lib/preferences";
import { highlightParts } from "@/lib/search";
import type { SwipeOutcome } from "@/lib/swipe";
import { gridTemplate, type TableColumn, useTableView } from "@/lib/table-view";
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

/** テーブル表示で使う列と、CSS grid の列の幅の指定。 */
type TableLayout = { columns: readonly TableColumn[]; template: string };

type Props = {
  ref?: Ref<MessageListHandle>;
  /**
   * 一覧の見た目。cards は差出人・件名・本文を重ねたカード、table は列に分けた表
   * (Thunderbird のテーブル表示に当たる)。省略すると cards。
   */
  layout?: "cards" | "table";
  /** テーブル表示の見出しに出す、いまの並び順。 */
  sort?: ListSort;
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
   * アカウントのマーク (設定したアイコンか色の点) と、読み上げ用のアカウント名を返す。
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
  /**
   * マウスのドラッグで範囲を選んだとき (ラバーバンド選択)。anchor は次の Shift クリックの起点。
   * 渡さなければ、ドラッグでは選ばない。
   */
  onBandSelect?: (next: Set<string>, anchor: string | null) => void;
  /** 右クリックメニューからの操作。 */
  onAction: ActionHandler;
  /**
   * 複数選択しているときに、チェックを付けた行の上で右クリックメニューから操作したとき。
   * チェックを付けたすべての行が対象になる。渡さなければ、右クリックした行だけを操作する。
   */
  onSelectionAction?: (
    input: MessageActionInput,
    options?: ActionOptions,
  ) => void;
  /** 右クリックメニューの「新しいウィンドウで開く」。渡さなければ、その項目を出さない。 */
  onOpenWindow?: (message: MessageSummary) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  /**
   * 本文をまだ取り込んでいないメールの先読みを頼む (カーソルを載せた行、画面に見えている行)。
   * 渡さなければ頼まない。
   */
  onPrefetch?: (ids: string[], reason: PrefetchReason) => void;
  /**
   * 行を左右にスワイプしたときに行うこと。向きごとに、その行でできなければ null。
   * 渡さなければ、スワイプでは何もしない。
   */
  swipeFor?: (message: MessageSummary) => {
    left: SwipeOutcome | null;
    right: SwipeOutcome | null;
  };
  /** スワイプで「フォルダを選んで移動」をしたとき。移動先を選ぶ画面を開く。 */
  onSwipeMove?: (message: MessageSummary) => void;
  /**
   * 開きそうな行 (カーソルを載せた行、押し始めた行)。開く前に会話と本文を用意しておくのに使う。
   */
  onWarm?: (message: MessageSummary) => void;
};

const NO_TERMS: string[] = [];
/** カーソルを載せてから、開く準備を始めるまでの時間 (通り過ぎただけの行は用意しない)。 */
const WARM_HOVER_MS = 120;

type RowHandlers = {
  select: (id: string) => void;
  toggleCheck: (id: string, range: boolean) => void;
  toggleExpand: (id: string) => void;
  action: ActionHandler;
  /** 右クリックメニューからの操作。複数選択した行の上なら、選んだすべての行が対象。 */
  menuAction: (
    message: MessageSummary,
    ids: string[],
    input: MessageActionInput,
    options?: ActionOptions,
  ) => void;
  swipeMove: (message: MessageSummary) => void;
  openWindow: (message: MessageSummary) => void;
  warm: (message: MessageSummary) => void;
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
  table,
  selecting,
  onSelect,
}: {
  child: ThreadMessage;
  selected: boolean;
  showRecipients: boolean;
  table: TableLayout | null;
  /** 複数選択中 (会話の行と列の位置を揃える)。 */
  selecting: boolean;
  onSelect: () => void;
}) {
  const preferences = usePreferences();
  const dateStyle = useDateStyle();
  const unread = !child.seen;
  if (table) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid w-full select-none items-center pr-8 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
          selecting ? TABLE_LEFT_PAD_SELECTING : TABLE_LEFT_PAD,
          selected && "bg-muted",
        )}
        style={{
          gridTemplateColumns: table.template,
          height: TABLE_ROW_HEIGHT[preferences.density],
        }}
      >
        <TableCells
          row={{ ...child, threadCount: 1 }}
          columns={table.columns}
          recipients={showRecipients}
          dateStyle={dateStyle}
          child
        />
      </button>
    );
  }
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
        <ExactTime
          value={child.receivedAt}
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
        >
          {formatListDate(child.receivedAt, new Date(), dateStyle)}
        </ExactTime>
      </span>
      {child.snippet && (
        <span className="line-clamp-1 text-muted-foreground text-xs">
          {child.snippet}
        </span>
      )}
    </button>
  );
}

/** 一覧の 1 行 (会話 1 つ)。渡した値が変わったときだけ描き直す。 */
const MessageRow = memo(function MessageRow({
  message,
  index,
  position,
  setSize,
  top,
  measureElement,
  selected,
  checked,
  expanded,
  selecting,
  showRecipients,
  highlightTerms,
  locationLabel,
  accountMark,
  swipeFor,
  prefetcher,
  handlers,
  canOpenWindow,
  table,
}: {
  message: MessageSummary;
  /** 仮想化の並びでの位置 (高さの実測に使う)。 */
  index: number;
  /** 読み上げ用の、一覧での位置と件数 (件数が分からなければ -1)。 */
  position: number;
  setSize: number;
  /** 行の表示位置 (px)。 */
  top: number;
  measureElement: (element: Element | null) => void;
  selected: boolean;
  checked: boolean;
  expanded: boolean;
  selecting: boolean;
  showRecipients: boolean;
  highlightTerms: string[];
  locationLabel: Props["locationLabel"];
  accountMark: Props["accountMark"];
  swipeFor: Props["swipeFor"];
  prefetcher: BodyPrefetcher;
  handlers: RowHandlers;
  canOpenWindow: boolean;
  /** テーブル表示の列。null ならカード表示。 */
  table: TableLayout | null;
}) {
  const preferences = usePreferences();
  const dateStyle = useDateStyle();
  const warmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(warmTimer.current), []);
  const expandable = message.threadCount > 1;
  const unread = !message.seen;
  const preview = message.excerpt || message.snippet;
  const location = locationLabel?.(message);
  const mark = preferences.showAccountMark ? accountMark?.(message) : undefined;
  const swipe = swipeFor?.(message);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <li
            ref={measureElement}
            data-index={index}
            data-message-id={message.id}
            aria-setsize={setSize}
            aria-posinset={position}
            className="absolute top-0 left-0 w-full border-b"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") {
                prefetcher.hover(message.bodyPending ? message.id : null);
                clearTimeout(warmTimer.current);
                warmTimer.current = setTimeout(
                  () => handlers.warm(message),
                  WARM_HOVER_MS,
                );
              }
            }}
            onPointerLeave={() => {
              prefetcher.hover(null);
              clearTimeout(warmTimer.current);
            }}
            // 押し始めた時点で準備を始める (押し終えて開くまでの間に、取得を進めておく)。
            onPointerDown={(event) => {
              if (event.button === 0) handlers.warm(message);
            }}
            style={{ transform: `translateY(${top}px)` }}
          />
        }
      >
        <SwipeRow
          left={swipe?.left ?? null}
          right={swipe?.right ?? null}
          // 複数選択中は、行を押してチェックを切り替えるだけにする。
          disabled={selecting}
          wheel={preferences.trackpadSwipe}
          onCommit={(outcome) => {
            // 一覧の 1 行は会話 1 つなので、右クリックメニューと同じく会話ごと操作する。
            if (outcome.input) {
              handlers.action(message.threadMessageIds, outcome.input);
            } else handlers.swipeMove(message);
          }}
        >
          {expandable && (
            // 行の左端の余白に置く。行そのもの (メールを開くボタン) とは別のボタン。
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? "会話のメールの一覧を閉じる"
                  : `会話のメール ${message.threadCount} 通を一覧に表示`
              }
              onClick={() => handlers.toggleExpand(message.id)}
              className={cn(
                "absolute top-0 left-0 z-10 flex h-full w-5 justify-start rounded-sm pl-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:w-7",
                table ? "items-center" : "items-start",
              )}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform",
                  !table && chevronTop[preferences.density],
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
                handlers.toggleCheck(message.id, event.shiftKey)
              }
              className={cn(
                "absolute z-10",
                table
                  ? "top-1/2 left-5 -translate-y-1/2"
                  : cn("left-4", checkboxTop[preferences.density]),
              )}
            />
          )}
          {table ? (
            <button
              type="button"
              onClick={(event) => {
                if (event.shiftKey) handlers.toggleCheck(message.id, true);
                else if (selecting || event.ctrlKey || event.metaKey) {
                  handlers.toggleCheck(message.id, false);
                } else {
                  // スターと未読の列を押したときは、開かずに切り替える (Thunderbird と同じ)。
                  const cell = toggledCell(event.target);
                  if (cell === "flagged") {
                    handlers.action(message.threadMessageIds, {
                      action: "set_flags",
                      flagged: !message.flagged,
                    });
                  } else if (cell === "unread") {
                    handlers.action(message.threadMessageIds, {
                      action: "set_flags",
                      seen: !message.seen,
                    });
                  } else handlers.select(message.id);
                }
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "grid w-full select-none items-center pr-8 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                selecting ? TABLE_LEFT_PAD_SELECTING : TABLE_LEFT_PAD,
                selected && "bg-muted",
                checked && "bg-primary/10 hover:bg-primary/15",
              )}
              style={{
                gridTemplateColumns: table.template,
                height: TABLE_ROW_HEIGHT[preferences.density],
              }}
            >
              <TableCells
                row={message}
                columns={table.columns}
                recipients={showRecipients}
                dateStyle={dateStyle}
                subject={
                  message.subject ? (
                    <Highlighted
                      text={message.subject}
                      terms={highlightTerms}
                    />
                  ) : undefined
                }
                mark={mark ?? null}
                location={location ?? null}
              />
            </button>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                // Shift / Ctrl (Cmd) を押しながら、または選択中は、開かずにチェックを切り替える。
                if (event.shiftKey) handlers.toggleCheck(message.id, true);
                else if (selecting || event.ctrlKey || event.metaKey) {
                  handlers.toggleCheck(message.id, false);
                } else handlers.select(message.id);
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex w-full select-none flex-col gap-0.5 px-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                rowPadding[preferences.density],
                selecting && "pl-11",
                selected && "bg-muted",
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
                <ExactTime
                  value={message.receivedAt}
                  className="shrink-0 text-muted-foreground text-xs tabular-nums"
                >
                  {formatListDate(message.receivedAt, new Date(), dateStyle)}
                </ExactTime>
              </span>
              <span
                className={cn("truncate text-sm", unread && "font-semibold")}
              >
                {message.subject ? (
                  <Highlighted text={message.subject} terms={highlightTerms} />
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
                  <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{location}</span>
                </span>
              )}
            </button>
          )}
        </SwipeRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <MessageMenuItems
          message={message}
          onAction={(ids, input, options) =>
            handlers.menuAction(message, ids, input, options)
          }
          onOpenWindow={canOpenWindow ? handlers.openWindow : undefined}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});

export function MessageList({
  ref,
  layout = "cards",
  sort,
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
  highlightTerms = NO_TERMS,
  locationLabel,
  accountMark,
  checkedIds,
  selecting,
  onSelect,
  onToggleCheck,
  onBandSelect,
  onAction,
  onSelectionAction,
  onOpenWindow,
  onLoadMore,
  onRetry,
  onPrefetch,
  onWarm,
  swipeFor,
  onSwipeMove,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 帯や見出し、行の有無が変わったときに測り直す
  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0);
  }, [hasError, hasRows, layout]);

  // 見えている範囲の行だけを描画する (仮想化)。行の高さは本文の行数などで変わるので、
  // 描画した行を実測して位置を決める。
  // 並べるのは、会話の行と、広げた会話の中のメール。
  const items = useMemo(
    () => flattenRows(messages ?? [], expandedIds, threadRows),
    [messages, expandedIds, threadRows],
  );

  // テーブル表示の列。アカウントの列は複数のアカウントが並ぶ一覧、場所の列は検索結果など
  // 場所を出す一覧でだけ使う。
  const preferences = usePreferences();
  const tableView = useTableView();
  const isTable = layout === "table";
  const hasAccountColumn =
    accountMark !== undefined && preferences.showAccountMark;
  const hasLocationColumn = locationLabel !== undefined;
  const tableColumns = useMemo(
    () =>
      tableView.columns.filter(
        (column) =>
          (column.id !== "account" || hasAccountColumn) &&
          (column.id !== "location" || hasLocationColumn),
      ),
    [tableView.columns, hasAccountColumn, hasLocationColumn],
  );
  const table = useMemo<TableLayout | null>(() => {
    if (!isTable) return null;
    const columns = tableColumns.filter((column) => column.visible);
    return { columns, template: gridTemplate(columns) };
  }, [isTable, tableColumns]);
  const tableRowHeight = TABLE_ROW_HEIGHT[preferences.density];

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      isTable
        ? tableRowHeight
        : items[index]?.kind === "row"
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
  // 行に渡す操作。行を描き直さずに済むよう、いつも同じものを渡し、中で最新の関数を呼ぶ。
  const latest = useRef({
    onSelect,
    onToggleCheck,
    onToggleExpand,
    onAction,
    onSelectionAction,
    checkedIds,
    onSwipeMove,
    onOpenWindow,
    onWarm,
  });
  latest.current = {
    onSelect,
    onToggleCheck,
    onToggleExpand,
    onAction,
    onSelectionAction,
    checkedIds,
    onSwipeMove,
    onOpenWindow,
    onWarm,
  };
  const [handlers] = useState<RowHandlers>(() => ({
    select: (id) => latest.current.onSelect(id),
    toggleCheck: (id, range) => latest.current.onToggleCheck(id, range),
    toggleExpand: (id) => latest.current.onToggleExpand(id),
    action: (ids, input, options) =>
      latest.current.onAction(ids, input, options),
    menuAction: (message, ids, input, options) => {
      const { checkedIds, onSelectionAction, onAction } = latest.current;
      // 選んだ行の上で開いたメニューは、選んだすべての行に対して行う (Finder やエクスプローラーと同じ)。
      if (
        onSelectionAction &&
        checkedIds.size > 1 &&
        checkedIds.has(message.id)
      ) {
        onSelectionAction(input, options);
      } else onAction(ids, input, options);
    },
    swipeMove: (message) => latest.current.onSwipeMove?.(message),
    openWindow: (message) => latest.current.onOpenWindow?.(message),
    warm: (message) => latest.current.onWarm?.(message),
  }));
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

  // マウスのドラッグで四角を描いて、掛かった行を選ぶ。描画していない行も、
  // 仮想化の測った位置 (まだ測っていなければ見積もり) で判定する。
  const band = useRubberBand({
    scrollRef,
    enabled: onBandSelect !== undefined && count > 0,
    getRows: () =>
      virtualizer.measurementsCache.flatMap((measure) => {
        const item = items[measure.index];
        return item?.kind === "row"
          ? [{ id: item.message.id, start: measure.start, end: measure.end }]
          : [];
      }),
    getSelected: () => checkedIds,
    onChange: (next, anchor) => onBandSelect?.(next, anchor),
  });

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
    <div className="relative flex flex-col">
      {band && (
        <div
          aria-hidden="true"
          data-rubber-band=""
          className="pointer-events-none absolute z-20 rounded-[3px] border border-blue-500/80 bg-blue-500/15 dark:border-blue-400/80 dark:bg-blue-400/20"
          style={{
            left: band.left,
            top: band.top,
            width: band.width,
            height: band.height,
          }}
        />
      )}
      {table && (
        <TableHeader
          columns={table.columns}
          allColumns={tableColumns}
          template={table.template}
          sort={sort ?? { key: "date", order: "desc" }}
          recipients={showRecipients}
          selecting={selecting}
        />
      )}
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
                    会話のメールを読み込めませんでした。一度閉じてから、もう一度開いてください。
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
                  table={table}
                  selecting={selecting}
                  onSelect={() => onSelectChild(item.parent.id, item.child.id)}
                />
              </li>
            );
          }
          const message = item.message;
          return (
            <MessageRow
              key={message.id}
              message={message}
              index={row.index}
              position={item.index + 1}
              setSize={hasMore ? -1 : count}
              top={row.start - scrollMargin}
              measureElement={virtualizer.measureElement}
              selected={selectedId === message.id}
              checked={checkedIds.has(message.id)}
              expanded={message.threadCount > 1 && expandedIds.has(message.id)}
              selecting={selecting}
              showRecipients={showRecipients}
              highlightTerms={highlightTerms}
              locationLabel={locationLabel}
              accountMark={accountMark}
              swipeFor={swipeFor}
              prefetcher={prefetcher}
              handlers={handlers}
              canOpenWindow={onOpenWindow !== undefined}
              table={table}
            />
          );
        })}
      </ul>
      {hasMore && (
        <div
          ref={loadMoreRef}
          {...{ [BAND_IGNORE_ATTRIBUTE]: "" }}
          className="flex justify-center p-4"
        >
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
