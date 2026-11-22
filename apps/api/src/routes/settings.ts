import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_CHANGES,
  type ChangeNotification,
  readNotificationActions,
} from "@mail/core";
import { type Database, userSettings } from "@mail/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../context.js";
import {
  notificationActionSettings,
  readSwipe,
  swipeSettings,
} from "../lib/settings.js";

/** 利用者のほかの端末に、設定を取得し直すきっかけを送る (変更履歴には載せない)。 */
async function announce(db: Database, userId: string) {
  const payload: ChangeNotification = { userId, seq: "resync" };
  await db.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}

/**
 * どの端末でも同じにする設定 (一覧のスワイプ操作、通知に付けるボタン)。
 * フォントや行の間隔など、端末ごとに違ってよい設定は端末側に保存する。
 */
export function settingsRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const [row] = await db
      .select({
        swipe: userSettings.swipe,
        notificationActions: userSettings.notificationActions,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, c.var.user.id));
    return c.json({
      swipe: readSwipe(row?.swipe),
      notificationActions: readNotificationActions(row?.notificationActions),
    });
  });

  /** 一覧の行を左右にスワイプしたときの操作を保存する。 */
  app.put("/swipe", zValidator("json", swipeSettings), async (c) => {
    const swipe = c.req.valid("json");
    const userId = c.var.user.id;
    await db
      .insert(userSettings)
      .values({ userId, swipe })
      .onConflictDoUpdate({ target: userSettings.userId, set: { swipe } });
    await announce(db, userId);
    return c.json({ swipe });
  });

  /** 新着メールの通知に付けるボタンを保存する。次に届く通知から変わる。 */
  app.put(
    "/notification-actions",
    zValidator("json", notificationActionSettings),
    async (c) => {
      const { actions: notificationActions } = c.req.valid("json");
      const userId = c.var.user.id;
      await db
        .insert(userSettings)
        .values({ userId, notificationActions })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { notificationActions },
        });
      await announce(db, userId);
      return c.json({ notificationActions });
    },
  );

  return app;
}
