import { signNotificationAction } from "@orbit/core";
import type { Database } from "@orbit/db";
import { describe, expect, it } from "vitest";
import type { MessageAction } from "../lib/message-actions.js";
import {
  notificationActionRoutes,
  toMessageAction,
} from "./notification-actions.js";

const key = Buffer.alloc(32, 1);
const messageId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8724";
const userId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8700";

/** メールの持ち主を引く範囲だけを持つ、DB の代わり。 */
function setup(owner: string | null, ok = true) {
  const queued: [string, MessageAction][] = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => (owner ? [{ userId: owner }] : []),
        }),
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
  });
  const post = (body: unknown) =>
    app.request("/notification-actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { queued, post };
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
