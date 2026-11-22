import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { zValidator } from "@hono/zod-validator";
import {
  attachmentPath,
  attachmentsDir,
  type BodyFetchNotification,
  CHANNEL_BODY_FETCH,
  MAX_BODY_FETCH_IDS,
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
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import {
  inConversation,
  isThreadHead,
  threadCount,
  threadInMailbox,
} from "../lib/threads.js";

const listQuery = z.object({
  /** 省略すると、全アカウントの受信トレイをまとめて返す。 */
  accountId: z.uuid().optional(),
  /** 省略すると受信トレイ。 */
  mailboxId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 前のページの nextCursor。 */
  cursor: z.string().max(100).optional(),
});

const prefetchBody = z.object({
  /** 本文を先に取得してほしいメッセージ。先頭ほど先に取得する。 */
  ids: z.array(z.uuid()).min(1).max(MAX_BODY_FETCH_IDS),
  /** hover: カーソルを載せた行。visible: 画面に見えている行。 */
  reason: z.enum(["hover", "visible"]),
});

/** 1 つの会話として返すメッセージの上限。 */
const THREAD_LIMIT = 200;

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

    // 会話ごとに 1 行にまとめ、表示中のフォルダで最も新しいメッセージを代表にする。
    conditions.push(isThreadHead);

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
        // 本文をまだ取り込んでいない (端末が、見えている行の本文を先に取得するよう頼むのに使う)。
        bodyPending: sql<boolean>`${messages.bodyFetchedAt} is null`,
        hasAttachments: messages.hasAttachments,
        seen: messages.seen,
        flagged: messages.flagged,
        answered: messages.answered,
        threadCount,
        thread: threadInMailbox,
        // 下書きフォルダにある控えなら、元の下書きの ID (開くと作成画面で続きを書ける)。
        draftId: sql<string | null>`(
          select d.id from drafts d
          where d.account_id = ${messages.accountId}
            and (d.remote_message_id = ${messages.messageIdHeader}
              or d.remote_provider_id = ${messages.providerMessageId})
          limit 1
        )`,
      })
      .from(messages)
      .innerJoin(messageMailboxes, eq(messageMailboxes.messageId, messages.id))
      .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(and(...conditions))
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(query.limit + 1);

    // 既読・スター・添付は、会話のうち表示中のフォルダにある分をまとめた値にする。
    const page = rows.slice(0, query.limit).map(({ thread, ...row }) => ({
      ...row,
      seen: thread.seen,
      flagged: thread.flagged,
      hasAttachments: thread.hasAttachments,
      threadMessageIds: thread.ids,
    }));
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

  /**
   * 利用者が見ているメール (カーソルを載せた行、画面に見えている行) の本文を、
   * 取り込みの順番を待たずに取得するよう同期ワーカーへ頼む。取得済みのものは頼まない。
   * 取得が終わると変更通知で端末が読み直すので、ここでは待たずに応答する。
   */
  app.post("/prefetch", zValidator("json", prefetchBody), async (c) => {
    const { ids, reason } = c.req.valid("json");
    const rows = await db
      .select({ id: messages.id, accountId: messages.accountId })
      .from(messages)
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(
        and(
          inArray(messages.id, ids),
          eq(mailAccounts.userId, c.var.user.id),
          isNull(messages.bodyFetchedAt),
        ),
      );
    const pending = new Map(rows.map((row) => [row.id, row.accountId]));
    // 端末が並べた順 (画面の上から) を保って、アカウントごとに分ける。
    const byAccount = new Map<string, string[]>();
    for (const id of ids) {
      const accountId = pending.get(id);
      if (!accountId) continue;
      const list = byAccount.get(accountId) ?? [];
      if (!list.includes(id)) list.push(id);
      byAccount.set(accountId, list);
    }
    for (const [accountId, messageIds] of byAccount) {
      const payload: BodyFetchNotification = {
        accountId,
        messageIds,
        priority: reason,
      };
      await db.execute(
        sql`select pg_notify(${CHANNEL_BODY_FETCH}, ${JSON.stringify(payload)})`,
      );
    }
    return c.body(null, 204);
  });

  /**
   * メッセージが属する会話 (スレッド) の一覧を、古い順に返す。本文は含めない。
   * mailboxId は表示中のフォルダで、そこにあるメッセージは、ごみ箱などであっても会話に含める。
   */
  app.get(
    "/:id/thread",
    zValidator("param", z.object({ id: z.uuid() })),
    zValidator("query", z.object({ mailboxId: z.uuid().optional() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { mailboxId } = c.req.valid("query");
      const [origin] = await db
        .select({
          accountId: messages.accountId,
          threadKey: messages.threadKey,
        })
        .from(messages)
        .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
        .where(
          and(eq(messages.id, id), eq(mailAccounts.userId, c.var.user.id)),
        );
      if (!origin) {
        return c.json({ error: "not_found" }, 404);
      }
      const t = alias(messages, "t");
      const rows = await db
        .select({
          id: t.id,
          accountId: t.accountId,
          subject: t.subject,
          from: t.from,
          to: t.to,
          cc: t.cc,
          receivedAt: t.receivedAt,
          snippet: t.snippet,
          hasAttachments: t.hasAttachments,
          seen: t.seen,
          flagged: t.flagged,
          answered: t.answered,
          draft: t.draft,
          mailboxIds: sql<string[]>`(
            select coalesce(json_agg(tm.mailbox_id), '[]'::json)
            from message_mailboxes tm where tm.message_id = t.id
          )`,
        })
        .from(t)
        .where(
          and(
            eq(t.accountId, origin.accountId),
            eq(t.threadKey, origin.threadKey),
            // 開いたメッセージ自身は、どのフォルダにあっても含める。
            or(eq(t.id, id), inConversation(mailboxId ?? null)),
          ),
        )
        // 多すぎる会話は新しい方から上限まで。
        .orderBy(desc(t.receivedAt), desc(t.id))
        .limit(THREAD_LIMIT);
      return c.json({ messages: rows.reverse() });
    },
  );

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
          sender: messages.sender,
          listId: messages.listId,
          listUnsubscribe: messages.listUnsubscribe,
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
      if (message.bodyFetchedAt === null) {
        // 本文は一覧より後に順に取り込まれる。開かれたメールは順番を待たせず、
        // 同期ワーカーに先に取得してもらう (取得が終わると変更通知で端末が読み直す)。
        const payload: BodyFetchNotification = {
          accountId: message.accountId,
          messageIds: [message.id],
          priority: "open",
        };
        await db
          .execute(
            sql`select pg_notify(${CHANNEL_BODY_FETCH}, ${JSON.stringify(payload)})`,
          )
          .catch(() => {});
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
