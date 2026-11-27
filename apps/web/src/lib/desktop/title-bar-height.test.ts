import { describe, expect, it } from "vitest";
import { parseCssLength } from "./title-bar-height";

describe("parseCssLength", () => {
  it("rem は文字の大きさを掛けて px にする", () => {
    expect(parseCssLength("2rem", 16)).toBe(32);
    expect(parseCssLength(" 2.25rem", 16)).toBe(36);
  });
  it("px と単位なしはそのまま", () => {
    expect(parseCssLength("36px", 16)).toBe(36);
    expect(parseCssLength("0", 16)).toBe(0);
  });
  it("読めない値は 0", () => {
    expect(parseCssLength("", 16)).toBe(0);
    expect(parseCssLength("calc(1rem + 2px)", 16)).toBe(0);
  });
});
