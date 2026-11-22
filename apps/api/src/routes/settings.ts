import { zValidator } from "@hono/zod-validator";
import { CHANNEL_CHANGES, type ChangeNotification } from "@mail/core";
import { userSettings } from "@mail/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../context.js";
import { readSwipe, swipeSettings } from "../lib/settings.js";

/**
 * どの端末でも同じにする設定 (一覧のスワイプ操作)。
 * フォントや行の間隔など、端末ごとに違ってよい設定は端末側に保存する。
 */
export function settingsRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const [row] = await db
      .select({ swipe: userSettings.swipe })
      .from(userSettings)
      .where(eq(userSettings.userId, c.var.user.id));
    return c.json({ swipe: readSwipe(row?.swipe) });
  });

  /** 一覧の行を左右にスワイプしたときの操作を保存する。 */
  app.put("/swipe", zValidator("json", swipeSettings), async (c) => {
    const swipe = c.req.valid("json");
    const userId = c.var.user.id;
    await db
      .insert(userSettings)
      .values({ userId, swipe })
      .onConflictDoUpdate({ target: userSettings.userId, set: { swipe } });
    // 利用者のほかの端末に、設定を取得し直すきっかけを送る (変更履歴には載せない)。
    const payload: ChangeNotification = { userId, seq: "resync" };
    await db.execute(
      sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
    );
    return c.json({ swipe });
  });

  return app;
}
