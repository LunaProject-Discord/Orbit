import type { CalendarSyncNotification } from "@orbit/core";
import type { Database } from "@orbit/db";
import { Hono } from "hono";

/** 受け口のパス (/v1 の下)。メールの /webhooks/microsoft とは分ける。 */
export const GOOGLE_CALENDAR_WEBHOOK_PATH = "/webhooks/google-calendar";

export type GoogleCalendarWebhookDeps = {
  db: Database;
  encryptionKey: Buffer;
  /** カレンダーの同期 (CHANNEL_CALENDAR_SYNC) へ伝える。 */
  notify: (payload: CalendarSyncNotification) => Promise<void>;
};

/**
 * Google カレンダーの変更通知 (watch) の受け口。Google から直接呼ばれるのでログインは無い。
 * 送り主の確認 (チャンネルのトークン) と中身は、Google の担当が実装する。
 * いまは雛形で、何も受け付けない (404)。GOOGLE_CALENDAR_WEBHOOK_PATH にマウントされる。
 */
export function googleCalendarWebhookRoutes(_deps: GoogleCalendarWebhookDeps) {
  return new Hono();
}
