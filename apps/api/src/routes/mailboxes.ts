import { mailAccounts, mailboxes, messageMailboxes, messages } from "@mail/db";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../context.js";

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

  return app;
}
