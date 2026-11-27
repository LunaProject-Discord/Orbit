import { createHash } from "node:crypto";
import {
  type CalendarSyncNotification,
  CHANNEL_CALENDAR_SYNC,
  calendarLockKey,
  type EventOutboxOperation,
} from "@orbit/core";
import { type calendars, type Database, outbox } from "@orbit/db";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type CalendarRow = typeof calendars.$inferSelect;

/**
 * 予定の書き戻しの対象になるカレンダーか (プロバイダのカレンダーで、アカウントを持つ)。
 * Orbit 内 (local)、購読 (ics)、祝日 (holidays) は書き戻さない。
 */
export function isProviderCalendar(
  calendar: Pick<CalendarRow, "source" | "accountId">,
): calendar is Pick<CalendarRow, "source"> & { accountId: string } {
  return (
    calendar.accountId !== null &&
    (calendar.source === "google" ||
      calendar.source === "microsoft" ||
      calendar.source === "caldav")
  );
}

/**
 * カレンダーの同期 (同期ワーカー) と順番に実行するための、アカウント単位のロック。
 * 予定の行のロック (select ... for update) より先に取る。ワーカーはこのロックを取ってから
 * 予定の行を書き換えるので、逆の順に取るとデッドロックになる。
 */
export async function lockCalendarAccount(tx: Tx, accountId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${calendarLockKey(accountId)}, 0))`,
  );
}

/**
 * 予定の書き戻しを outbox に積み、カレンダーの同期へ知らせる (NOTIFY はコミット時に届く)。
 * idempotencyKey が同じ操作を積み済みなら何もしない。積んだら true。
 * 書き戻しの対象でないカレンダー (local など) なら何もせず false。
 */
export async function enqueueEventOperation(
  tx: Tx,
  calendar: Pick<CalendarRow, "source" | "accountId">,
  operation: EventOutboxOperation,
  idempotencyKey: string,
): Promise<boolean> {
  if (!isProviderCalendar(calendar)) return false;
  const accountId = calendar.accountId;
  await lockCalendarAccount(tx, accountId);
  const inserted = await tx
    .insert(outbox)
    .values({
      accountId,
      kind: operation.kind,
      payload: operation.payload as unknown as Record<string, unknown>,
      idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: outbox.id });
  const notification: CalendarSyncNotification = {
    accountId,
    reason: "outbox",
  };
  await tx.execute(
    sql`select pg_notify(${CHANNEL_CALENDAR_SYNC}, ${JSON.stringify(notification)})`,
  );
  return inserted.length > 0;
}

/** 予定の作成の idempotencyKey。 */
export function eventCreateKey(eventId: string): string {
  return `event_create:${eventId}`;
}

/** 予定の削除の idempotencyKey。 */
export function eventDeleteKey(eventId: string): string {
  return `event_delete:${eventId}`;
}

/** キーや順番に依らない JSON (オブジェクトのキーを名前順に並べる)。 */
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * 予定の変更の idempotencyKey。採用した項目 (名前順) と、その変更時刻の最大と、
 * 採用した値のハッシュから作る。端末が同じ変更を同じ changedAt で再送すれば同じキーになり、
 * 二重に積まれない。同じ項目を同じ changedAt で別の値に変えたときは、値が違うので積まれる。
 */
export function eventUpdateKey(
  eventId: string,
  fields: readonly string[],
  fieldUpdatedAt: Record<string, string>,
  values: Record<string, unknown>,
): string {
  const sorted = [...fields].sort();
  let latest = "";
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const field of sorted) {
    const at = fieldUpdatedAt[field];
    const time = at ? Date.parse(at) : Number.NaN;
    if (at && !Number.isNaN(time) && time > latestTime) {
      latest = at;
      latestTime = time;
    }
  }
  const hash = createHash("sha256")
    .update(stableJson(Object.fromEntries(sorted.map((f) => [f, values[f]]))))
    .digest("hex")
    .slice(0, 16);
  return `event_update:${eventId}:${sorted.join(",")}:${latest}:${hash}`;
}
