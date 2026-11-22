import { describe, expect, it } from "vitest";
import {
  contrast,
  hexToHsv,
  hsvToHex,
  mix,
  normalizeHex,
  readableOn,
  textOn,
} from "./color";

describe("normalizeHex", () => {
  it("書き方の違いをそろえる", () => {
    expect(normalizeHex("#0EA5E9")).toBe("#0ea5e9");
    expect(normalizeHex(" 0ea5e9 ")).toBe("#0ea5e9");
    expect(normalizeHex("#f80")).toBe("#ff8800");
    expect(normalizeHex("＃ＦＦ８８００")).toBe("#ff8800");
  });

  it("色として読めないものは null", () => {
    for (const text of ["", "#12", "#12345", "#gggggg", "sky", "#1234567"]) {
      expect(normalizeHex(text)).toBeNull();
    }
  });
});

describe("hexToHsv / hsvToHex", () => {
  it("行って戻ると同じ色になる", () => {
    for (const hex of ["#000000", "#ffffff", "#0ea5e9", "#be123c", "#808080"]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("色合い・鮮やかさ・明るさを取り出す", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00ff00").h).toBe(120);
    expect(hexToHsv("#0000ff").h).toBe(240);
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
  });
});

describe("contrast / mix", () => {
  it("白と黒は 21", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21);
    expect(contrast("#777777", "#777777")).toBe(1);
  });

  it("割合で重ねる", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#123456", "#ffffff", 0)).toBe("#123456");
  });
});

describe("readableOn", () => {
  it("足りている色は変えない", () => {
    expect(readableOn("#be123c", "#ffffff")).toBe("#be123c");
    expect(readableOn("#0ea5e9", "#171717")).toBe("#0ea5e9");
  });

  it("地の色に近い色は、見分けられる明るさまで寄せる", () => {
    for (const [hex, background] of [
      ["#ffffff", "#ffffff"],
      ["#fef08a", "#ffffff"],
      ["#000000", "#171717"],
      ["#1e1b4b", "#171717"],
    ] as const) {
      const adjusted = readableOn(hex, background);
      expect(adjusted).not.toBe(hex);
      expect(
        contrast(adjusted, mix(background, adjusted, 0.15)),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("textOn", () => {
  it("読みやすい方の文字色を返す", () => {
    expect(textOn("#1e1b4b")).toBe("#ffffff");
    expect(textOn("#fef08a")).toBe("#171717");
  });
});
