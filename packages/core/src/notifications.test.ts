import { describe, expect, it } from "vitest";
import {
  isAllowedPushEndpoint,
  loadWebPushConfig,
  type NewMailCandidate,
  toNewMailNotification,
  toPushMessages,
} from "./notifications.js";

const account = { id: "a1", userId: "u1" };
const now = Date.parse("2026-11-22T00:00:00Z");

function candidate(
  overrides: Partial<NewMailCandidate> = {},
): NewMailCandidate {
  return {
    id: "m1",
    from: [{ name: "佐藤 美咲", address: "misaki@example.com" }],
    subject: "ご確認",
    seen: false,
    receivedAt: new Date(now - 60_000),
    ...overrides,
  };
}

describe("toNewMailNotification", () => {
  it("未読で新しいメールだけを、新しい順に知らせる", () => {
    const result = toNewMailNotification(
      account,
      [
        candidate({ id: "old", receivedAt: new Date(now - 25 * 3600_000) }),
        candidate({ id: "read", seen: true }),
        candidate({ id: "m1", receivedAt: new Date(now - 120_000) }),
        candidate({ id: "m2", from: [{ address: "noreply@example.com" }] }),
      ],
      now,
    );
    expect(result).toEqual({
      userId: "u1",
      accountId: "a1",
      count: 2,
      messages: [
        { id: "m2", from: "noreply@example.com", subject: "ご確認" },
        { id: "m1", from: "佐藤 美咲", subject: "ご確認" },
      ],
    });
  });

  it("知らせるものが無ければ null", () => {
    expect(
      toNewMailNotification(account, [candidate({ seen: true })], now),
    ).toBeNull();
    expect(toNewMailNotification(account, [], now)).toBeNull();
  });

  it("多いときは先頭の 5 件だけを載せ、件数は全体を伝える。長い件名は切り詰める", () => {
    const result = toNewMailNotification(
      account,
      Array.from({ length: 8 }, (_, index) =>
        candidate({ id: `m${index}`, subject: "あ".repeat(400) }),
      ),
      now,
    );
    expect(result?.count).toBe(8);
    expect(result?.messages).toHaveLength(5);
    expect([...(result?.messages[0]?.subject ?? "")]).toHaveLength(150);
    expect(JSON.stringify(result).length).toBeLessThan(7000);
  });
});

describe("toPushMessages", () => {
  it("少なければ 1 通ずつ通知する", () => {
    expect(
      toPushMessages({
        accountId: "a1",
        count: 2,
        messages: [
          { id: "m1", from: "佐藤 美咲", subject: "ご確認" },
          { id: "m2", from: "", subject: "" },
        ],
      }),
    ).toEqual([
      {
        title: "佐藤 美咲",
        body: "ご確認",
        tag: "mail:m1",
        messageId: "m1",
      },
      {
        title: "新着メール",
        body: "(件名なし)",
        tag: "mail:m2",
        messageId: "m2",
      },
    ]);
  });

  it("多ければ 1 件にまとめる", () => {
    const messages = ["佐藤", "田中", "佐藤", "山本", "高橋"].map(
      (from, index) => ({ id: `m${index}`, from, subject: "件名" }),
    );
    expect(toPushMessages({ accountId: "a1", count: 8, messages })).toEqual([
      {
        title: "新着メール 8 件",
        body: "佐藤、田中、山本 ほか",
        tag: "mail-batch:a1:m0",
        messageId: null,
      },
    ]);
  });
});

describe("loadWebPushConfig", () => {
  it("鍵が無ければ null (Web Push を使わない)", () => {
    expect(loadWebPushConfig({})).toBeNull();
    expect(loadWebPushConfig({ VAPID_PUBLIC_KEY: "abc" })).toBeNull();
  });

  it("鍵と連絡先を読み込む", () => {
    expect(
      loadWebPushConfig({
        VAPID_PUBLIC_KEY: "BPub_key-1",
        VAPID_PRIVATE_KEY: "priv",
        VAPID_SUBJECT: "mailto:me@example.com",
      }),
    ).toEqual({
      publicKey: "BPub_key-1",
      privateKey: "priv",
      subject: "mailto:me@example.com",
    });
  });

  it("形式の違う値は起動時に止める", () => {
    expect(() =>
      loadWebPushConfig({ VAPID_PUBLIC_KEY: "a+b/", VAPID_PRIVATE_KEY: "x" }),
    ).toThrow();
    expect(() =>
      loadWebPushConfig({
        VAPID_PUBLIC_KEY: "a",
        VAPID_PRIVATE_KEY: "x",
        VAPID_SUBJECT: "me@example.com",
      }),
    ).toThrow();
  });
});

describe("isAllowedPushEndpoint", () => {
  it("主要なブラウザーのプッシュサービスだけを受け付ける", () => {
    expect(
      isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"),
    ).toBe(true);
    expect(
      isAllowedPushEndpoint(
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
      ),
    ).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(
      isAllowedPushEndpoint(
        "https://wns2-par02p.notify.windows.com/w/?token=a",
      ),
    ).toBe(true);
  });

  it("それ以外の URL は受け付けない", () => {
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/a")).toBe(
      false,
    );
    expect(isAllowedPushEndpoint("https://localhost/push")).toBe(false);
    expect(
      isAllowedPushEndpoint("https://evilfcm.googleapis.com.example/"),
    ).toBe(false);
    expect(isAllowedPushEndpoint("https://notfcm.googleapis.com/")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/a")).toBe(
      false,
    );
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });
});
