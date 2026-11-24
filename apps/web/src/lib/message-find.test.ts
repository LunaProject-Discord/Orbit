import { describe, expect, it } from "vitest";
import { findOffsets } from "@/lib/message-find";

describe("findOffsets", () => {
  it("大文字と小文字、全角と半角の英数字を区別せずに探す", () => {
    expect(findOffsets("Orbit と ＯＲＢＩＴ と orbit", "orbit")).toEqual([
      0, 8, 16,
    ]);
  });

  it("重ならないように探す", () => {
    expect(findOffsets("aaaa", "aa")).toEqual([0, 2]);
  });

  it("空の語では何も返さない", () => {
    expect(findOffsets("abc", " ".trim())).toEqual([]);
  });
});
