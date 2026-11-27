import {
  type EventFieldName,
  eventFieldValues,
  fieldValuesToChanges,
} from "@orbit/core";
import { type Database, type EventWithExtras, eventConflicts } from "@orbit/db";
import { and, eq, lt } from "drizzle-orm";
import { recordChanges, type Tx } from "../changes.js";

/**
 * 反映されなかった予定の変更を event_conflicts に記録する。端末は /v1/calendars/sync の
 * openConflicts で気づき、/v1/calendars/conflicts で一覧を取る。
 */

/** 記録を残す期間。これより古い行は書き戻しの掃除と同じ時機に消す。 */
export const KEEP_CONFLICTS_MS = 30 * 24 * 60 * 60_000;

export type EventConflictKind = (typeof eventConflicts.$inferInsert)["kind"];

export type EventConflictInput = {
  userId: string;
  calendarId: string;
  eventId: string;
  kind: EventConflictKind;
  fields?: readonly string[];
  /** 負けた側 (Orbit) の値。API の予定の変更 (changes) と同じ形。 */
  lost?: Record<string, unknown> | null;
  /** 消したときの予定全体 (eventSnapshot の形)。 */
  snapshot?: Record<string, unknown> | null;
  title?: string | null;
  reason?: string | null;
};

/** 行の fields の値を、API の変更の形にする (上書きする前の行から負けた値を取る)。 */
export function lostValues(
  row: EventWithExtras,
  fields: readonly EventFieldName[],
): Record<string, unknown> {
  return fieldValuesToChanges(eventFieldValues(row), fields);
}

/**
 * 予定全体の控え。API の作成 (POST /v1/calendars/events) の項目と同じ形に、
 * 原本と回 (parentId、recurrenceId) を足したもの。端末は「復元」で新しい予定として作る。
 */
export function eventSnapshot(row: EventWithExtras): Record<string, unknown> {
  return {
    ...fieldValuesToChanges(eventFieldValues(row)),
    parentId: row.parentId,
    recurrenceId: row.recurrenceId,
  };
}

/**
 * 記録を 1 行足し、カレンダーの変更として端末へ知らせる (同じトランザクションで)。
 */
export async function recordEventConflict(tx: Tx, input: EventConflictInput) {
  await tx.insert(eventConflicts).values({
    userId: input.userId,
    calendarId: input.calendarId,
    eventId: input.eventId,
    kind: input.kind,
    fields: [...(input.fields ?? [])],
    lost: input.lost ?? null,
    snapshot: input.snapshot ?? null,
    title: input.title ?? null,
    reason: input.reason ?? null,
  });
  await recordChanges(tx, input.userId, "calendar", "upsert", [
    input.calendarId,
  ]);
}

/** 利用者の、KEEP_CONFLICTS_MS より古い記録を消す。 */
export async function pruneEventConflicts(
  db: Database,
  userId: string,
  now: Date = new Date(),
) {
  await db
    .delete(eventConflicts)
    .where(
      and(
        eq(eventConflicts.userId, userId),
        lt(
          eventConflicts.createdAt,
          new Date(now.getTime() - KEEP_CONFLICTS_MS),
        ),
      ),
    );
}
