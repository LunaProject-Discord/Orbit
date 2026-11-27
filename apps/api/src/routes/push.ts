import { zValidator } from "@hono/zod-validator";
import {
  clampReminderCoverUntil,
  DEVICE_APPS,
  isAllowedPushEndpoint,
  PUSH_DEVICE_REMINDERS_PATH,
} from "@orbit/core";
import { devices, pushSubscriptions } from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
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
  /**
   * 送る通知の種類 (段取り 9)。省略時は mail = true、calendar = false (古い端末は今までどおり
   * メールだけ受け取る)。予定の通知は、出し方を知っている新しい端末が明示したときだけ送る。
   */
  mail: z.boolean().optional(),
  calendar: z.boolean().optional(),
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
  /** どのアプリの登録か (段取り 9)。Android の Calendar アプリは calendar。省略時は mail。 */
  app: z.enum(DEVICE_APPS).optional(),
  /** 送る通知の種類。省略時は mail = true、calendar = false。 */
  mail: z.boolean().optional(),
  calendar: z.boolean().optional(),
  /** 端末の ID (Web の deviceId())。省略すると、前に登録した値を残す。 */
  installId: z.uuid().optional(),
});

/** POST /push/devices/reminders の本文 (ReminderCoverReport)。 */
const reminderCoverBody = z.object({
  token: deviceToken,
  /** ここまでの時刻 (epoch ms) の通知は端末が予約済み。今 + 8 日に丸める。 */
  coverUntil: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** 予約を計算したときの端末の同期位置 (changes.seq、10 進の文字列)。 */
  coverSeq: z.string().regex(/^\d{1,18}$/),
  /** 正確なアラームで予約できている。 */
  exact: z.boolean(),
});

const deviceDeleteBody = z.object({ token: z.string().max(4096) });

/**
 * 新着メールと予定の通知の送り先の登録。ブラウザーは Web Push、スマホアプリは FCM。
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
      notifyMail: body.mail ?? true,
      notifyCalendar: body.calendar ?? false,
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
      app: body.app ?? "mail",
      notifyMail: body.mail ?? true,
      notifyCalendar: body.calendar ?? false,
      ...(body.installId === undefined ? {} : { installId: body.installId }),
    };
    // 同じ端末で別の利用者がログインし直した場合は、送り先を付け替える。そのときは前の利用者の
    // 「予約済み」(reminder_cover_*) を引き継がない (設計 7 章の 2)。
    const sameUser = sql`${devices.userId} = excluded.user_id`;
    await db
      .insert(devices)
      .values(values)
      .onConflictDoUpdate({
        target: devices.pushToken,
        set: {
          ...values,
          installId:
            body.installId === undefined
              ? sql`case when ${sameUser} then ${devices.installId} else null end`
              : body.installId,
          reminderCoverUntil: sql`case when ${sameUser} then ${devices.reminderCoverUntil} else null end`,
          reminderCoverSeq: sql`case when ${sameUser} then ${devices.reminderCoverSeq} else null end`,
          exactAlarms: sql`case when ${sameUser} then ${devices.exactAlarms} else false end`,
        },
      });
    return c.body(null, 204);
  });

  /**
   * 端末が自分で予約した通知の範囲の報告 (段取り 9、設計 3.3)。サーバーはこの範囲の
   * リマインダーをその端末へ push しない。自分の端末の行だけを更新する (他人の token は 404)。
   */
  app.post(
    PUSH_DEVICE_REMINDERS_PATH.replace(/^\/push/, ""),
    zValidator("json", reminderCoverBody),
    async (c) => {
      const body = c.req.valid("json");
      const now = Date.now();
      const updated = await db
        .update(devices)
        .set({
          reminderCoverUntil: new Date(
            clampReminderCoverUntil(body.coverUntil, now),
          ),
          reminderCoverSeq: BigInt(body.coverSeq),
          exactAlarms: body.exact,
          lastSeenAt: new Date(now),
        })
        .where(
          and(
            eq(devices.pushToken, body.token),
            eq(devices.userId, c.var.user.id),
          ),
        )
        .returning({ id: devices.id });
      if (updated.length === 0) return c.json({ error: "not_found" }, 404);
      return c.body(null, 204);
    },
  );

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
