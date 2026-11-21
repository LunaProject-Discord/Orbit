import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  inboxUnreadCount,
  parseMailEvent,
  unreadTitle,
} from "@/lib/notifications";

describe("unreadTitle", () => {
  it("未読があれば、題名の先頭に数を付ける", () => {
    expect(unreadTitle(0)).toBe("Mail");
    expect(unreadTitle(3)).toBe("(3) Mail");
    expect(unreadTitle(999)).toBe("(999) Mail");
    expect(unreadTitle(1000)).toBe("(999+) Mail");
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
