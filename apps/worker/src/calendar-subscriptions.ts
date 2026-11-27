import { loadSubscription } from "@orbit/core";
import { calendars, type Database, replaceCalendarEvents } from "@orbit/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { recordChanges } from "./changes.js";

/** ICS の購読の確認間隔の既定 (1 時間)。 */
export const DEFAULT_ICS_INTERVAL_SECONDS = 60 * 60;
/** 一度に確認する購読の数。 */
export const SUBSCRIPTION_BATCH = 20;

/**
 * 確認の時期が来た ICS の購読を取得し直す。条件付きで取得し、変わっていなければ
 * 確認した時刻だけを進める。取得できなければ lastError に理由を残す (予定は残す)。
 * 返すのは確認した購読の数。
 */
export async function refreshDueSubscriptions(
  db: Database,
  {
    allowPrivate,
    now = new Date(),
    fetchImpl,
    log = console.warn,
  }: {
    allowPrivate: boolean;
    now?: Date;
    fetchImpl?: typeof fetch;
    log?: (message: string, error?: unknown) => void;
  },
): Promise<number> {
  const due = await db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.source, "ics"),
        isNotNull(calendars.url),
        sql`(${calendars.lastSyncedAt} is null or ${calendars.lastSyncedAt}
          + make_interval(secs => coalesce(${calendars.pollIntervalSeconds}, ${DEFAULT_ICS_INTERVAL_SECONDS}))
          <= ${now})`,
      ),
    )
    .orderBy(sql`${calendars.lastSyncedAt} asc nulls first`)
    .limit(SUBSCRIPTION_BATCH);
  for (const calendar of due) {
    if (!calendar.url) continue;
    try {
      const loaded = await loadSubscription(calendar.url, {
        validator: calendar.etag,
        allowPrivate,
        defaultTimeZone: calendar.timeZone ?? "Asia/Tokyo",
        fetchImpl,
      });
      await db.transaction(async (tx) => {
        const set: Partial<typeof calendars.$inferInsert> = {
          lastSyncedAt: now,
          lastError: loaded.status === "error" ? loaded.message : null,
        };
        if (loaded.status === "ok") {
          set.etag = loaded.validator;
          const { upserted, deleted } = await replaceCalendarEvents(
            tx,
            { userId: calendar.userId, calendarId: calendar.id },
            loaded.calendar.events,
          );
          await recordChanges(tx, calendar.userId, "event", "upsert", upserted);
          await recordChanges(tx, calendar.userId, "event", "delete", deleted);
        }
        await tx
          .update(calendars)
          .set(set)
          .where(eq(calendars.id, calendar.id));
        // 状態 (エラーの表示) が変わったときだけ、カレンダーの変更として知らせる。
        if (
          loaded.status === "ok" ||
          (set.lastError ?? null) !== (calendar.lastError ?? null)
        ) {
          await recordChanges(tx, calendar.userId, "calendar", "upsert", [
            calendar.id,
          ]);
        }
      });
    } catch (error) {
      log(`購読 ${calendar.id} を取得し直せませんでした。`, error);
      await db
        .update(calendars)
        .set({ lastSyncedAt: now, lastError: "取得し直せませんでした。" })
        .where(eq(calendars.id, calendar.id));
    }
  }
  return due.length;
}
