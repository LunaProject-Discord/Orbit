import { describe, expect, it } from "vitest";
import { accountIcon } from "./account-icon.js";

const accepts = (value: string) => accountIcon.safeParse(value).success;

describe("accountIcon", () => {
  it("アイコンの名前を受け付ける", () => {
    expect(accepts("house")).toBe(true);
    expect(accepts("gamepad-2")).toBe(true);
  });

  it("絵文字を受け付ける", () => {
    for (const emoji of ["🏠", "👋🏽", "👨‍👩‍👧‍👦", "🇯🇵", "1️⃣", "❤️", "🏴󠁧󠁢󠁥󠁮󠁧󠁿"]) {
      expect(accepts(emoji), emoji).toBe(true);
    }
  });

  it("それ以外の文字列は受け付けない", () => {
    for (const value of [
      "",
      "House",
      "-house",
      "house--2",
      "家",
      "house 🏠",
      "<script>",
      "a".repeat(65),
      "🏠".repeat(40),
    ]) {
      expect(accepts(value), value).toBe(false);
    }
  });
});
