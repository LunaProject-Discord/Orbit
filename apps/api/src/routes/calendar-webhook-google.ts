import {
  type CalendarSyncNotification,
  GOOGLE_CALENDAR_WEBHOOK_PATH as CORE_GOOGLE_CALENDAR_WEBHOOK_PATH,
  verifyGoogleCalendarChannelToken,
} from "@orbit/core";
import { calendars, type Database } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

/** 受け口のパス (/v1 の下)。メールの /webhooks/microsoft とは分ける。 */
export const GOOGLE_CALENDAR_WEBHOOK_PATH = CORE_GOOGLE_CALENDAR_WEBHOOK_PATH;

export type GoogleCalendarWebhookDeps = {
  db: Database;
  encryptionKey: Buffer;
  /** カレンダーの同期 (CHANNEL_CALENDAR_SYNC) へ伝える。 */
  notify: (payload: CalendarSyncNotification) => Promise<void>;
};

/** チャンネル ID の上限 (Google の資料では 64 文字)。 */
const MAX_CHANNEL_ID = 64;
const RESOURCE_STATES = new Set(["sync", "exists", "not_exists"]);

/**
 * Google カレンダーの変更通知 (events.watch) の受け口。Google から直接呼ばれるのでログインは無い。
 * https://developers.google.com/workspace/calendar/api/guides/push
 * - X-Goog-Channel-ID でカレンダーを引き、X-Goog-Channel-Token が鍵から作った値と合うかを確かめる。
 *   X-Goog-Resource-ID は、保存してあれば同じかも確かめる。
 * - 通知に中身は無いので、合っていれば worker に「差分を確認して」と伝えるだけにする (sync は
 *   チャンネルを作った合図なので伝えない)。
 * - Google が再送するのは 500 / 502 / 503 / 504 だけ。知らないチャンネルや合わないトークンには
 *   200 を返し、再送させずに黙って捨てる (チャンネルがあるかどうかも漏らさない)。
 * GOOGLE_CALENDAR_WEBHOOK_PATH にマウントされる。
 */
export function googleCalendarWebhookRoutes({
  db,
  encryptionKey,
  notify,
}: GoogleCalendarWebhookDeps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const channelId = c.req.header("x-goog-channel-id") ?? "";
    const state = c.req.header("x-goog-resource-state") ?? "";
    const token = c.req.header("x-goog-channel-token");
    const resourceId = c.req.header("x-goog-resource-id");
    if (!channelId || channelId.length > MAX_CHANNEL_ID || !state) {
      return c.body(null, 400);
    }
    if (!verifyGoogleCalendarChannelToken(encryptionKey, channelId, token)) {
      return c.body(null, 200);
    }
    const [calendar] = await db
      .select({
        id: calendars.id,
        accountId: calendars.accountId,
        providerState: calendars.providerState,
      })
      .from(calendars)
      .where(
        and(
          eq(calendars.pushChannelId, channelId),
          eq(calendars.source, "google"),
        ),
      )
      .limit(1);
    if (!calendar?.accountId) return c.body(null, 200);
    const savedResourceId = calendar.providerState?.pushResourceId;
    if (
      typeof savedResourceId === "string" &&
      resourceId !== undefined &&
      resourceId !== savedResourceId
    ) {
      return c.body(null, 200);
    }
    if (!RESOURCE_STATES.has(state) || state === "sync") {
      return c.body(null, 200);
    }
    await notify({
      accountId: calendar.accountId,
      calendarId: calendar.id,
      reason: "push",
    });
    return c.body(null, 200);
  });

  return app;
}
