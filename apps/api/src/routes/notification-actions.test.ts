import { signNotificationAction } from "@orbit/core";
import type { Database } from "@orbit/db";
import { describe, expect, it } from "vitest";
import type { MessageAction } from "../lib/message-actions.js";
import type { NotificationReplyResult } from "../lib/notification-reply.js";
import {
  notificationActionRoutes,
  toMessageAction,
} from "./notification-actions.js";

const key = Buffer.alloc(32, 1);
const messageId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8724";
const userId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8700";

/** メールの持ち主を引く範囲だけを持つ、DB の代わり。 */
function setup(
  owner: string | null,
  ok = true,
  reply: NotificationReplyResult = { ok: true, id: "o1" },
  disabled = false,
) {
  const queued: [string, MessageAction][] = [];
  const replies: [string, string, string, string][] = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => (owner ? [{ userId: owner }] : []),
        }),
        // 利用者が無効にされているか (isUserDisabled)。
        where: async () => [{ disabledAt: disabled ? new Date() : null }],
      }),
    }),
  } as unknown as Database;
  const app = notificationActionRoutes({
    db,
    encryptionKey: key,
    enqueue: async (_db, user, action) => {
      queued.push([user, action]);
      return ok
        ? { ok: true, messageIds: action.messageIds }
        : { ok: false, error: "mailbox_not_found" };
    },
    queueReply: async (_db, user, id, text, idempotencyKey) => {
      replies.push([user, id, text, idempotencyKey]);
      return reply;
    },
  });
  const post = (body: unknown, path = "/notification-actions") =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const postReply = (body: unknown) =>
    post(body, "/notification-actions/reply");
  return { queued, replies, post, postReply };
}

describe("通知のボタンの受け口", () => {
  it("合言葉が合えば、ログイン無しでそのメールを操作する", async () => {
    const { queued, post } = setup(userId);
    const token = signNotificationAction(key, userId, messageId);
    const response = await post({ messageId, action: "archive", token });
    expect(response.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.[0]).toBe(userId);
    expect(queued[0]?.[1]).toMatchObject({
      action: "move",
      destination: "archive",
      messageIds: [messageId],
    });
  });

  it("合言葉が違えば受け付けない (別のメール、別の利用者の合言葉)", async () => {
    const { queued, post } = setup(userId);
    for (const token of [
      "1.abc",
      signNotificationAction(
        key,
        userId,
        "01a1fcb1-b4bb-71cc-9452-cd6f31df8725",
      ),
      signNotificationAction(key, "someone-else", messageId),
      signNotificationAction(Buffer.alloc(32, 2), userId, messageId),
    ]) {
      const response = await post({ messageId, action: "read", token });
      expect(response.status).toBe(403);
    }
    expect(queued).toEqual([]);
  });

  it("管理者が無効にした利用者の通知からは、操作も返信もできない", async () => {
    const { queued, replies, post, postReply } = setup(
      userId,
      true,
      undefined,
      true,
    );
    const token = signNotificationAction(key, userId, messageId);
    expect((await post({ messageId, action: "read", token })).status).toBe(403);
    expect(
      (
        await postReply({
          messageId,
          token,
          text: "返信",
          idempotencyKey: "01a1fcb1-b4bb-71cc-9452-cd6f31df8799",
        })
      ).status,
    ).toBe(403);
    expect(queued).toEqual([]);
    expect(replies).toEqual([]);
  });

  it("もう無いメールは 404", async () => {
    const { queued, post } = setup(null);
    const token = signNotificationAction(key, userId, messageId);
    const response = await post({ messageId, action: "read", token });
    expect(response.status).toBe(404);
    expect(queued).toEqual([]);
  });

  it("移動先のフォルダが無ければ 409", async () => {
    const { post } = setup(userId, false);
    const token = signNotificationAction(key, userId, messageId);
    const response = await post({ messageId, action: "junk", token });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "mailbox_not_found" });
  });

  it("知らないボタンは受け付けない", async () => {
    const { queued, post } = setup(userId);
    const token = signNotificationAction(key, userId, messageId);
    const response = await post({ messageId, action: "reply", token });
    expect(response.status).toBe(400);
    expect(queued).toEqual([]);
  });
});

describe("通知の返信欄の受け口", () => {
  const idempotencyKey = "01a1fcb1-b4bb-71cc-9452-cd6f31df8799";

  it("合言葉が合えば、書いた文章で返信を積む", async () => {
    const { replies, postReply } = setup(userId);
    const token = signNotificationAction(key, userId, messageId);
    const response = await postReply({
      messageId,
      token,
      text: "了解です",
      idempotencyKey,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, id: "o1" });
    expect(replies).toEqual([[userId, messageId, "了解です", idempotencyKey]]);
  });

  it("合言葉が違えば受け付けない", async () => {
    const { replies, postReply } = setup(userId);
    const token = signNotificationAction(key, "someone-else", messageId);
    const response = await postReply({ messageId, token, text: "x" });
    expect(response.status).toBe(403);
    expect(replies).toEqual([]);
  });

  it("空の文章は受け付けない", async () => {
    const { replies, postReply } = setup(userId);
    const token = signNotificationAction(key, userId, messageId);
    for (const text of ["", "  \n "]) {
      const response = await postReply({ messageId, token, text });
      expect(response.status).toBe(400);
    }
    expect(replies).toEqual([]);
  });

  it("もう無いメールへは返信できない (404)", async () => {
    const { postReply } = setup(null);
    const token = signNotificationAction(key, userId, messageId);
    const response = await postReply({ messageId, token, text: "x" });
    expect(response.status).toBe(404);
  });

  it("宛先が決まらなければ 409", async () => {
    const { postReply } = setup(userId, true, {
      ok: false,
      error: "no_recipients",
    });
    const token = signNotificationAction(key, userId, messageId);
    const response = await postReply({ messageId, token, text: "x" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_recipients" });
  });
});

describe("toMessageAction", () => {
  const id = "01a1fcb1-b4bb-71cc-9452-cd6f31df87ff";
  it("ボタンごとの操作", () => {
    expect(toMessageAction("read", messageId, id)).toMatchObject({
      action: "set_flags",
      seen: true,
    });
    expect(toMessageAction("star", messageId, id)).toMatchObject({
      action: "set_flags",
      flagged: true,
    });
    expect(toMessageAction("delete", messageId, id)).toMatchObject({
      action: "move",
      destination: "trash",
    });
    expect(toMessageAction("junk", messageId, id)).toMatchObject({
      action: "move",
      destination: "junk",
    });
  });
});
