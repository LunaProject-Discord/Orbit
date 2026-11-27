import type { CalendarSyncNotification } from "@orbit/core";
import type { Database } from "@orbit/db";
import { Hono } from "hono";

/** 受け口のパス (/v1 の下)。メールの /webhooks/microsoft とは分ける。 */
export const MICROSOFT_CALENDAR_WEBHOOK_PATH = "/webhooks/microsoft-calendar";

export type MicrosoftCalendarWebhookDeps = {
  db: Database;
  encryptionKey: Buffer;
  /** カレンダーの同期 (CHANNEL_CALENDAR_SYNC) へ伝える。 */
  notify: (payload: CalendarSyncNotification) => Promise<void>;
};

/**
 * Microsoft Graph のカレンダーの変更通知 (subscription) の受け口。Graph から直接呼ばれるので
 * ログインは無い。送り主の確認 (clientState) と中身は、Microsoft の担当が実装する。
 * いまは雛形で、何も受け付けない (404)。MICROSOFT_CALENDAR_WEBHOOK_PATH にマウントされる。
 */
export function microsoftCalendarWebhookRoutes(
  _deps: MicrosoftCalendarWebhookDeps,
) {
  return new Hono();
}
