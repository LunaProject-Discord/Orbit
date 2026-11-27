import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  MAX_NOTIFICATION_REPLY_LENGTH,
  NOTIFICATION_ACTION_PATH,
  NOTIFICATION_ACTIONS,
  NOTIFICATION_REPLY_PATH,
  type NotificationActionId,
  verifyNotificationAction,
} from "@orbit/core";
import { accounts, type Database, messages } from "@orbit/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  enqueueMessageAction,
  type MessageAction,
} from "../lib/message-actions.js";
import { queueNotificationReply } from "../lib/notification-reply.js";

const body = z.object({
  messageId: z.uuid(),
  action: z.enum(NOTIFICATION_ACTIONS),
  /** 通知に付いていた合言葉。 */
  token: z.string().min(1).max(200),
});

const replyBody = z.object({
  messageId: z.uuid(),
  token: z.string().min(1).max(200),
  /** 通知の返信欄に書いた文章。 */
  text: z
    .string()
    .max(MAX_NOTIFICATION_REPLY_LENGTH)
    .refine((value) => value.trim() !== "", "empty"),
  /** 端末が返信ごとに付ける一意な ID。同じ値で再送されても二重に送らない。 */
  idempotencyKey: z.uuid().optional(),
});

/** 通知のボタンを、メールへの操作に直す。 */
export function toMessageAction(
  action: NotificationActionId,
  messageId: string,
  idempotencyKey: string,
): MessageAction {
  const common = { idempotencyKey, messageIds: [messageId] };
  switch (action) {
    case "read":
      return { ...common, action: "set_flags", seen: true };
    case "star":
      return { ...common, action: "set_flags", flagged: true };
    case "archive":
      return { ...common, action: "move", destination: "archive" };
    case "delete":
      // 画面の「削除」と同じく、ごみ箱へ移す。
      return { ...common, action: "move", destination: "trash" };
    case "junk":
      return { ...common, action: "move", destination: "junk" };
  }
}

type Deps = {
  db: Database;
  encryptionKey: Buffer;
  /** メールへの操作を受け付ける (テストで差し替える)。 */
  enqueue?: typeof enqueueMessageAction;
  /** 返信を送信待ちに積む (テストで差し替える)。 */
  queueReply?: typeof queueNotificationReply;
};

/**
 * 新着メールの通知に付けたボタン (既読にする、アーカイブなど) の受け口。
 * サービスワーカーやアプリの通知から、画面を開かずに呼ばれるのでログインは無い。
 * 代わりに、通知に付けた合言葉 (その利用者のそのメール 1 通だけを、期限まで操作できる) を確かめる。
 */
export function notificationActionRoutes({
  db,
  encryptionKey,
  enqueue = enqueueMessageAction,
  queueReply = queueNotificationReply,
}: Deps) {
  const app = new Hono();

  /** 合言葉を確かめ、メールの持ち主を返す。無いメールは "not_found"、合わなければ null。 */
  async function ownerOf(messageId: string, token: string) {
    const [owner] = await db
      .select({ userId: accounts.userId })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(eq(messages.id, messageId));
    if (!owner) return "not_found" as const;
    return verifyNotificationAction(
      encryptionKey,
      owner.userId,
      messageId,
      token,
    )
      ? owner.userId
      : null;
  }

  /**
   * 通知の返信欄 (スマホアプリ) からの返信。アプリを開かずに、書いた文章だけが届く。
   * 宛先・件名・署名・引用はサーバーが決めて、送信待ちに積む。
   */
  app.post(
    NOTIFICATION_REPLY_PATH,
    zValidator("json", replyBody),
    async (c) => {
      const { messageId, token, text, idempotencyKey } = c.req.valid("json");
      const owner = await ownerOf(messageId, token);
      // 返信先のメールが無くなっていたら送れない (ボタンの操作と違い、済んだことにはしない)。
      if (owner === "not_found") return c.json({ error: "not_found" }, 404);
      if (!owner) return c.json({ error: "invalid_token" }, 403);
      const result = await queueReply(
        db,
        owner,
        messageId,
        text,
        idempotencyKey ?? randomUUID(),
      );
      if (!result.ok) {
        return c.json(
          { error: result.error },
          result.error === "not_found" ? 404 : 409,
        );
      }
      return c.json({ ok: true, id: result.id }, 202);
    },
  );

  app.post(NOTIFICATION_ACTION_PATH, zValidator("json", body), async (c) => {
    const { messageId, action, token } = c.req.valid("json");
    const owner = await ownerOf(messageId, token);
    // すでに削除や移動で無くなったメール。通知を出した側は、済んだものとして扱う。
    if (owner === "not_found") return c.json({ error: "not_found" }, 404);
    if (!owner) return c.json({ error: "invalid_token" }, 403);
    const result = await enqueue(
      db,
      owner,
      toMessageAction(action, messageId, randomUUID()),
    );
    // 移動先のフォルダが無い (アーカイブ先の無いアカウントなど)。
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ ok: true });
  });

  return app;
}
