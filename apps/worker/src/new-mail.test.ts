import type { NewMailNotification } from "@mail/core";
import type { Database } from "@mail/db";
import { describe, expect, it } from "vitest";
import {
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

type Row = { id: string; endpoint: string; p256dh: string; auth: string };

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

const row = (id: string): Row => ({
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
      { title: "佐藤 美咲", body: "ご確認", tag: "mail:m1", messageId: "m1" },
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
