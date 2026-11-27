/**
 * calendarView/delta の同期の位置。calendars.syncToken には、deltaLink に加えて、
 * 差分を作った期間と、知っている原本と例外の ID を JSON で入れる
 * (原本は差分に出てこないので、原本ごとの削除や回の取り消しを確かめるのに使う)。
 */

const DAY_MS = 24 * 60 * 60_000;
/** 同期する期間: 過去 1 年〜未来 2 年 (設計資料のとおり)。 */
export const SYNC_PAST_DAYS = 365;
export const SYNC_FUTURE_DAYS = 730;
/** 期間がこれだけずれたら、新しい期間で全件を取り直す。 */
export const WINDOW_SHIFT_DAYS = 30;

export type SyncState = {
  v: 1;
  /** deltaLink (保存するとき) か nextLink (ページの途中)。 */
  link: string;
  /** 差分を作った期間 (ISO 8601)。 */
  start: string;
  end: string;
  /** 知っている原本の ID。 */
  masters: string[];
  /** 知っている例外の ID → 原本の ID。 */
  exceptions: Record<string, string>;
};

export type PageState = SyncState & {
  full: boolean;
  /** この同期の中で取り直した原本 (同じ原本を 2 回取らない)。 */
  fetched: string[];
  /** 最後のページで、知っている原本をすべて取り直す。 */
  refreshAll: boolean;
};

function startOfUtcDay(ms: number) {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS);
}

/** 全件の同期を始める位置。 */
export function freshSyncState(calendarRemoteId: string, now: Date): PageState {
  const start = startOfUtcDay(now.getTime() - SYNC_PAST_DAYS * DAY_MS)
    .toISOString()
    .replace(/\.000Z$/, "Z");
  const end = startOfUtcDay(now.getTime() + SYNC_FUTURE_DAYS * DAY_MS)
    .toISOString()
    .replace(/\.000Z$/, "Z");
  const link = `/me/calendars/${encodeURIComponent(calendarRemoteId)}/calendarView/delta?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`;
  return {
    v: 1,
    link,
    start,
    end,
    masters: [],
    exceptions: {},
    full: true,
    fetched: [],
    refreshAll: false,
  };
}

/** 期間が古くなった (作ってから 30 日以上たった)。 */
export function windowIsStale(state: SyncState, now: Date): boolean {
  const start = Date.parse(state.start);
  if (Number.isNaN(start)) return true;
  const expected = now.getTime() - SYNC_PAST_DAYS * DAY_MS;
  return expected - start > WINDOW_SHIFT_DAYS * DAY_MS;
}

function isState(value: unknown): value is SyncState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as SyncState;
  return (
    state.v === 1 &&
    typeof state.link === "string" &&
    typeof state.start === "string" &&
    typeof state.end === "string" &&
    Array.isArray(state.masters) &&
    typeof state.exceptions === "object" &&
    state.exceptions !== null
  );
}

export function encodeSyncToken(state: SyncState): string {
  const { v, link, start, end, masters, exceptions } = state;
  return JSON.stringify({ v, link, start, end, masters, exceptions });
}

/** 読めなければ null (全件を取り直す)。 */
export function decodeSyncToken(token: string | null): SyncState | null {
  if (!token) return null;
  try {
    const value = JSON.parse(token) as unknown;
    return isState(value) ? value : null;
  } catch {
    return null;
  }
}

export function encodePageCursor(state: PageState): string {
  return JSON.stringify(state);
}

export function decodePageCursor(cursor: string): PageState | null {
  try {
    const value = JSON.parse(cursor) as PageState;
    if (!isState(value)) return null;
    return {
      ...value,
      full: value.full === true,
      fetched: Array.isArray(value.fetched) ? value.fetched : [],
      refreshAll: value.refreshAll === true,
    };
  } catch {
    return null;
  }
}
