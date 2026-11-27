import { zValidator } from "@hono/zod-validator";
import {
  type CalendarSyncNotification,
  CHANNEL_CALENDAR_SYNC,
  CHANNEL_OUTBOX,
  IMIP_OUTBOX_KIND,
} from "@orbit/core";
import { accounts, calendars, eventConflicts, events, outbox } from "@orbit/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { recordChanges } from "../lib/changes.js";
import {
  eventCreateKey,
  isProviderCalendar,
  lockCalendarAccount,
} from "../lib/event-outbox.js";

const idParam = z.object({ id: z.uuid() });

/** 一覧で返す件数の上限。 */
const LIST_LIMIT = 100;

type ConflictRow = typeof eventConflicts.$inferSelect;

function publicConflict(row: ConflictRow) {
  return {
    id: row.id,
    calendarId: row.calendarId,
    eventId: row.eventId,
    kind: row.kind,
    fields: row.fields,
    lost: row.lost,
    snapshot: row.snapshot,
    title: row.title,
    reason: row.reason,
    /**
     * 招待メールの失敗 (invite_failed) で、resend-invite で送り直せるか (outbox の行がある)。
     * 送信元が無くて積まなかったものは false (「閉じる」だけ)。
     */
    resendable:
      row.kind === "invite_failed" &&
      typeof row.lost?.outboxId === "string" &&
      row.lost?.partial !== true,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 反映されなかった予定の変更 (同期ワーカーが event_conflicts に記録したもの)。
 * /v1/calendars/conflicts に付ける。端末は /v1/calendars/sync の openConflicts と
 * conflictsAt が変わったときに一覧を取り直す。
 * 「自分の値に戻す」「復元」「やはり削除」は専用の API を作らない。端末が lost や snapshot を
 * 使ってふつうの PATCH / POST / DELETE をいまの時刻で送り、成功したら DELETE /:id で閉じる。
 */
export function calendarConflictRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  /** 未解決の一覧 (新しい順、100 件まで)。 */
  app.get("/", async (c) => {
    const rows = await db
      .select()
      .from(eventConflicts)
      .where(
        and(
          eq(eventConflicts.userId, c.var.user.id),
          isNull(eventConflicts.resolvedAt),
        ),
      )
      .orderBy(desc(eventConflicts.createdAt), desc(eventConflicts.id))
      .limit(LIST_LIMIT);
    return c.json({ conflicts: rows.map(publicConflict) });
  });

  /** 閉じる (resolvedAt を入れる)。閉じ済みでも 204。 */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.var.user.id;
    const found = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(eventConflicts)
        .set({ resolvedAt: sql`coalesce(${eventConflicts.resolvedAt}, now())` })
        .where(
          and(eq(eventConflicts.id, id), eq(eventConflicts.userId, userId)),
        )
        .returning({ calendarId: eventConflicts.calendarId });
      if (!row) return false;
      // ほかの端末が件数を取り直せるよう、カレンダーの変更として知らせる。
      await recordChanges(tx, userId, "calendar", [row.calendarId]);
      return true;
    });
    return found ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  /**
   * 作成の書き戻しをやり直す (create_failed だけ)。失敗した event_create の行を pending に
   * 戻して同期へ知らせ、記録を閉じる。
   * - 404 not_found: 記録が無い。
   * - 409 not_retryable: create_failed ではない (端末がふつうの API で送り直す)。
   * - 410 gone: 予定か、失敗した作成の書き戻しがもう無い。
   */
  app.post("/:id/retry", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.var.user.id;
    const result = await db.transaction(async (tx) => {
      const [conflict] = await tx
        .select()
        .from(eventConflicts)
        .where(
          and(eq(eventConflicts.id, id), eq(eventConflicts.userId, userId)),
        );
      if (!conflict) return "not_found" as const;
      // 招待メールの失敗 (invite_failed) は resend-invite で送り直す。
      if (conflict.kind !== "create_failed") return "not_retryable" as const;
      const [calendar] = await tx
        .select()
        .from(calendars)
        .where(
          and(
            eq(calendars.id, conflict.calendarId),
            eq(calendars.userId, userId),
          ),
        );
      if (!calendar || !isProviderCalendar(calendar)) {
        // 書き戻す先が無い。記録は閉じてから 410 を返す (開いたまま残さない)。
        await tx
          .update(eventConflicts)
          .set({ resolvedAt: new Date() })
          .where(eq(eventConflicts.id, id));
        if (calendar)
          await recordChanges(tx, userId, "calendar", [calendar.id]);
        return "gone" as const;
      }
      await lockCalendarAccount(tx, calendar.accountId);
      const [event] = await tx
        .select({ id: events.id, remoteId: events.remoteId })
        .from(events)
        .where(and(eq(events.id, conflict.eventId), eq(events.userId, userId)));
      const [reset] =
        event && event.remoteId === null
          ? await tx
              .update(outbox)
              .set({
                status: "pending",
                attempts: 0,
                lastError: null,
                firstFailedAt: null,
                runAfter: new Date(),
              })
              .where(
                and(
                  eq(outbox.accountId, calendar.accountId),
                  eq(outbox.idempotencyKey, eventCreateKey(conflict.eventId)),
                  eq(outbox.status, "failed"),
                ),
              )
              .returning({ id: outbox.id })
          : [];
      await tx
        .update(eventConflicts)
        .set({ resolvedAt: new Date() })
        .where(eq(eventConflicts.id, id));
      await recordChanges(tx, userId, "calendar", [calendar.id]);
      if (!reset) return "gone" as const;
      const notification: CalendarSyncNotification = {
        accountId: calendar.accountId,
        reason: "outbox",
      };
      await tx.execute(
        sql`select pg_notify(${CHANNEL_CALENDAR_SYNC}, ${JSON.stringify(notification)})`,
      );
      return "ok" as const;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "not_retryable") {
      return c.json({ error: "not_retryable" }, 409);
    }
    if (result === "gone") return c.json({ error: "gone" }, 410);
    return c.body(null, 202);
  });

  /**
   * 送れなかった招待メールを送り直す (invite_failed だけ。imip-design 6.5)。lost.outboxId の
   * imip_send の行を pending に戻して送信へ知らせ、記録を閉じる。同じメール (同じ Message-ID・
   * DTSTAMP・本文) を送り直すので、予定が既に消えた取り消しでも使える。
   * - 404 not_found: 記録が無い。
   * - 409 not_resendable: invite_failed ではない、積んでいない (送信元が無くて送らなかった)、
   *   一部の宛先だけの失敗 (partial)、
   *   outbox の行が無い・失敗のままでない。
   */
  app.post("/:id/resend-invite", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.var.user.id;
    const result = await db.transaction(async (tx) => {
      const [conflict] = await tx
        .select()
        .from(eventConflicts)
        .where(
          and(eq(eventConflicts.id, id), eq(eventConflicts.userId, userId)),
        )
        .for("update");
      if (!conflict) return "not_found" as const;
      const outboxId = conflict.lost?.outboxId;
      if (
        conflict.kind !== "invite_failed" ||
        typeof outboxId !== "string" ||
        // 一部の宛先だけ拒否された (ほかの宛先には届いた) ものは送り直さない。
        conflict.lost?.partial === true ||
        !z.uuid().safeParse(outboxId).success
      ) {
        return "not_resendable" as const;
      }
      // 送信元のアカウントがその利用者のものであることも確かめる。
      const [reset] = await tx
        .update(outbox)
        .set({
          status: "pending",
          attempts: 0,
          lastError: null,
          firstFailedAt: null,
          runAfter: new Date(),
        })
        .where(
          and(
            eq(outbox.id, outboxId),
            eq(outbox.kind, IMIP_OUTBOX_KIND),
            eq(outbox.status, "failed"),
            sql`${outbox.accountId} in (select ${accounts.id} from ${accounts} where ${accounts.userId} = ${userId})`,
          ),
        )
        .returning({ accountId: outbox.accountId });
      if (!reset) return "not_resendable" as const;
      await tx
        .update(eventConflicts)
        .set({ resolvedAt: new Date() })
        .where(eq(eventConflicts.id, id));
      await recordChanges(tx, userId, "calendar", [conflict.calendarId]);
      await tx.execute(
        sql`select pg_notify(${CHANNEL_OUTBOX}, ${reset.accountId})`,
      );
      return "ok" as const;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "not_resendable") {
      return c.json({ error: "not_resendable" }, 409);
    }
    return c.body(null, 202);
  });

  return app;
}
