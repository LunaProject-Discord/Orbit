import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  CALENDAR_WRITEBACK_SOURCES,
  type EventNotificationActionError,
  MAX_NOTIFICATION_REPLY_LENGTH,
  NOTIFICATION_ACTION_PATH,
  NOTIFICATION_ACTIONS,
  NOTIFICATION_EVENT_ACTION_PATH,
  NOTIFICATION_REPLY_PATH,
  type NotificationActionId,
  verifyEventNotificationAction,
  verifyNotificationAction,
} from "@orbit/core";
import {
  accounts,
  type Database,
  enqueueImip as defaultEnqueueImip,
  events,
  messages,
} from "@orbit/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { respondToEvent } from "../lib/event-respond.js";
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

/** POST /notification-actions/event の本文 (EventNotificationActionRequest)。 */
const eventBody = z.object({
  eventId: z.uuid(),
  status: z.enum(["accepted", "tentative", "declined"]),
  /** 通知に付いていた合言葉 (メールの合言葉とは署名の文字列が違い、使い回せない)。 */
  token: z.string().min(1).max(200),
  /** 押した時刻。オフラインで溜めて後から送るとき。再送では同じ値を送る。 */
  respondedAt: z.iso.datetime({ offset: true }).optional(),
  /** 同じ要求の再送を 1 回として扱うための鍵 (respondedAt が無いときの書き戻しの冪等キー)。 */
  idempotencyKey: z.uuid().optional(),
});

type Deps = {
  db: Database;
  encryptionKey: Buffer;
  /** メールへの操作を受け付ける (テストで差し替える)。 */
  enqueue?: typeof enqueueMessageAction;
  /** 返信を送信待ちに積む (テストで差し替える)。 */
  queueReply?: typeof queueNotificationReply;
  /** 予定を書き戻せるプロバイダの source (テストで差し替える)。 */
  writebackSources?: readonly string[];
  /** 出欠の返事 (REPLY) のメールを積む (テストで差し替える)。 */
  enqueueImip?: typeof defaultEnqueueImip;
};

/**
 * 新着メールの通知に付けたボタン (既読にする、アーカイブなど) と、招待の通知の出欠のボタンの受け口。
 * サービスワーカーやアプリの通知から、画面を開かずに呼ばれるのでログインは無い。
 * 代わりに、通知に付けた合言葉 (その利用者のそのメール 1 通だけを、期限まで操作できる) を確かめる。
 */
export function notificationActionRoutes({
  db,
  encryptionKey,
  enqueue = enqueueMessageAction,
  queueReply = queueNotificationReply,
  writebackSources = CALENDAR_WRITEBACK_SOURCES,
  enqueueImip = defaultEnqueueImip,
}: Deps) {
  const app = new Hono();
  const writable: ReadonlySet<string> = new Set(writebackSources);

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

  /**
   * 招待の通知の出欠のボタン (参加 / 未定 / 不参加。段取り 9、設計 2.4・4.2)。
   * 合言葉はその利用者のその予定 1 件の出欠だけを 7 日間認める。中身は /calendars/events/:id/respond
   * と同じ (respondToEvent)。404 = 予定が無い (済んだ扱い)、403 = 合言葉が違う・期限切れ、
   * 409 = 返事できない (code: cancelled / not_attendee / organizer、または error: read_only など)。
   */
  app.post(
    NOTIFICATION_EVENT_ACTION_PATH,
    zValidator("json", eventBody),
    async (c) => {
      const { eventId, status, token, respondedAt, idempotencyKey } =
        c.req.valid("json");
      const [owner] = await db
        .select({ userId: events.userId })
        .from(events)
        .where(eq(events.id, eventId));
      if (!owner) return c.json({ error: "not_found" }, 404);
      if (
        !verifyEventNotificationAction(
          encryptionKey,
          owner.userId,
          eventId,
          token,
        )
      ) {
        return c.json({ error: "invalid_token" }, 403);
      }
      const now = new Date().toISOString();
      const result = await respondToEvent(
        db,
        owner.userId,
        eventId,
        {
          status,
          respondedAt: respondedAt ?? now,
          // respondedAt の無い要求は、再送が来ても時刻で見分けられない。既に同じ出欠なら何もしない。
          skipIfSame: respondedAt === undefined,
          keySource:
            respondedAt === undefined && idempotencyKey
              ? `notification:${idempotencyKey}`
              : undefined,
        },
        { writable, enqueueImip },
      );
      if (result === "not_found") return c.json({ error: "not_found" }, 404);
      if (typeof result === "string") {
        return c.json(
          { error: result } satisfies EventNotificationActionError,
          409,
        );
      }
      if ("error" in result) {
        return c.json(
          {
            error: result.error,
            code: result.error,
          } satisfies EventNotificationActionError,
          409,
        );
      }
      return c.json({
        ok: true,
        applied: result.applied,
        status,
        notifiesOrganizer: result.notify !== "none",
        notify: result.notify,
      });
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
