import { describe, expect, it } from "vitest";
import { DEFAULT_SWIPE, readSwipe, swipeSettings } from "./settings.js";

describe("スワイプ操作の設定", () => {
  it("保存していなければ、左で削除、右で既読 / 未読の切り替え", () => {
    expect(readSwipe(null)).toEqual(DEFAULT_SWIPE);
    expect(DEFAULT_SWIPE).toEqual({ left: "delete", right: "toggle_read" });
  });

  it("保存した操作をそのまま返す", () => {
    expect(readSwipe({ left: "none", right: "archive" })).toEqual({
      left: "none",
      right: "archive",
    });
  });

  it("知らない操作は、その向きだけ標準の値にする", () => {
    expect(readSwipe({ left: "snooze", right: "star" })).toEqual({
      left: "delete",
      right: "star",
    });
  });

  it("知らない操作や欠けた向きは受け付けない", () => {
    expect(swipeSettings.safeParse({ left: "x", right: "none" }).success).toBe(
      false,
    );
    expect(swipeSettings.safeParse({ left: "none" }).success).toBe(false);
  });
});
