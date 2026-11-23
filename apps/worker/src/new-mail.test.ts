import {
  FcmError,
  type NewMailNotification,
  verifyNotificationAction,
} from "@orbit/core";
import type { Database } from "@orbit/db";
import { describe, expect, it } from "vitest";
import {
  combineSenders,
  DevicePushSender,
  PushSender,
  type PushTransport,
  parseNewMailNotification,
} from "./new-mail.js";

const notification: NewMailNotification = {
  userId: "u1",
  accountId: "a1",
  count: 2,
  messages: [
    { id: "m1", from: "佐藤 美咲", subject: "ご確認" },
    { id: "m2", from: "田中 悠人", subject: "勉強会" },
  ],
};

describe("parseNewMailNotification", () => {
  it("新着メールの知らせを読み取る", () => {
    expect(parseNewMailNotification(JSON.stringify(notification))).toEqual(
      notification,
    );
  });

  it("形式の違うものは無視する", () => {
    expect(parseNewMailNotification(undefined)).toBeNull();
    expect(parseNewMailNotification("x")).toBeNull();
    expect(parseNewMailNotification('{"userId":"u1"}')).toBeNull();
  });
});

type Row = Record<string, unknown> & { id: string };
type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** PushSender が使う範囲だけを持つ、DB の代わり。 */
function fakeDb(rows: Row[]) {
  const deleted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    delete: () => ({
      where: async (condition: unknown) => {
        deleted.push(condition);
      },
    }),
  } as unknown as Database;
  return { db, deleted };
}

const row = (id: string): SubscriptionRow => ({
  id,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: "key",
  auth: "auth",
});

describe("PushSender", () => {
  it("利用者の送り先すべてに、メールごとの通知を送る", async () => {
    const { db, deleted } = fakeDb([row("s1"), row("s2")]);
    const sent: [string, unknown][] = [];
    const transport: PushTransport = async (subscription, body) => {
      sent.push([subscription.endpoint, JSON.parse(body)]);
    };
    await new PushSender(db, transport).deliver(notification);
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual([
      "https://fcm.googleapis.com/fcm/send/s1",
      {
        title: "佐藤 美咲",
        body: "ご確認",
        tag: "mail:m1",
        messageId: "m1",
        accountId: "a1",
      },
    ]);
    expect(deleted).toEqual([]);
  });

  it("無効になった送り先 (404 / 410) は消し、残りは送らない", async () => {
    const { db, deleted } = fakeDb([row("gone"), row("ok")]);
    const sent: string[] = [];
    const transport: PushTransport = async (subscription) => {
      if (subscription.endpoint.endsWith("gone")) {
        throw Object.assign(new Error("expired"), { statusCode: 410 });
      }
      sent.push(subscription.endpoint);
    };
    await new PushSender(db, transport).deliver(notification);
    expect(deleted).toHaveLength(1);
    expect(sent).toEqual([
      "https://fcm.googleapis.com/fcm/send/ok",
      "https://fcm.googleapis.com/fcm/send/ok",
    ]);
  });

  it("一時的な失敗では送り先を残し、記録だけする", async () => {
    const { db, deleted } = fakeDb([row("s1")]);
    const logs: string[] = [];
    const transport: PushTransport = async () => {
      throw Object.assign(new Error("unavailable"), { statusCode: 503 });
    };
    await new PushSender(db, transport, (message) =>
      logs.push(message),
    ).deliver(notification);
    expect(deleted).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("503");
  });

  it("送り先が無ければ何もしない", async () => {
    const { db } = fakeDb([]);
    let called = false;
    await new PushSender(db, async () => {
      called = true;
    }).deliver(notification);
    expect(called).toBe(false);
  });
});

describe("通知のボタン", () => {
  it("設定があれば、メールごとの通知にボタンと合言葉を付ける", async () => {
    // 設定の行が無い利用者 (この DB の代わりは、どの問い合わせにも同じ行を返す) は標準のボタン。
    const { db } = fakeDb([row("s1")]);
    const sent: { messageId: string; actions?: Record<string, unknown> }[] = [];
    const key = Buffer.alloc(32, 3);
    await new PushSender(
      db,
      async (_subscription, body) => {
        sent.push(JSON.parse(body));
      },
      undefined,
      { key, url: "https://x/v1/notification-actions" },
    ).deliver(notification);
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(message.actions).toMatchObject({
        buttons: [
          { id: "read", title: "既読にする" },
          { id: "archive", title: "アーカイブ" },
          { id: "delete", title: "削除" },
        ],
        url: "https://x/v1/notification-actions",
      });
      expect(
        verifyNotificationAction(
          key,
          "u1",
          message.messageId,
          message.actions?.token,
        ),
      ).toBe(true);
    }
  });
});

describe("DevicePushSender", () => {
  const device = (id: string) => ({ id, pushToken: `token-${id}` });

  it("利用者の端末すべてに、メールごとの通知を送る", async () => {
    const { db, deleted } = fakeDb([device("d1"), device("d2")]);
    const sent: [string, string][] = [];
    await new DevicePushSender(db, {
      send: async (token, message) => {
        sent.push([token, message.tag]);
      },
    }).deliver(notification);
    expect(sent.sort()).toEqual([
      ["token-d1", "mail:m1"],
      ["token-d1", "mail:m2"],
      ["token-d2", "mail:m1"],
      ["token-d2", "mail:m2"],
    ]);
    expect(deleted).toEqual([]);
  });

  it("使えなくなった送り先は消し、残りは送らない", async () => {
    const { db, deleted } = fakeDb([device("gone"), device("ok")]);
    const sent: string[] = [];
    await new DevicePushSender(db, {
      send: async (token) => {
        if (token === "token-gone") {
          throw new FcmError(404, "UNREGISTERED", "not found");
        }
        sent.push(token);
      },
    }).deliver(notification);
    expect(deleted).toHaveLength(1);
    expect(sent).toEqual(["token-ok", "token-ok"]);
  });

  it("一時的な失敗では送り先を残し、記録だけする", async () => {
    const { db, deleted } = fakeDb([device("d1")]);
    const logs: string[] = [];
    await new DevicePushSender(
      db,
      {
        send: async () => {
          throw new FcmError(503, "UNAVAILABLE", "busy");
        },
      },
      (message) => logs.push(message),
    ).deliver(notification);
    expect(deleted).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("busy");
  });
});

describe("combineSenders", () => {
  it("設定されていなければ null", () => {
    expect(combineSenders([null, false, undefined])).toBeNull();
  });

  it("どれかが失敗しても、ほかへは届ける", async () => {
    const delivered: string[] = [];
    const sender = combineSenders([
      {
        deliver: async () => {
          throw new Error("web push failed");
        },
      },
      null,
      {
        deliver: async () => {
          delivered.push("fcm");
        },
      },
    ]);
    await expect(sender?.deliver(notification)).rejects.toThrow(
      "web push failed",
    );
    expect(delivered).toEqual(["fcm"]);
  });
});
