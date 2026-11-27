import { describe, expect, it } from "vitest";
import {
  calendarEnabledFrom,
  calendarNotificationData,
  decodeBase64Url,
  enabledFrom,
  inboxUnreadCount,
  parseCalendarEvent,
  parseMailEvent,
  parseNotificationAction,
  rsvpActions,
  toDesktopCalendarNotification,
  unreadTitle,
} from "@/lib/notifications";

describe("unreadTitle", () => {
  it("未読があれば、題名の先頭に数を付ける", () => {
    expect(unreadTitle(0)).toBe("Orbit");
    expect(unreadTitle(3)).toBe("(3) Orbit");
    expect(unreadTitle(999)).toBe("(999) Orbit");
    expect(unreadTitle(1000)).toBe("(999+) Orbit");
  });
});

describe("inboxUnreadCount", () => {
  it("全アカウントの受信トレイの未読数を合計する (他のフォルダは数えない)", () => {
    expect(
      inboxUnreadCount([
        { specialUse: "inbox", unreadCount: 2 },
        { specialUse: "junk", unreadCount: 10 },
        { specialUse: null, unreadCount: 4 },
        { specialUse: "inbox", unreadCount: 1 },
      ]),
    ).toBe(3);
    expect(inboxUnreadCount([])).toBe(0);
  });
});

describe("decodeBase64Url", () => {
  it("パディングの無い base64url をバイト列にする", () => {
    expect([...decodeBase64Url("AQID")]).toEqual([1, 2, 3]);
    expect([...decodeBase64Url("-_8")]).toEqual([251, 255]);
    expect([...decodeBase64Url("_w")]).toEqual([255]);
  });
});

describe("parseMailEvent", () => {
  it("通知の一覧を取り出す", () => {
    const notification = {
      title: "佐藤 美咲",
      body: "ご確認",
      tag: "mail:m1",
      messageId: "m1",
    };
    expect(
      parseMailEvent(JSON.stringify({ notifications: [notification, 1] })),
    ).toEqual([notification]);
  });

  it("形式が違えば空", () => {
    expect(parseMailEvent("")).toEqual([]);
    expect(parseMailEvent("{}")).toEqual([]);
    expect(parseMailEvent('{"notifications":"x"}')).toEqual([]);
  });
});

describe("enabledFrom", () => {
  it("ブラウザーでは、オンにしたときだけ有効", () => {
    expect(enabledFrom(null, false)).toBe(false);
    expect(enabledFrom("on", false)).toBe(true);
    expect(enabledFrom("off", false)).toBe(false);
  });

  it("デスクトップ版では、オフにしない限り有効", () => {
    expect(enabledFrom(null, true)).toBe(true);
    expect(enabledFrom("on", true)).toBe(true);
    expect(enabledFrom("off", true)).toBe(false);
  });
});

describe("parseNotificationAction", () => {
  const messageId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8724";

  it("返信と、知っているボタンを受け付ける", () => {
    expect(
      parseNotificationAction({ messageId, action: "reply", text: "了解" }),
    ).toEqual({ messageId, action: "reply", text: "了解" });
    expect(parseNotificationAction({ messageId, action: "archive" })).toEqual({
      messageId,
      action: "archive",
    });
  });

  it("形の違うものは受け付けない", () => {
    for (const payload of [
      null,
      "reply",
      { messageId: "x", action: "read" },
      { messageId, action: "unknown" },
      { messageId, action: "reply" },
      { messageId, action: "reply", text: "  " },
    ]) {
      expect(parseNotificationAction(payload)).toBeNull();
    }
  });
});

describe("予定の通知 (段取り 9)", () => {
  const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const invite = {
    kind: "event-invite",
    title: "招待: 定例会議",
    body: "山田 太郎 さんから",
    tag: `cal-inv:${ID}`,
    eventId: ID,
    rsvp: {
      url: "https://api.example/v1/notification-actions/event",
      token: "t",
    },
  } as const;

  it("端末の設定は、メールの通知が有効なときだけ効く (未設定はメールと同じ)", () => {
    expect(calendarEnabledFrom(null, true)).toBe(true);
    expect(calendarEnabledFrom("off", true)).toBe(false);
    expect(calendarEnabledFrom("on", false)).toBe(false);
    expect(calendarEnabledFrom(null, false)).toBe(false);
  });

  it("SSE の calendar イベントから、形の正しい通知だけを取り出す", () => {
    expect(
      parseCalendarEvent(
        JSON.stringify({
          notifications: [
            invite,
            { ...invite, kind: "mail" },
            { ...invite, title: 1 },
            { ...invite, kind: "event-invites-batch", eventId: null },
          ],
        }),
      ).map((item) => item.kind),
    ).toEqual(["event-invite", "event-invites-batch"]);
    expect(parseCalendarEvent("x")).toEqual([]);
  });

  it("通知の data と Desktop の形", () => {
    expect(calendarNotificationData(invite, "https://api.example")).toEqual({
      kind: "event-invite",
      eventId: ID,
      recurrenceId: null,
      action: invite.rsvp,
    });
    // 自分の API の受け口でなければ、出欠の送り先を通知に入れない (M4)。
    for (const url of [
      "https://evil.example/v1/notification-actions/event",
      "https://api.example/v1/other",
      "https://api.example/v1/notification-actions/event?x=1",
      "javascript:alert(1)",
    ]) {
      expect(
        calendarNotificationData(
          { ...invite, rsvp: { url, token: "t" } },
          "https://api.example",
        ).action,
      ).toBeUndefined();
    }
    expect(toDesktopCalendarNotification(invite, true)).toEqual({
      kind: "event-invite",
      title: "招待: 定例会議",
      body: "山田 太郎 さんから",
      tag: `cal-inv:${ID}`,
      eventId: ID,
      recurrenceId: null,
      expiresAt: null,
      rsvp: true,
    });
    expect(rsvpActions(2).map((b) => b.action)).toEqual([
      "accepted",
      "declined",
    ]);
    expect(rsvpActions(3)).toHaveLength(3);
  });
});
