import {
  GRAPH_WEBHOOK_PATH,
  type GraphLifecycleEvent,
  type GraphPushNotification,
  verifyGraphClientState,
} from "@mail/core";
import { Hono } from "hono";

/** 通知の本文の上限。Graph の通知は小さいので、これを超えるものは受け付けない。 */
const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIFECYCLE_EVENTS: readonly string[] = [
  "reauthorizationRequired",
  "subscriptionRemoved",
  "missed",
] satisfies GraphLifecycleEvent[];

type Deps = {
  encryptionKey: Buffer;
  /** 同期ワーカーへ伝える。 */
  notify: (payload: GraphPushNotification) => Promise<void>;
};

/**
 * Microsoft Graph の変更通知 (Webhook) の受け口。Graph から直接呼ばれるのでログインは無い。
 * 代わりに、購読時に渡した合言葉 (clientState) が一致する通知だけを受け付ける。
 * 通知の中身 (どのメールが変わったか) は使わず、同期ワーカーに「差分を確認して」と伝えるだけにする。
 * https://learn.microsoft.com/graph/change-notifications-delivery-webhooks
 */
export function webhookRoutes({ encryptionKey, notify }: Deps) {
  const app = new Hono();

  app.post(GRAPH_WEBHOOK_PATH, async (c) => {
    // 購読の作成時に、受け口が実在するかの確認が来る。受け取った値をそのまま 10 秒以内に返す。
    const validationToken = c.req.query("validationToken");
    if (validationToken !== undefined) {
      return c.text(validationToken, 200);
    }

    const accountId = c.req.query("account") ?? "";
    if (!UUID.test(accountId)) return c.body(null, 400);
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
    const lifecycle = new Set<GraphLifecycleEvent>();
    for (const item of items as Record<string, unknown>[]) {
      if (
        !verifyGraphClientState(encryptionKey, accountId, item?.clientState)
      ) {
        continue;
      }
      const event = item.lifecycleEvent;
      if (typeof event === "string" && LIFECYCLE_EVENTS.includes(event)) {
        lifecycle.add(event as GraphLifecycleEvent);
      } else {
        changed = true;
      }
    }
    if (changed) await notify({ accountId, lifecycle: null });
    for (const event of lifecycle)
      await notify({ accountId, lifecycle: event });
    // Graph は 3 秒以内の 2xx を待つ。合言葉が合わない通知も、同じ応答で黙って捨てる。
    return c.body(null, 202);
  });

  return app;
}
