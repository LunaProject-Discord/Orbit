import type { Calendar, CalendarEvent } from "@/lib/calendar/api";
import type { ConflictItem, QueuedOp } from "@/lib/calendar/offline/types";
import {
  CALENDAR_TABLES,
  IndexedDbStore,
  type LocalStore,
  MemoryStore,
  type WriteOp,
} from "@/lib/offline/store";

/**
 * カレンダーの端末の保存先 (2.1)。メールとは別のデータベース calendar-offline-<利用者 ID>。
 * 開いたときに全部をメモリーに読み、以後はメモリーの Map で引く。IndexedDB は残すためだけに使う。
 */

export const SCHEMA_VERSION = 1;

export const calendarDatabaseName = (userId: string) =>
  `calendar-offline-${userId}`;

/** calMeta の値。 */
export type CalendarMeta = {
  /** 差分同期の位置 (latestSeq)。 */
  cursor: string;
  /** since=0 から最後まで取り終えたか。 */
  initialSyncDone: boolean;
  schemaVersion: number;
  /** サーバーの未解決の競合の件数と最新の時刻 (/sync の値。古いサーバーでは null)。 */
  openConflicts: number | null;
  conflictsAt: string | null;
  /** サーバーの競合の一覧の控え (オフラインでも出せるように)。 */
  serverConflicts: ConflictItem[];
};

export const emptyMeta = (): CalendarMeta => ({
  cursor: "0",
  initialSyncDone: false,
  schemaVersion: SCHEMA_VERSION,
  openConflicts: null,
  conflictsAt: null,
  serverConflicts: [],
});

export type CalendarSnapshot = {
  meta: CalendarMeta;
  calendars: Calendar[];
  events: CalendarEvent[];
  queue: QueuedOp[];
  notices: ConflictItem[];
};

export async function openCalendarStore(userId: string): Promise<LocalStore> {
  if (typeof indexedDB === "undefined") return new MemoryStore();
  try {
    return await IndexedDbStore.open(
      calendarDatabaseName(userId),
      CALENDAR_TABLES,
    );
  } catch {
    // プライベートブラウズなどで使えない場合。開いている間だけメモリーに持つ。
    return new MemoryStore();
  }
}

export async function deleteCalendarStore(userId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await IndexedDbStore.delete(calendarDatabaseName(userId));
}

const META_KEYS = [
  "cursor",
  "initialSyncDone",
  "schemaVersion",
  "openConflicts",
  "conflictsAt",
  "serverConflicts",
] as const satisfies readonly (keyof CalendarMeta)[];

export async function loadMeta(store: LocalStore): Promise<CalendarMeta> {
  const meta = emptyMeta();
  const values = await Promise.all(
    META_KEYS.map((key) => store.get<unknown>("calMeta", key)),
  );
  META_KEYS.forEach((key, index) => {
    const value = values[index];
    if (value !== undefined) (meta as Record<string, unknown>)[key] = value;
  });
  return meta;
}

export async function loadSnapshot(
  store: LocalStore,
): Promise<CalendarSnapshot> {
  const meta = await loadMeta(store);
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    // 形が変わった控えは使わず、取り直す (送信待ちと通知は残す)。
    const [queue, notices] = await Promise.all([
      store.list<QueuedOp>("calQueue"),
      store.list<ConflictItem>("calNotices"),
    ]);
    const ops: WriteOp[] = [
      ...(await store.keys("calEvents")).map(
        (key): WriteOp => ({ type: "delete", table: "calEvents", key }),
      ),
      ...(await store.keys("calCalendars")).map(
        (key): WriteOp => ({ type: "delete", table: "calCalendars", key }),
      ),
      ...metaWrites(emptyMeta()),
    ];
    await store.write(ops);
    return { meta: emptyMeta(), calendars: [], events: [], queue, notices };
  }
  const [calendars, events, queue, notices] = await Promise.all([
    store.list<Calendar>("calCalendars"),
    store.list<CalendarEvent>("calEvents"),
    store.list<QueuedOp>("calQueue"),
    store.list<ConflictItem>("calNotices"),
  ]);
  return { meta, calendars, events, queue, notices };
}

/** meta の値を書く操作 (渡した項目だけ)。 */
export function metaWrites(meta: Partial<CalendarMeta>): WriteOp[] {
  return Object.entries(meta).map(
    ([key, value]): WriteOp => ({
      type: "put",
      table: "calMeta",
      key,
      value,
    }),
  );
}

export const putEvent = (event: CalendarEvent): WriteOp => ({
  type: "put",
  table: "calEvents",
  key: event.id,
  value: event,
});

export const deleteEvent = (id: string): WriteOp => ({
  type: "delete",
  table: "calEvents",
  key: id,
});

export const putCalendar = (calendar: Calendar): WriteOp => ({
  type: "put",
  table: "calCalendars",
  key: calendar.id,
  value: calendar,
});

export const deleteCalendar = (id: string): WriteOp => ({
  type: "delete",
  table: "calCalendars",
  key: id,
});

export const putOp = (op: QueuedOp): WriteOp => ({
  type: "put",
  table: "calQueue",
  key: op.id,
  value: op,
});

export const deleteOp = (id: string): WriteOp => ({
  type: "delete",
  table: "calQueue",
  key: id,
});

export const putNotice = (notice: ConflictItem): WriteOp => ({
  type: "put",
  table: "calNotices",
  key: notice.id,
  value: notice,
});

export const deleteNotice = (id: string): WriteOp => ({
  type: "delete",
  table: "calNotices",
  key: id,
});

/** 変更番号を比べる (大きい方が新しい)。 */
export function compareSeq(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
