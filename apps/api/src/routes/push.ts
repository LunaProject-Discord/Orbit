import { zValidator } from "@hono/zod-validator";
import { isAllowedPushEndpoint } from "@orbit/core";
import { devices, pushSubscriptions } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";

const base64url = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+=*$/);

const subscribeBody = z.object({
  /** ブラウザーの PushSubscription の endpoint。 */
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: base64url, auth: base64url }),
});

const unsubscribeBody = z.object({ endpoint: z.string().max(2000) });

/** FCM が発行する端末のトークン。英数字と一部の記号だけでできている。 */
const deviceToken = z
  .string()
  .min(20)
  .max(4096)
  .regex(/^[A-Za-z0-9_:.-]+$/);

const deviceBody = z.object({
  platform: z.enum(["android"]),
  token: deviceToken,
  /** 端末の名前 (機種名など)。設定画面などで見分けるためのもの。 */
  name: z.string().trim().max(100).optional(),
});

const deviceDeleteBody = z.object({ token: z.string().max(4096) });

/**
 * 新着メールの通知の送り先の登録。ブラウザーは Web Push、スマホアプリは FCM。
 * 通知を有効にしたときに端末が登録し、無効にしたときとログアウトのときに消す。
 */
export function pushRoutes({
  db,
  webPushPublicKey,
  fcmEnabled,
}: Pick<RouteDeps, "db" | "webPushPublicKey" | "fcmEnabled">) {
  const app = new Hono<AppEnv>();

  /** 送り先の登録に使う公開鍵。null なら、サーバーは Web Push を送らない。 */
  /** fcm が false なら、サーバーはスマホアプリへの通知 (FCM) を送らない。 */
  app.get("/config", (c) =>
    c.json({ publicKey: webPushPublicKey, fcm: fcmEnabled }),
  );

  app.post("/subscriptions", zValidator("json", subscribeBody), async (c) => {
    if (!webPushPublicKey) {
      return c.json({ error: "push_unavailable" }, 409);
    }
    const body = c.req.valid("json");
    if (!isAllowedPushEndpoint(body.endpoint)) {
      return c.json({ error: "unsupported_endpoint" }, 400);
    }
    const values = {
      userId: c.var.user.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null,
    };
    // 同じブラウザーで別の利用者がログインし直した場合は、送り先を付け替える。
    await db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
    return c.body(null, 204);
  });

  app.delete(
    "/subscriptions",
    zValidator("json", unsubscribeBody),
    async (c) => {
      const { endpoint } = c.req.valid("json");
      await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, endpoint),
            eq(pushSubscriptions.userId, c.var.user.id),
          ),
        );
      return c.body(null, 204);
    },
  );

  app.post("/devices", zValidator("json", deviceBody), async (c) => {
    if (!fcmEnabled) {
      return c.json({ error: "push_unavailable" }, 409);
    }
    const body = c.req.valid("json");
    const values = {
      userId: c.var.user.id,
      platform: body.platform,
      pushToken: body.token,
      name: body.name || "Android",
      lastSeenAt: new Date(),
    };
    // 同じ端末で別の利用者がログインし直した場合は、送り先を付け替える。
    await db
      .insert(devices)
      .values(values)
      .onConflictDoUpdate({ target: devices.pushToken, set: values });
    return c.body(null, 204);
  });

  app.delete("/devices", zValidator("json", deviceDeleteBody), async (c) => {
    const { token } = c.req.valid("json");
    await db
      .delete(devices)
      .where(
        and(eq(devices.pushToken, token), eq(devices.userId, c.var.user.id)),
      );
    return c.body(null, 204);
  });

  return app;
}
