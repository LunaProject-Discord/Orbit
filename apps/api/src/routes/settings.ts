import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_CHANGES,
  type ChangeNotification,
  readNotificationActions,
} from "@orbit/core";
import { type Database, userSettings } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../context.js";
import {
  composeFormatSettings,
  dateFormatSettings,
  notificationActionSettings,
  readDateFormat,
  readSwipe,
  senderIconSettings,
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
 * どの端末でも同じにする設定 (一覧のスワイプ操作、通知に付けるボタン、日付と時刻の形式、
 * 差出人のアイコンに Gravatar を使うか)。
 * フォントや行の間隔など、端末ごとに違ってよい設定は端末側に保存する。
 */
export function settingsRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const [row] = await db
      .select({
        swipe: userSettings.swipe,
        notificationActions: userSettings.notificationActions,
        dateFormat: userSettings.dateFormat,
        senderIconGravatar: userSettings.senderIconGravatar,
        composeFormat: userSettings.composeFormat,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, c.var.user.id));
    return c.json({
      swipe: readSwipe(row?.swipe),
      notificationActions: readNotificationActions(row?.notificationActions),
      // 保存していなければ null (画面側が標準の値を使う)。
      dateFormat: readDateFormat(row?.dateFormat),
      senderIconGravatar: row?.senderIconGravatar ?? false,
      composeFormat: row?.composeFormat ?? "html",
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

  /** 日付と時刻の形式を保存する。 */
  app.put("/date-format", zValidator("json", dateFormatSettings), async (c) => {
    const dateFormat = c.req.valid("json");
    const userId = c.var.user.id;
    await db
      .insert(userSettings)
      .values({ userId, dateFormat })
      .onConflictDoUpdate({ target: userSettings.userId, set: { dateFormat } });
    await announce(db, userId);
    return c.json({ dateFormat });
  });

  /**
   * 差出人のアイコンの設定を保存する。取得はサーバーが代わりに行うので、
   * Gravatar を使うかどうかは端末ごとではなく、どの端末でも共通にする。
   */
  app.put(
    "/sender-icons",
    zValidator("json", senderIconSettings),
    async (c) => {
      const { gravatar: senderIconGravatar } = c.req.valid("json");
      const userId = c.var.user.id;
      await db
        .insert(userSettings)
        .values({ userId, senderIconGravatar })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { senderIconGravatar },
        });
      await announce(db, userId);
      return c.json({ senderIconGravatar });
    },
  );

  /** メールを書くときの既定の形式 (書式付きかテキストか) を保存する。 */
  app.put(
    "/compose-format",
    zValidator("json", composeFormatSettings),
    async (c) => {
      const { format: composeFormat } = c.req.valid("json");
      const userId = c.var.user.id;
      await db
        .insert(userSettings)
        .values({ userId, composeFormat })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { composeFormat },
        });
      await announce(db, userId);
      return c.json({ composeFormat });
    },
  );

  return app;
}

/** 利用者が差出人のアイコンを Gravatar で探す設定にしているか (標準はオフ)。 */
export async function senderIconGravatarAllowed(
  db: Database,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ senderIconGravatar: userSettings.senderIconGravatar })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return row?.senderIconGravatar ?? false;
}
