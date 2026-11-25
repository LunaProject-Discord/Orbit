"use client";

import { cn } from "cn";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Columns3Icon,
  FolderIcon,
  PaperclipIcon,
  ReplyIcon,
  StarIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Hint } from "@/components/hint";
import { ExactTime } from "@/components/mail/exact-time";
import { BAND_IGNORE_ATTRIBUTE } from "@/components/mail/rubber-band";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MessageSummary } from "@/lib/api";
import { addressLabel, type DateStyle, formatTableDate } from "@/lib/format";
import type { ListSort } from "@/lib/list-sort";
import {
  COLUMN_INFO,
  moveColumn,
  nextSort,
  resetTableColumns,
  setColumnVisible,
  setColumnWidth,
  type TableColumn,
  type TableColumnId,
  updateTableView,
} from "@/lib/table-view";

/** 行の間隔の設定ごとの、テーブル表示の 1 行の高さ (px)。 */
export const TABLE_ROW_HEIGHT = {
  compact: 28,
  standard: 32,
  comfortable: 40,
} as const;

/** 行の左端の余白 (会話を広げる矢印を置く)。見出しと行で揃える。 */
export const TABLE_LEFT_PAD = "pl-5";
/** 複数選択中の左端の余白 (チェックボックスを置く)。 */
export const TABLE_LEFT_PAD_SELECTING = "pl-10";

/** 列の見出しのアイコン (細い列)。 */
function narrowIcon(id: TableColumnId): ReactNode {
  switch (id) {
    case "flagged":
      return <StarIcon className="size-3.5" aria-hidden="true" />;
    case "attachment":
      return <PaperclipIcon className="size-3.5" aria-hidden="true" />;
    case "answered":
      return <ReplyIcon className="size-3.5" aria-hidden="true" />;
    case "unread":
      return (
        <span
          className="size-2 rounded-full border border-current"
          aria-hidden="true"
        />
      );
    default:
      return null;
  }
}

/** 列の見出しの名前。差出人の列は、送信済みなどでは宛先になる。 */
export function columnLabel(id: TableColumnId, recipients: boolean): string {
  if (id === "correspondent" && recipients) return "宛先";
  return COLUMN_INFO[id].label;
}

/** 列の表示 / 非表示を選ぶメニューの中身 (見出しの右クリックと、右端のボタンで共通)。 */
function ColumnChoices({
  columns,
  recipients,
  kind,
}: {
  columns: readonly TableColumn[];
  recipients: boolean;
  kind: "context" | "dropdown";
}) {
  const CheckboxItem =
    kind === "context" ? ContextMenuCheckboxItem : DropdownMenuCheckboxItem;
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator =
    kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <>
      {columns.map((column) => (
        <CheckboxItem
          key={column.id}
          checked={column.visible}
          // 件名の列は隠せない (どのメールかが分からなくなるため)。
          disabled={column.id === "subject"}
          onCheckedChange={(checked) => setColumnVisible(column.id, checked)}
        >
          {columnLabel(column.id, recipients)}
        </CheckboxItem>
      ))}
      <Separator />
      <Item onClick={resetTableColumns}>列を標準に戻す</Item>
    </>
  );
}

/**
 * テーブル表示の見出し。押すと並べ替え、ドラッグで列を入れ替え、右端をドラッグして幅を変える。
 * 右クリックか右端のボタンで、出す列を選ぶ。
 */
