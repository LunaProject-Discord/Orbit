import { zValidator } from "@hono/zod-validator";
import {
  attachments,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
} from "@mail/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";

const listQuery = z.object({
  /** 省略すると、全アカウントの受信トレイをまとめて返す。 */
  accountId: z.uuid().optional(),
  /** 省略すると受信トレイ。 */
  mailboxId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 前のページの nextCursor。 */
  cursor: z.string().max(100).optional(),
});

const cursorPattern = /^(\d{4}-[0-9T:.-]+Z)_([0-9a-f-]{36})$/;

export function messageRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/", zValidator("query", listQuery), async (c) => {
    const query = c.req.valid("query");
    const conditions = [eq(mailAccounts.userId, c.var.user.id)];
    if (query.accountId) {
      conditions.push(eq(mailAccounts.id, query.accountId));
    }
    conditions.push(
      query.mailboxId
        ? eq(mailboxes.id, query.mailboxId)
        : eq(mailboxes.specialUse, "inbox"),
    );
    if (query.cursor) {
      const match = cursorPattern.exec(query.cursor);
      if (!match) {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      conditions.push(
        sql`(${messages.receivedAt}, ${messages.id}) < (${match[1]}::timestamptz, ${match[2]}::uuid)`,
      );
    }

    const rows = await db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        mailboxId: mailboxes.id,
        threadKey: messages.threadKey,
        subject: messages.subject,
        from: messages.from,
        to: messages.to,
        receivedAt: messages.receivedAt,
        snippet: messages.snippet,
        hasAttachments: messages.hasAttachments,
        seen: messages.seen,
        flagged: messages.flagged,
        answered: messages.answered,
      })
      .from(messages)
      .innerJoin(messageMailboxes, eq(messageMailboxes.messageId, messages.id))
      .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(and(...conditions))
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? `${last.receivedAt.toISOString()}_${last.id}`
        : null;
    return c.json({ messages: page, nextCursor });
  });

  app.get(
    "/:id",
    zValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const [message] = await db
        .select({
          id: messages.id,
          accountId: messages.accountId,
          threadKey: messages.threadKey,
          subject: messages.subject,
          from: messages.from,
          to: messages.to,
          cc: messages.cc,
          bcc: messages.bcc,
          replyTo: messages.replyTo,
          sentAt: messages.sentAt,
          receivedAt: messages.receivedAt,
          snippet: messages.snippet,
          size: messages.size,
          hasAttachments: messages.hasAttachments,
          bodyText: messages.bodyText,
          bodyHtml: messages.bodyHtml,
          bodyFetchedAt: messages.bodyFetchedAt,
          seen: messages.seen,
          flagged: messages.flagged,
          answered: messages.answered,
          draft: messages.draft,
        })
        .from(messages)
        .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
        .where(
          and(eq(messages.id, id), eq(mailAccounts.userId, c.var.user.id)),
        );
      if (!message) {
        return c.json({ error: "not_found" }, 404);
      }
      const files = await db
        .select({
          id: attachments.id,
          filename: attachments.filename,
          contentType: attachments.contentType,
          size: attachments.size,
          contentId: attachments.contentId,
          inline: attachments.inline,
        })
        .from(attachments)
        .where(eq(attachments.messageId, id))
        .orderBy(asc(attachments.partId));
      return c.json({ message: { ...message, attachments: files } });
    },
  );

  return app;
}
