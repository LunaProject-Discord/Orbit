import { useSyncExternalStore } from "react";
import { DEFAULT_SORT, type ListSort, type ListSortKey } from "@/lib/list-sort";

/**
 * メール一覧のテーブル表示の設定 (列の並び・表示・幅、並び順、一覧の幅)。
 * 画面の広さで変わるものなので、端末 (ブラウザー) ごとに localStorage へ保存する。
 */

export const TABLE_COLUMN_IDS = [
  "flagged",
  "attachment",
  "subject",
  "unread",
  "correspondent",
  "account",
  "location",
  "date",
  "answered",
  "preview",
] as const;
export type TableColumnId = (typeof TABLE_COLUMN_IDS)[number];

export type TableColumn = {
  id: TableColumnId;
  visible: boolean;
  width: number;
};

export type TableViewSettings = {
  /** 左から順に並べた列。件名の列は残りの幅に広がる (width は使わない)。 */
  columns: TableColumn[];
  sort: ListSort;
  /** 広い画面で、一覧 (左) とメールの表示 (右) を並べるときの一覧の幅 (px)。 */
  paneWidth: number;
};

/** 列の名前と、幅の下限・上限。 */
export const COLUMN_INFO: Record<
  TableColumnId,
  {
    label: string;
    /** 見出しにアイコンだけを出す細い列。 */
    narrow: boolean;
    min: number;
    max: number;
    /** 見出しを押したときの並べ方。並べられない列は null。 */
    sort: ((recipients: boolean) => ListSortKey) | null;
  }
> = {
  flagged: { label: "スター", narrow: true, min: 28, max: 28, sort: null },
  attachment: { label: "添付", narrow: true, min: 28, max: 28, sort: null },
  subject: {
    label: "件名",
    narrow: false,
    min: 120,
    max: 2000,
    sort: () => "subject",
  },
  unread: { label: "未読", narrow: true, min: 28, max: 28, sort: null },
  correspondent: {
    label: "差出人",
    narrow: false,
    min: 80,
    max: 600,
    sort: (recipients) => (recipients ? "to" : "from"),
  },
  account: {
    label: "アカウント",
    narrow: false,
    min: 36,
    max: 300,
    sort: null,
  },
  location: { label: "場所", narrow: false, min: 80, max: 400, sort: null },
  date: { label: "日時", narrow: false, min: 72, max: 300, sort: () => "date" },
  answered: { label: "返信済み", narrow: true, min: 28, max: 28, sort: null },
  preview: { label: "本文", narrow: false, min: 80, max: 800, sort: null },
};

export const DEFAULT_COLUMNS: TableColumn[] = [
  { id: "flagged", visible: true, width: 28 },
  { id: "attachment", visible: true, width: 28 },
  { id: "subject", visible: true, width: 0 },
  { id: "unread", visible: true, width: 28 },
  { id: "correspondent", visible: true, width: 180 },
  { id: "account", visible: true, width: 104 },
  { id: "location", visible: true, width: 140 },
  { id: "date", visible: true, width: 152 },
  { id: "answered", visible: false, width: 28 },
  { id: "preview", visible: false, width: 240 },
];

export const MIN_PANE_WIDTH = 420;
export const DEFAULT_PANE_WIDTH = 800;

export const DEFAULT_TABLE_VIEW: TableViewSettings = {
  columns: DEFAULT_COLUMNS,
  sort: DEFAULT_SORT,
  paneWidth: DEFAULT_PANE_WIDTH,
};