export function TableHeader({
  columns,
  allColumns,
  template,
  sort,
  recipients,
  selecting,
}: {
  /** 表示する列 (この一覧で使えて、隠していないもの)。 */
  columns: readonly TableColumn[];
  /** 隠している列も含めた、この一覧で使える列。 */
  allColumns: readonly TableColumn[];
  template: string;
  sort: ListSort;
  recipients: boolean;
  selecting: boolean;
}) {
  /** ドラッグして入れ替え中の列と、落とす位置。 */
  const [dragging, setDragging] = useState<TableColumnId | null>(null);
  const [dropAt, setDropAt] = useState<{
    id: TableColumnId;
    side: "before" | "after";
  } | null>(null);
  /** 幅を変えている間は、見出しを押した扱い (並べ替え) にしない。 */
  const resizing = useRef(false);

  function startResize(
    event: React.PointerEvent<HTMLElement>,
    column: TableColumn,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const info = COLUMN_INFO[column.id];
    const startX = event.clientX;
    const startWidth = column.width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    resizing.current = true;
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(
        info.max,
        Math.max(info.min, startWidth + moveEvent.clientX - startX),
      );
      setColumnWidth(column.id, width);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      // 押し終えたときの click を並べ替えと取り違えないよう、少し後で戻す。
      setTimeout(() => {
        resizing.current = false;
      }, 0);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  function resizeByKey(
    event: React.KeyboardEvent<HTMLElement>,
    column: TableColumn,
  ) {
    const step = event.shiftKey ? 40 : 8;
    const delta =
      event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (delta === 0) return;
    event.preventDefault();
    const info = COLUMN_INFO[column.id];
    setColumnWidth(
      column.id,
      Math.min(info.max, Math.max(info.min, column.width + delta)),
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            {...{ [BAND_IGNORE_ATTRIBUTE]: "" }}
            data-table-header=""
            className={cn(
              "sticky top-0 z-20 grid h-8 shrink-0 select-none items-stretch border-b bg-background pr-8 text-muted-foreground text-xs",
              selecting ? TABLE_LEFT_PAD_SELECTING : TABLE_LEFT_PAD,
            )}
            style={{ gridTemplateColumns: template }}
          />
        }
      >
        {columns.map((column, index) => {
          const info = COLUMN_INFO[column.id];
          const label = columnLabel(column.id, recipients);
          const sortKey = info.sort?.(recipients) ?? null;
          const active = sortKey !== null && sort.key === sortKey;
          const resizable = column.id !== "subject" && info.min !== info.max;
          const marker =
            dropAt?.id === column.id && dragging !== column.id
              ? dropAt.side
              : null;
          const content = (
            <>
              {info.narrow ? (
                <span className="flex w-full justify-center">
                  {narrowIcon(column.id)}
                  <span className="sr-only">{label}</span>
                </span>
              ) : (
                <span className="truncate">{label}</span>
              )}
              {active &&
                (sort.order === "asc" ? (
                  <ArrowUpIcon
                    className="size-3 shrink-0 text-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <ArrowDownIcon
                    className="size-3 shrink-0 text-foreground"
                    aria-hidden="true"
                  />
                ))}
            </>
          );
          const cellClass = cn(
            "flex h-full min-w-0 items-center gap-1 outline-none",
            info.narrow ? "justify-center" : "px-2",
            index > 0 && "border-l border-border/60",
            active && "font-medium text-foreground",
          );
          return (
            // 列ごとの見出し。ドラッグで並びを入れ替える (並べ替えと幅の変更は中のボタンとつまみで行う)。
            // biome-ignore lint/a11y/noStaticElementInteractions: ドラッグでの並べ替えはマウス向けの補助で、列の表示は右端のメニューからも選べる
            <div
              key={column.id}
              draggable
              onDragStart={(event) => {
                if (resizing.current) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", column.id);
                setDragging(column.id);
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const side =
                  event.clientX < rect.left + rect.width / 2
                    ? "before"
                    : "after";
                setDropAt((current) =>
                  current?.id === column.id && current.side === side
                    ? current
                    : { id: column.id, side },
                );
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging && dropAt) {
                  updateTableView({
                    columns: moveColumn(
                      allColumns,
                      dragging,
                      dropAt.id,
                      dropAt.side,
                    ),
                  });
                }
                setDragging(null);
                setDropAt(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
              className={cn(
                "relative min-w-0",
                dragging === column.id && "opacity-50",
              )}
            >
              {sortKey !== null ? (
                <Hint label={`${label}で並べ替え`}>
                  <button
                    type="button"
                    aria-label={`${label}で並べ替え`}
                    aria-pressed={active}
                    onClick={() => {
                      if (resizing.current) return;
                      updateTableView({ sort: nextSort(sort, sortKey) });
                    }}
                    className={cn(
                      cellClass,
                      "w-full hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                    )}
                  >
                    {content}
                  </button>
                </Hint>
              ) : info.narrow ? (
                <Hint label={label}>
                  <span className={cellClass}>{content}</span>
                </Hint>
              ) : (
                <span className={cellClass}>{content}</span>
              )}
              {resizable && (
                // 列の右端。ドラッグか左右の矢印キーで幅を変える。
                // biome-ignore lint/a11y/useSemanticElements: 幅を変えるつまみは hr では作れない
                <div
                  role="separator"
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-label={`${label}の列の幅`}
                  aria-valuenow={column.width}
                  aria-valuemin={info.min}
                  aria-valuemax={info.max}
                  onPointerDown={(event) => startResize(event, column)}
                  onKeyDown={(event) => resizeByKey(event, column)}
                  className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none hover:bg-primary/30 focus-visible:bg-primary/40"
                />
              )}
              {marker && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary",
                    marker === "before" ? "-left-px" : "-right-px",
                  )}
                />
              )}
            </div>
          );
        })}
        <DropdownMenu>
          <Hint label="表示する列を選ぶ">
            <DropdownMenuTrigger
              aria-label="表示する列を選ぶ"
              className="absolute inset-y-0 right-0 flex w-8 items-center justify-center border-l border-border/60 outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <Columns3Icon className="size-3.5" aria-hidden="true" />
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>表示する列</DropdownMenuLabel>
              <ColumnChoices
                columns={allColumns}
                recipients={recipients}
                kind="dropdown"
              />
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ColumnChoices
          columns={allColumns}
          recipients={recipients}
          kind="context"
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** テーブル表示の 1 行に出す内容 (会話の行と、広げた会話の中の 1 通で共通)。 */
export type TableRowData = Pick<
  MessageSummary,
  | "subject"
  | "from"
  | "to"
  | "receivedAt"
  | "seen"
  | "flagged"
  | "hasAttachments"
  | "answered"
  | "snippet"
> & {
  excerpt?: string | null;
  /** 会話のメールの数 (広げた中の 1 通では 1)。 */
  threadCount: number;
  draft?: boolean;
};

/**
 * テーブル表示の 1 行のセル。行を押したときの扱いは呼び出し側の button が持つ。
 * スターと未読の列は data-cell で見分け、押すと切り替えられるようにする。
 */
export function TableCells({
  row,
  columns,
  recipients,
  dateStyle,
  child = false,
  subject,
  mark,
  location,
}: {
  row: TableRowData;
  columns: readonly TableColumn[];
  recipients: boolean;
  dateStyle: DateStyle;
  /** 広げた会話の中の 1 通 (件名を字下げする)。 */
  child?: boolean;
  /** 件名の表示 (検索した語を目立たせるなど)。省略すると件名そのもの。 */
  subject?: ReactNode;
  mark?: { mark: ReactNode; name: string } | null;
  location?: string | null;
}) {
  const unread = !row.seen;
  const strong = unread && "font-semibold text-foreground";
  return columns.map((column) => {
    switch (column.id) {
      case "flagged":
        return (
          <span
            key={column.id}
            data-cell="flagged"
            className="flex items-center justify-center"
          >
            <StarIcon
              className={cn(
                "size-3.5",
                row.flagged
                  ? "fill-amber-400 text-amber-500"
                  : "text-muted-foreground/30",
              )}
              aria-hidden="true"
            />
            {row.flagged && <span className="sr-only">スター付き</span>}
          </span>
        );
      case "attachment":
        return (
          <span key={column.id} className="flex items-center justify-center">
            {row.hasAttachments && (
              <PaperclipIcon
                className="size-3.5 text-muted-foreground"
                aria-label="添付ファイルあり"
              />
            )}
          </span>
        );
      case "answered":
        return (
          <span key={column.id} className="flex items-center justify-center">
            {row.answered && (
              <ReplyIcon
                className="size-3.5 text-muted-foreground"
                aria-label="返信済み"
              />
            )}
          </span>
        );
      case "unread":
        return (
          <span
            key={column.id}
            data-cell="unread"
            className="flex items-center justify-center"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                unread ? "bg-primary" : "bg-muted-foreground/25",
              )}
              aria-hidden="true"
            />
          </span>
        );
      case "subject":
        return (
          <span
            key={column.id}
            className={cn(
              "flex min-w-0 items-center gap-1.5 px-2",
              child && "pl-6",
            )}
          >
            {unread && <span className="sr-only">未読 </span>}
            <span className={cn("truncate", strong)}>
              {row.draft && "下書き · "}
              {subject ?? (row.subject || "(件名なし)")}
            </span>
            {row.threadCount > 1 && (
              <span
                role="img"
                className="shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground tabular-nums leading-4"
                aria-label={`${row.threadCount} 通のやり取り`}
              >
                {row.threadCount}
              </span>
            )}
          </span>
        );
      case "correspondent": {
        const text = recipients
          ? row.to.length > 0
            ? row.to.map(addressLabel).join("、")
            : "(宛先なし)"
          : addressLabel(row.from[0]);
        return (
          <span
            key={column.id}
            className={cn("truncate px-2 text-muted-foreground", strong)}
          >
            {recipients && <span className="sr-only">宛先: </span>}
            {text}
          </span>
        );
      }
      case "account":
        return (
          <span
            key={column.id}
            className="flex min-w-0 items-center gap-1.5 px-2 text-muted-foreground"
          >
            {mark && (
              <>
                <span className="flex shrink-0" aria-hidden="true">
                  {mark.mark}
                </span>
                <span className="truncate">{mark.name}</span>
              </>
            )}
          </span>
        );
      case "location":
        return (
          <span
            key={column.id}
            className="flex min-w-0 items-center gap-1 px-2 text-muted-foreground"
          >
            {location && (
              <>
                <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{location}</span>
              </>
            )}
          </span>
        );
      case "date":
        return (
          <span
            key={column.id}
            className={cn(
              "flex min-w-0 items-center px-2 text-muted-foreground tabular-nums",
              strong,
            )}
          >
            <ExactTime value={row.receivedAt} className="truncate">
              {formatTableDate(row.receivedAt, new Date(), dateStyle)}
            </ExactTime>
          </span>
        );
      case "preview":
        return (
          <span key={column.id} className="truncate px-2 text-muted-foreground">
            {row.excerpt || row.snippet}
          </span>
        );
      default:
        return null;
    }
  });
}

/** 押した場所が、スターか未読の列か (行を開く代わりに切り替える)。 */
export function toggledCell(
  target: EventTarget | null,
): "flagged" | "unread" | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest("[data-cell]")?.getAttribute("data-cell");
  return cell === "flagged" || cell === "unread" ? cell : null;
}
