import { zValidator } from "@hono/zod-validator";
import { mailAccounts, mailboxes, messageMailboxes, messages } from "@mail/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { isDistinct, recordChanges } from "../lib/changes.js";

const orderBody = z.object({
  /** 上から順に並べたいフォルダの ID (同じ親を持つフォルダをすべて)。 */
  mailboxIds: z.array(z.uuid()).min(1).max(1000).refine(isDistinct),
});

export function mailboxRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  /**
   * 全アカウントのフォルダを、未読数と件数を付けて返す。
   * 親子関係は parentId で表す (最上位は null)。ツリーへの組み立ては端末側で行う。
   */
  app.get("/", async (c) => {
    const rows = await db
      .select({
        id: mailboxes.id,
        accountId: mailboxes.accountId,
        parentId: mailboxes.parentId,
        path: mailboxes.path,
        name: mailboxes.name,
        specialUse: mailboxes.specialUse,
        sortOrder: mailboxes.sortOrder,
        lastSyncedAt: mailboxes.lastSyncedAt,
        totalCount: sql<number>`count(${messageMailboxes.messageId})::int`,
        unreadCount: sql<number>`(count(*) filter (where ${messages.seen} = false))::int`,
      })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .leftJoin(messageMailboxes, eq(messageMailboxes.mailboxId, mailboxes.id))
      .leftJoin(messages, eq(messages.id, messageMailboxes.messageId))
      .where(eq(mailAccounts.userId, c.var.user.id))
      .groupBy(mailboxes.id)
      .orderBy(asc(mailboxes.accountId), asc(mailboxes.name));
    return c.json({ mailboxes: rows });
  });

  /**
   * サイドバーでのフォルダの並び順を保存する。ほかの端末にも同じ順で表示される。
   * 表示順だけを変え、メールサーバー側のフォルダ (名前や親子関係) は変えない。
   */
  app.put("/order", zValidator("json", orderBody), async (c) => {
    const { mailboxIds } = c.req.valid("json");
    const user = c.var.user;
    const saved = await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.userId, user.id),
            inArray(mailboxes.id, mailboxIds),
          ),
        );
      if (owned.length !== mailboxIds.length) return false;
      for (const [index, id] of mailboxIds.entries()) {
        await tx
          .update(mailboxes)
          .set({ sortOrder: index })
          .where(eq(mailboxes.id, id));
      }
      await recordChanges(tx, user.id, "mailbox", mailboxIds);
      return true;
    });
    if (!saved) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
