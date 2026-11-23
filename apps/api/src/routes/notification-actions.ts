import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  NOTIFICATION_ACTION_PATH,
  NOTIFICATION_ACTIONS,
  type NotificationActionId,
  verifyNotificationAction,
} from "@orbit/core";
import { type Database, mailAccounts, messages } from "@orbit/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  enqueueMessageAction,
  type MessageAction,
} from "../lib/message-actions.js";

const body = z.object({
  messageId: z.uuid(),
  action: z.enum(NOTIFICATION_ACTIONS),
  /** 通知に付いていた合言葉。 */
  token: z.string().min(1).max(200),
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
}: Deps) {
  const app = new Hono();

  app.post(NOTIFICATION_ACTION_PATH, zValidator("json", body), async (c) => {
    const { messageId, action, token } = c.req.valid("json");
    const [owner] = await db
      .select({ userId: mailAccounts.userId })
      .from(messages)
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(eq(messages.id, messageId));
    // すでに削除や移動で無くなったメール。通知を出した側は、済んだものとして扱う。
    if (!owner) return c.json({ error: "not_found" }, 404);
    if (
      !verifyNotificationAction(encryptionKey, owner.userId, messageId, token)
    ) {
      return c.json({ error: "invalid_token" }, 403);
    }
    const result = await enqueue(
      db,
      owner.userId,
      toMessageAction(action, messageId, randomUUID()),
    );
    // 移動先のフォルダが無い (アーカイブ先の無いアカウントなど)。
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ ok: true });
  });

  return app;
}
