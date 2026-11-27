import { calendars, type Database, listEventEtags } from "@orbit/db";
import { eq } from "drizzle-orm";
import { ingestEventDelta } from "../ingest.js";
import type { AccountRow, CalendarProvider } from "../provider.js";
import { makeProviderContext } from "./provider-contract.js";

/**
 * テスト用: カレンダーを最後のページまで同期する (AccountCalendarSync と同じ読み方)。
 * 本番のコードからは使わない。
 */
export async function syncCalendar(
  db: Database,
  provider: CalendarProvider,
  account: AccountRow,
  calendarId: string,
) {
  const [calendar] = await db
    .select()
    .from(calendars)
    .where(eq(calendars.id, calendarId));
  if (!calendar) throw new Error("カレンダーがありません。");
  const ctx = makeProviderContext({ account });
  const seen = new Set<string>();
  let pageCursor: string | null = null;
  const results = [];
  do {
    const delta = await provider.syncEvents(ctx, calendar, {
      syncToken: calendar.syncToken,
      pageCursor,
      knownEtags: () => listEventEtags(db, calendar.id),
    });
    results.push(
      await ingestEventDelta(db, {
        account,
        calendar,
        provider,
        delta,
        seen,
      }),
    );
    pageCursor = delta.nextPageCursor;
  } while (pageCursor !== null);
  return results;
}
