import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_ACTION_TTL_MS,
  notificationActionUrl,
  readNotificationActions,
  signNotificationAction,
  toPushActions,
  verifyNotificationAction,
} from "./notification-actions.js";

const key = Buffer.alloc(32, 7);
const now = Date.parse("2026-11-22T00:00:00Z");

describe("readNotificationActions", () => {
  it("保存していなければ標準のボタン", () => {
    expect(readNotificationActions(null)).toEqual([
      "read",
      "archive",
      "delete",
    ]);
  });

  it("知らないボタンと重複を捨て、3 つまでにする", () => {
    expect(
      readNotificationActions([
        "junk",
        "reply",
        "junk",
        "star",
        "read",
        "delete",
      ]),
    ).toEqual(["junk", "star", "read"]);
  });

  it("空の配列は、ボタンを付けない設定として残す", () => {
    expect(readNotificationActions([])).toEqual([]);
  });
});

describe("notificationActionUrl", () => {
  it("API の公開 URL から作る", () => {
    expect(notificationActionUrl("https://orbit.example.jp/")).toBe(
      "https://orbit.example.jp/v1/notification-actions",
    );
    expect(notificationActionUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/v1/notification-actions",
    );
  });

  it("URL が分からなければ null", () => {
    expect(notificationActionUrl(undefined)).toBeNull();
    expect(notificationActionUrl("orbit")).toBeNull();
  });
});

describe("合言葉", () => {
  const token = signNotificationAction(key, "u1", "m1", now);

  it("同じ利用者の同じメールでだけ通る", () => {
    expect(verifyNotificationAction(key, "u1", "m1", token, now)).toBe(true);
    expect(verifyNotificationAction(key, "u1", "m2", token, now)).toBe(false);
    expect(verifyNotificationAction(key, "u2", "m1", token, now)).toBe(false);
    expect(
      verifyNotificationAction(Buffer.alloc(32, 8), "u1", "m1", token, now),
    ).toBe(false);
  });

  it("期限を過ぎたら通らない。期限を書き換えても通らない", () => {
    const later = now + NOTIFICATION_ACTION_TTL_MS + 1;
    expect(verifyNotificationAction(key, "u1", "m1", token, later)).toBe(false);
    const [, sig] = token.split(".");
    expect(
      verifyNotificationAction(
        key,
        "u1",
        "m1",
        `${later + 1000}.${sig}`,
        later,
      ),
    ).toBe(false);
  });

  it("形の違う値は通らない", () => {
    for (const value of [null, "", "abc", ".abc", "12."]) {
      expect(verifyNotificationAction(key, "u1", "m1", value, now)).toBe(false);
    }
  });
});

describe("toPushActions", () => {
  const signer = {
    actions: ["read", "junk"] as const,
    url: "https://x/v1/notification-actions",
    sign: (id: string) => `t-${id}`,
  };

  it("設定した順のボタンと、送り先、合言葉を載せる", () => {
    expect(toPushActions(signer, "m1")).toEqual({
      buttons: [
        { id: "read", title: "既読にする" },
        { id: "junk", title: "迷惑メール" },
      ],
      url: "https://x/v1/notification-actions",
      token: "t-m1",
      reply: false,
    });
  });

  it("ボタンも返信欄も無ければ何も付けない", () => {
    expect(toPushActions(null, "m1")).toBeUndefined();
    expect(toPushActions({ ...signer, actions: [] }, "m1")).toBeUndefined();
  });

  it("返信欄を出すときは、ボタンが無くても合言葉を付ける", () => {
    expect(
      toPushActions({ ...signer, actions: [], reply: true }, "m1"),
    ).toEqual({
      buttons: [],
      url: "https://x/v1/notification-actions",
      token: "t-m1",
      reply: true,
    });
  });
});
