import { createHash } from "node:crypto";
import {
  type CalendarSyncNotification,
  CHANNEL_CALENDAR_SYNC,
  calendarLockKey,
  type EventFieldName,
  type EventOutboxOperation,
  type ImipPlan,
} from "@orbit/core";
import { accounts, calendars, type Database, events, outbox } from "@orbit/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type CalendarRow = typeof calendars.$inferSelect;
type EventRow = typeof events.$inferSelect;

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

/**
 * プロバイダのカレンダーへ書き戻せない状態なら、その理由 (calendars.ts の作成・変更・削除と、
 * メールの招待の反映 (invite-apply.ts) で使う)。
 * - calendar_disabled: アカウントの calendarEnabled が false (同期が動かず、書き戻しが溜まるだけ)。
 * - calendar_sync_stopped: 認証の失敗などで同期が止まっている (accounts.calendarError がある。
 *   同期ワーカーは、止まったときだけ calendarError を書く)。
 * Orbit 内のカレンダーなどは null。
 */
export async function providerWriteBlocked(
  tx: Tx,
  calendar: Pick<CalendarRow, "source" | "accountId">,
): Promise<"calendar_disabled" | "calendar_sync_stopped" | null> {
  if (!isProviderCalendar(calendar)) return null;
  const [account] = await tx
    .select({
      calendarEnabled: accounts.calendarEnabled,
      calendarError: accounts.calendarError,
    })
    .from(accounts)
    .where(eq(accounts.id, calendar.accountId));
  if (!account || !account.calendarEnabled) return "calendar_disabled";
  if (account.calendarError !== null) return "calendar_sync_stopped";
  return null;
}

async function lockEvent(tx: Tx, userId: string, id: string) {
  const [row] = await tx
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.userId, userId)))
    .for("update");
  return row;
}

/**
 * 書き換える予定の行をロックする。プロバイダのカレンダーなら、先にカレンダーの同期の
 * アカウント単位のロックを取る (同期ワーカーと同じ順にして、デッドロックを避ける)。
 */
export async function lockEventForWrite(tx: Tx, userId: string, id: string) {
  const [target] = await tx
    .select({
      source: calendars.source,
      accountId: calendars.accountId,
    })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(eq(events.id, id), eq(events.userId, userId)));
  if (target && isProviderCalendar(target)) {
    await lockCalendarAccount(tx, target.accountId);
  }
  return lockEvent(tx, userId, id);
}

/**
 * 変えた項目の書き戻しを積む。accepted は採用した項目とその値 (冪等キーのハッシュに使う)。
 * imip は招待メールの計画 (CalDAV では payload に載せる)。返すのは変更の冪等キー
 * (採用した項目が無ければ null)。row.fieldUpdatedAt は変更後の値を渡す。
 */
export async function enqueueEventUpdate(
  tx: Tx,
  calendar: CalendarRow,
  row: Pick<EventRow, "id" | "fieldUpdatedAt">,
  accepted: Partial<Record<EventFieldName, unknown>>,
  imip: ImipPlan | null = null,
): Promise<string | null> {
  const fields = (Object.keys(accepted) as EventFieldName[])
    .filter((key) => accepted[key] !== undefined)
    .sort();
  if (fields.length === 0) return null;
  const key = eventUpdateKey(
    row.id,
    fields,
    row.fieldUpdatedAt ?? {},
    Object.fromEntries(fields.map((key) => [key, accepted[key]])),
  );
  await enqueueEventOperation(
    tx,
    calendar,
    {
      kind: "event_update",
      payload: {
        eventId: row.id,
        calendarId: calendar.id,
        fields,
        ...(imip ? { imip } : {}),
      },
    },
    key,
  );
  return key;
}

/**
 * 繰り返しの 1 回を、原本の EXDATE に足して取り消す。プロバイダのカレンダーなら、
 * 原本の繰り返しの変更 (event_update { fields: ["recurrence"] }) を積む。返すのは冪等キー。
 */
export async function excludeOccurrence(
  tx: Tx,
  calendar: CalendarRow,
  master: EventRow,
  recurrenceId: string,
  at: Date,
  imip: ImipPlan | null = null,
): Promise<string> {
  const exdates = [...new Set([...(master.exdates ?? []), recurrenceId])];
  // 回を消した時刻 (端末で操作した時刻) を繰り返しの変更時刻にする。ただし EXDATE は
  // 集合に足すだけなので、後から行った規則の変更の時刻を古くはしない。
  const previous = master.fieldUpdatedAt?.recurrence;
  const fieldUpdatedAt = {
    ...(master.fieldUpdatedAt ?? {}),
    recurrence:
      previous && Date.parse(previous) > at.getTime()
        ? previous
        : at.toISOString(),
  };
  await tx
    .update(events)
    .set({ exdates, fieldUpdatedAt })
    .where(eq(events.id, master.id));
  const key = eventUpdateKey(master.id, ["recurrence"], fieldUpdatedAt, {
    recurrence: { exdates },
  });
  await enqueueEventOperation(
    tx,
    calendar,
    {
      kind: "event_update",
      payload: {
        eventId: master.id,
        calendarId: calendar.id,
        fields: ["recurrence"],
        ...(imip ? { imip } : {}),
      },
    },
    key,
  );
  return key;
}

/**
 * 消した予定 (eventIds、例外も含む) に向けた、まだ実行していない作成と変更の書き戻しを取り消す。
 * 作成が確定して失敗した行も、予定ごと消えるので片付ける。
 */
export async function cancelPendingWrites(
  tx: Tx,
  calendar: CalendarRow,
  eventIds: string[],
) {
  if (!isProviderCalendar(calendar) || eventIds.length === 0) return;
  await tx
    .delete(outbox)
    .where(
      and(
        eq(outbox.accountId, calendar.accountId),
        or(
          and(
            inArray(outbox.kind, ["event_create", "event_update"]),
            eq(outbox.status, "pending"),
          ),
          and(eq(outbox.kind, "event_create"), eq(outbox.status, "failed")),
        ),
        inArray(sql<string>`${outbox.payload}->>'eventId'`, eventIds),
      ),
    );
}

/**
 * 予定 (原本か単発) を消したときの書き戻しを積む。cancelPendingWrites のあとに呼ぶ。
 * 作成をまだ書き戻していなければ (remoteId が無い)、相手側に何も無いので積まない。
 * ただし作成の書き戻しを実行中なら、相手側にできる予定を消すために積む (remoteId は null)。
 */
export async function enqueueDelete(
  tx: Tx,
  calendar: CalendarRow,
  row: EventRow,
  deletedAt: Date,
  imip: ImipPlan | null = null,
) {
  if (!isProviderCalendar(calendar)) return;
  if (row.remoteId === null) {
    const [running] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.accountId, calendar.accountId),
          eq(outbox.idempotencyKey, eventCreateKey(row.id)),
          eq(outbox.status, "processing"),
        ),
      );
    if (!running) return;
  }
  await enqueueEventOperation(
    tx,
    calendar,
    {
      kind: "event_delete",
      payload: {
        calendarId: calendar.id,
        target: {
          eventId: row.id,
          calendarId: calendar.id,
          remoteId: row.remoteId,
          etag: row.etag,
          uid: row.uid,
          recurrenceId: row.recurrenceId,
          parentRemoteId: null,
        },
        deletedAt: deletedAt.toISOString(),
        ...(imip ? { imip } : {}),
      },
    },
    eventDeleteKey(row.id),
  );
}
