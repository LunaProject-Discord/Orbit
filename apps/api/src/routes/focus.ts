import { zValidator } from "@hono/zod-validator";
import { CHANNEL_FOCUS, type FocusNotification } from "@orbit/core";
import { mailAccounts, mailboxes } from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";

const focusBody = z.object({
  /** 表示中のアカウント。null は全アカウントの受信トレイ。 */
  accountId: z.uuid().nullable().default(null),
  /** 表示中のフォルダ。null は受信トレイ。 */
  mailboxId: z.uuid().nullable().default(null),
  /** 利用者がフォルダの更新を指示した (デスクトップ版の F5 など)。すぐに確認し直させる。 */
  refresh: z.boolean().optional(),
});

export function focusRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  /**
   * 端末が画面を開いている間、表示中のフォルダを定期的に知らせる。
   * 同期ワーカーは、知らせが届いている間そのフォルダとアカウントを短い間隔で同期する。
   * 保存はせず、届かなくなれば自動的に通常の間隔へ戻る。
   */
  app.post("/", zValidator("json", focusBody), async (c) => {
    const { accountId, mailboxId, refresh } = c.req.valid("json");
    const accounts = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(eq(mailAccounts.userId, c.var.user.id));
    let focused: { accountId: string; id: string } | undefined;
    if (mailboxId) {
      [focused] = await db
        .select({ accountId: mailboxes.accountId, id: mailboxes.id })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            eq(mailAccounts.userId, c.var.user.id),
          ),
        );
    }
    for (const account of accounts) {
      // アカウントを選んでいる間は、他のアカウントには知らせない (通常の間隔のままにする)。
      if (accountId && account.id !== accountId) continue;
      const payload: FocusNotification = {
        accountId: account.id,
        mailboxId: focused?.accountId === account.id ? focused.id : null,
        ...(refresh ? { refresh: true } : {}),
      };
      await db.execute(
        sql`select pg_notify(${CHANNEL_FOCUS}, ${JSON.stringify(payload)})`,
      );
    }
    return c.body(null, 204);
  });

  return app;
}
