import { describe, expect, it } from "vitest";
import { profileInitial } from "./profile-card";

describe("profileInitial", () => {
  it("名前の先頭の 1 文字を大文字で返す", () => {
    expect(profileInitial({ name: "boss", address: "b@example.com" })).toBe(
      "B",
    );
    expect(
      profileInitial({ name: "佐藤 花子", address: "s@example.com" }),
    ).toBe("佐");
  });

  it("名前が無ければアドレスの先頭、絵文字は 1 文字として扱う", () => {
    expect(profileInitial({ address: "news@example.com" })).toBe("N");
    expect(profileInitial({ name: "😀 Team", address: "t@example.com" })).toBe(
      "😀",
    );
  });
});