const KEY = "mail.table-view.v1";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 保存してあった値を読む。知らない列や形の合わない値は捨て、足りない列は標準の位置に足す。 */
export function parseTableView(raw: string | null): TableViewSettings {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "null");
  } catch {
    saved = null;
  }
  if (typeof saved !== "object" || saved === null) return DEFAULT_TABLE_VIEW;
  const value = saved as Record<string, unknown>;

  const columns: TableColumn[] = [];
  const seen = new Set<TableColumnId>();
  if (Array.isArray(value.columns)) {
    for (const item of value.columns) {
      if (typeof item !== "object" || item === null) continue;
      const { id, visible, width } = item as Record<string, unknown>;
      if (
        typeof id !== "string" ||
        !(TABLE_COLUMN_IDS as readonly string[]).includes(id) ||
        seen.has(id as TableColumnId)
      ) {
        continue;
      }
      const columnId = id as TableColumnId;
      const info = COLUMN_INFO[columnId];
      const fallback = DEFAULT_COLUMNS.find((column) => column.id === columnId);
      seen.add(columnId);
      columns.push({
        id: columnId,
        // 件名の列は隠せない (どのメールかが分からなくなるため)。
        visible: columnId === "subject" ? true : visible !== false,
        width:
          typeof width === "number" && Number.isFinite(width)
            ? clamp(width, info.min, info.max)
            : (fallback?.width ?? info.min),
      });
    }
  }
  // 新しく増えた列などは、標準の並びで前にある列のすぐ後ろへ足す。
  for (const [index, column] of DEFAULT_COLUMNS.entries()) {
    if (seen.has(column.id)) continue;
    const before = DEFAULT_COLUMNS.slice(0, index)
      .map((other) => columns.findIndex((item) => item.id === other.id))
      .reduce((max, at) => Math.max(max, at), -1);
    columns.splice(before + 1, 0, column);
  }

  let sort = DEFAULT_SORT;
  if (typeof value.sort === "object" && value.sort !== null) {
    const { key, order } = value.sort as Record<string, unknown>;
    if (
      (key === "date" || key === "subject" || key === "from" || key === "to") &&
      (order === "asc" || order === "desc")
    ) {
      sort = { key, order };
    }
  }

  const paneWidth =
    typeof value.paneWidth === "number" && Number.isFinite(value.paneWidth)
      ? clamp(value.paneWidth, MIN_PANE_WIDTH, 4000)
      : DEFAULT_PANE_WIDTH;

  return { columns, sort, paneWidth };
}

const listeners = new Set<() => void>();
let current: TableViewSettings | null = null;

function read(): TableViewSettings {
  if (current) return current;
  try {
    current = parseTableView(window.localStorage.getItem(KEY));
  } catch {
    current = DEFAULT_TABLE_VIEW;
  }
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // ほかのタブで変えた設定も反映する。
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return;
    current = null;
    for (const item of listeners) item();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** いまのテーブル表示の設定。変わると、使っている部品を描き直す。 */
export function useTableView(): TableViewSettings {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_TABLE_VIEW);
}

/** いまの設定を読む (描画の外から使う)。 */
export function readTableView(): TableViewSettings {
  return read();
}

/** 設定の一部を変えて保存する。 */
export function updateTableView(patch: Partial<TableViewSettings>) {
  current = parseTableView(JSON.stringify({ ...read(), ...patch }));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 保存できなくても、このページを開いている間は有効。
  }
  for (const listener of listeners) listener();
}

/** 列の並び・表示・幅を標準に戻す (並び順と一覧の幅は残す)。 */
export function resetTableColumns() {
  updateTableView({ columns: DEFAULT_COLUMNS });
}

/** 列を表示する / 隠す。 */
export function setColumnVisible(id: TableColumnId, visible: boolean) {
  updateTableView({
    columns: read().columns.map((column) =>
      column.id === id ? { ...column, visible } : column,
    ),
  });
}

/** 列の幅を変える。 */
export function setColumnWidth(id: TableColumnId, width: number) {
  updateTableView({
    columns: read().columns.map((column) =>
      column.id === id ? { ...column, width } : column,
    ),
  });
}

/**
 * 列 (id) を、別の列 (target) の前か後ろへ移す。
 * 隠している列も含めた並びの中で動かす。
 */
export function moveColumn(
  columns: readonly TableColumn[],
  id: TableColumnId,
  target: TableColumnId,
  side: "before" | "after",
): TableColumn[] {
  if (id === target) return [...columns];
  const moving = columns.find((column) => column.id === id);
  if (!moving) return [...columns];
  const rest = columns.filter((column) => column.id !== id);
  const at = rest.findIndex((column) => column.id === target);
  if (at === -1) return [...columns];
  rest.splice(side === "before" ? at : at + 1, 0, moving);
  return rest;
}

/**
 * 見出しを押したときの次の並び順。同じ列なら向きを逆にし、別の列なら
 * 日時は新しい順、それ以外は昇順 (あいうえお順) から始める。
 */
export function nextSort(current: ListSort, key: ListSortKey): ListSort {
  if (current.key === key) {
    return { key, order: current.order === "asc" ? "desc" : "asc" };
  }
  return { key, order: key === "date" ? "desc" : "asc" };
}

/** CSS grid の列の幅の指定。件名の列は残りの幅に広がる。 */
export function gridTemplate(columns: readonly TableColumn[]): string {
  return columns
    .map((column) =>
      column.id === "subject"
        ? `minmax(${COLUMN_INFO.subject.min}px, 1fr)`
        : `${column.width}px`,
    )
    .join(" ");
}
