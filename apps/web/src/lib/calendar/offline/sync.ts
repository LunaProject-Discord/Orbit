import type { CalendarSyncPage } from "@/lib/calendar/api";

/**
 * 差分同期 (2.3)。GET /v1/calendars/sync?since=<cursor> を hasMore の間くり返す。
 * 1 ページごとに apply を呼ぶ (予定とカレンダーの書き込み、削除、cursor の更新を 1 回の write で行う)。
 * 途中で失敗したら、そこまでの cursor は保存されているので、次の pull は続きから取る。
 */

export type PullDeps = {
  fetchPage: (since: string) => Promise<CalendarSyncPage>;
  /** 1 ページを保存する。保存できたら、その次の位置から続ける。 */
  apply: (page: CalendarSyncPage, since: string) => Promise<void>;
};

export type PullResult = {
  cursor: string;
  pages: number;
  /** 最後のページの競合の情報 (古いサーバーでは undefined)。 */
  openConflicts?: number;
  conflictsAt?: string | null;
};

/** 1 回の pull で取るページの上限 (念のため。無限に回らないように)。 */
const MAX_PAGES = 1000;

export async function pullChanges(
  since: string,
  deps: PullDeps,
): Promise<PullResult> {
  let cursor = since;
  let pages = 0;
  let last: CalendarSyncPage | undefined;
  for (;;) {
    const page = await deps.fetchPage(cursor);
    await deps.apply(page, cursor);
    pages += 1;
    last = page;
    const advanced = page.latestSeq !== cursor;
    cursor = page.latestSeq;
    if (!page.hasMore || !advanced || pages >= MAX_PAGES) break;
  }
  return {
    cursor,
    pages,
    ...(last?.openConflicts !== undefined
      ? { openConflicts: last.openConflicts }
      : {}),
    ...(last?.conflictsAt !== undefined
      ? { conflictsAt: last.conflictsAt }
      : {}),
  };
}
