import { describe, expect, it } from "vitest";
import {
  EVENT_NOTIFICATION_ACTION_TTL_MS,
  notificationEventActionUrl,
  signEventNotificationAction,
  verifyEventNotificationAction,
} from "./event-notification-actions.js";
import { signNotificationAction } from "./notification-actions.js";

const key = Buffer.alloc(32, 7);
const now = Date.parse("2026-11-27T00:00:00Z");

describe("出欠の合言葉", () => {
  const token = signEventNotificationAction(key, "u1", "e1", now);

  it("同じ利用者の同じ予定でだけ通る", () => {
    expect(verifyEventNotificationAction(key, "u1", "e1", token, now)).toBe(
      true,
    );
    expect(verifyEventNotificationAction(key, "u2", "e1", token, now)).toBe(
      false,
    );
    expect(verifyEventNotificationAction(key, "u1", "e2", token, now)).toBe(
      false,
    );
    expect(
      verifyEventNotificationAction(
        Buffer.alloc(32, 8),
        "u1",
        "e1",
        token,
        now,
      ),
    ).toBe(false);
  });

  it("期限を過ぎたら通らない", () => {
    expect(
      verifyEventNotificationAction(
        key,
        "u1",
        "e1",
        token,
        now + EVENT_NOTIFICATION_ACTION_TTL_MS,
      ),
    ).toBe(true);
    expect(
      verifyEventNotificationAction(
        key,
        "u1",
        "e1",
        token,
        now + EVENT_NOTIFICATION_ACTION_TTL_MS + 1,
      ),
    ).toBe(false);
  });

  it("メールの合言葉は使い回せない", () => {
    const mail = signNotificationAction(key, "u1", "e1", now);
    expect(verifyEventNotificationAction(key, "u1", "e1", mail, now)).toBe(
      false,
    );
  });

  it("形の違う値は通らない", () => {
    for (const value of [undefined, 1, "", "abc", ".x", "1.x"]) {
      expect(verifyEventNotificationAction(key, "u1", "e1", value, now)).toBe(
        false,
      );
    }
  });

  it("送り先の URL", () => {
    expect(notificationEventActionUrl("https://orbit.example.jp/api/")).toBe(
      "https://orbit.example.jp/api/v1/notification-actions/event",
    );
    expect(notificationEventActionUrl(undefined)).toBeNull();
    expect(notificationEventActionUrl("ftp://x")).toBeNull();
  });
});
