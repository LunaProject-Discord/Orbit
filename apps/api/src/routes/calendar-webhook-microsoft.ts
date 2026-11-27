import {
  type CalendarSyncNotification,
  MICROSOFT_CALENDAR_WEBHOOK_PATH as CORE_PATH,
  verifyMicrosoftCalendarClientState,
} from "@orbit/core";
import { calendars, type Database } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

/** 受け口のパス (/v1 の下)。メールの /webhooks/microsoft とは分ける。 */
export const MICROSOFT_CALENDAR_WEBHOOK_PATH = CORE_PATH;

export type MicrosoftCalendarWebhookDeps = {
  db: Database;
  encryptionKey: Buffer;
  /** カレンダーの同期 (CHANNEL_CALENDAR_SYNC) へ伝える。 */
  notify: (payload: CalendarSyncNotification) => Promise<void>;
};

/** 通知の本文の上限。Graph の通知は小さいので、これを超えるものは受け付けない。 */
const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Microsoft Graph のカレンダーの変更通知 (subscription) の受け口。Graph から直接呼ばれるので
 * ログインは無い。購読のときに渡した合言葉 (clientState。アカウントとカレンダーから鍵で計算する)
 * が一致する通知だけを受け付け、中身は信用せずに「差分を確認して」とカレンダーの同期に伝える。
 * URL は ?account={accountId}&calendar={calendarId}。
 * - 購読の作成時の確認 (validationToken) には、その値をそのままテキストで返す。
 * - 購読の状態の通知 (lifecycleEvent):
 *   - reauthorizationRequired: 期限を消し、次の周回で PATCH で延ばさせる (再認可を兼ねる)。
 *   - subscriptionRemoved: 購読の ID も消し、次の周回で作り直させる。
 *   - missed: 差分を確認させるだけ。
 * https://learn.microsoft.com/graph/change-notifications-delivery-webhooks
 */
export function microsoftCalendarWebhookRoutes({
  db,
  encryptionKey,
  notify,
}: MicrosoftCalendarWebhookDeps) {
  const app = new Hono();

  app.post("/", async (c) => {
    // 受け口の確認。受け取った値をそのまま 10 秒以内に返す。
    const validationToken = c.req.query("validationToken");
    if (validationToken !== undefined) {
      return c.text(validationToken, 200);
    }

    const accountId = c.req.query("account") ?? "";
    const calendarId = c.req.query("calendar") ?? "";
    if (!UUID.test(accountId) || !UUID.test(calendarId)) {
      return c.body(null, 400);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.body(null, 413);
    let items: unknown;
    try {
      items = (JSON.parse(raw) as { value?: unknown }).value;
    } catch {
      return c.body(null, 400);
    }
    if (!Array.isArray(items)) return c.body(null, 400);

    let changed = false;
    let renew = false;
    let removed = false;
    for (const item of items as Record<string, unknown>[]) {
      if (
        !verifyMicrosoftCalendarClientState(
          encryptionKey,
          accountId,
          calendarId,
          item?.clientState,
        )
      ) {
        continue;
      }
      changed = true;
      if (item.lifecycleEvent === "reauthorizationRequired") renew = true;
      if (item.lifecycleEvent === "subscriptionRemoved") removed = true;
    }
    if (renew || removed) {
      await db
        .update(calendars)
        .set(
          removed
            ? { pushChannelId: null, pushExpiresAt: null }
            : { pushExpiresAt: null },
        )
        .where(
          and(
            eq(calendars.id, calendarId),
            eq(calendars.accountId, accountId),
            eq(calendars.source, "microsoft"),
          ),
        );
    }
    if (changed) await notify({ accountId, calendarId, reason: "push" });
    // Graph は 3 秒以内の 2xx を待つ。合言葉が合わない通知も、同じ応答で黙って捨てる。
    return c.body(null, 202);
  });

  return app;
}
