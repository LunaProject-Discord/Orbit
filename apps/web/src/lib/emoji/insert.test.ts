import { describe, expect, it } from "vitest";
import { insertIntoText } from "./insert";

describe("insertIntoText", () => {
  it("カーソルの位置に入れ、その後ろにカーソルを置く", () => {
    expect(insertIntoText("こんにちは", { start: 2, end: 2 }, "😀")).toEqual({
      value: "こん😀にちは",
      caret: 4,
    });
  });

  it("選択している範囲を置き換える", () => {
    expect(insertIntoText("abcdef", { start: 1, end: 4 }, "🚀")).toEqual({
      value: "a🚀ef",
      caret: 3,
    });
  });

  it("位置が分からなければ末尾に足す", () => {
    expect(insertIntoText("abc", { start: null, end: null }, "👋")).toEqual({
      value: "abc👋",
      caret: 5,
    });
  });

  it("maxLength を超えるなら入れない", () => {
    expect(insertIntoText("abc", { start: 3, end: 3 }, "👋", 4)).toBeNull();
    expect(insertIntoText("abc", { start: 3, end: 3 }, "👋", 5)).not.toBeNull();
  });
});
