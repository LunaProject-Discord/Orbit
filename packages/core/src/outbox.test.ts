import { describe, expect, it } from "vitest";
import { mailboxNameError } from "./outbox.js";

describe("mailboxNameError", () => {
  it("普通の名前は通す (日本語、空白を含む名前も)", () => {
    expect(mailboxNameError("請求書", "/")).toBeNull();
    expect(mailboxNameError("2026 年度", ".")).toBeNull();
    expect(mailboxNameError("a.b", "/")).toBeNull();
  });

  it("空の名前と、前後に空白のある名前は通さない", () => {
    expect(mailboxNameError("", "/")).toBe("empty");
    expect(mailboxNameError("   ", "/")).toBe("empty");
    expect(mailboxNameError(" a", "/")).toBe("invalid_character");
  });

  it("区切り文字、ワイルドカード、制御文字は通さない", () => {
    expect(mailboxNameError("a/b", "/")).toBe("invalid_character");
    expect(mailboxNameError("a.b", ".")).toBe("invalid_character");
    expect(mailboxNameError("100%", "/")).toBe("invalid_character");
    expect(mailboxNameError("a*", null)).toBe("invalid_character");
    expect(mailboxNameError("a\nb", null)).toBe("invalid_character");
  });

  it("長すぎる名前は通さない", () => {
    expect(mailboxNameError("あ".repeat(100), "/")).toBeNull();
    expect(mailboxNameError("あ".repeat(101), "/")).toBe("too_long");
  });
});
