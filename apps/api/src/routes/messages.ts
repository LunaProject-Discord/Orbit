import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { zValidator } from "@hono/zod-validator";
import {
  attachmentPath,
  attachmentsDir,
  sanitizeContentType,
  sanitizeFilename,
} from "@mail/core";
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
import type { EventsHub } from "../lib/events-hub.js";
import {
  enqueueMessageAction,
  messageActionBody,
} from "../lib/message-actions.js";
import {
  ensureReceivedAttachment,
  statusOfFetchError,
} from "../lib/received-attachments.js";

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

export function messageRoutes({
  db,
  hub,
}: Pick<RouteDeps, "db"> & { hub: EventsHub }) {
  const app = new Hono<AppEnv>();
  const dir = attachmentsDir();

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

  /**
   * メッセージへの操作 (既読、スター、移動、削除)。
   * すぐに DB へ反映して応答し、プロバイダへの反映は同期ワーカーが行う。
   */
  app.post("/actions", zValidator("json", messageActionBody), async (c) => {
    const result = await enqueueMessageAction(
      db,
      c.var.user.id,
      c.req.valid("json"),
    );
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ messageIds: result.messageIds });
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

  /**
   * 受信メールの添付ファイルの実体。置き場に無ければ、同期ワーカーがメールサーバーから
   * 取得し終えるのを待ってから返す。
   * 中身は差出人が自由に決められるので、ブラウザーがこのアプリのページとして
   * 開くことのないよう、必ず「ファイルとして保存」の扱いで返す。
   */
  app.get(
    "/:id/attachments/:attachmentId",
    zValidator("param", z.object({ id: z.uuid(), attachmentId: z.uuid() })),
    async (c) => {
      const { id, attachmentId } = c.req.valid("param");
      const result = await ensureReceivedAttachment(
        { db, hub, dir },
        c.var.user.id,
        id,
        attachmentId,
      );
      if (!result.ok) {
        return c.json(
          { error: result.error },
          statusOfFetchError(result.error),
        );
      }
      const { attachment } = result;
      const path = attachmentPath(dir, attachment.storageKey);
      const info = await stat(path).catch(() => null);
      if (!info) return c.json({ error: "fetch_failed" }, 502);
      const filename = encodeURIComponent(
        sanitizeFilename(attachment.filename ?? ""),
      ).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
      return c.body(
        Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        200,
        {
          "Content-Type": sanitizeContentType(attachment.contentType),
          "Content-Length": String(info.size),
          "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Cache-Control": "private, max-age=3600",
        },
      );
    },
  );

  return app;
}
