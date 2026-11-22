import { describe, expect, it } from "vitest";
import {
  appFontFamily,
  bodyStyle,
  cleanFontName,
  DEFAULT_PREFERENCES,
  parsePreferences,
} from "./preferences";

describe("parsePreferences", () => {
  it("保存が無ければ標準の値になる", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("壊れた値")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("[]")).toEqual(DEFAULT_PREFERENCES);
  });

  it("保存した項目だけを上書きする", () => {
    const result = parsePreferences(
      JSON.stringify({ density: "compact", previewLines: 0, hour12: true }),
    );
    expect(result).toEqual({
      ...DEFAULT_PREFERENCES,
      density: "compact",
      previewLines: 0,
      hour12: true,
    });
  });

  it("知らない値や型の合わない値は標準に戻す", () => {
    const result = parsePreferences(
      JSON.stringify({
        density: "huge",
        fontSize: 300,
        quickReply: "yes",
        bodyFontSize: 16,
        unknown: 1,
      }),
    );
    expect(result).toEqual({ ...DEFAULT_PREFERENCES, bodyFontSize: 16 });
  });

  it("アカウントの印は、標準では設定したアイコンを出す", () => {
    expect(parsePreferences(null).accountMarkStyle).toBe("icon");
    expect(
      parsePreferences(JSON.stringify({ accountMarkStyle: "dot" }))
        .accountMarkStyle,
    ).toBe("dot");
    expect(
      parsePreferences(JSON.stringify({ accountMarkStyle: "big" }))
        .accountMarkStyle,
    ).toBe("icon");
  });

  it("フォント名から CSS を壊す文字を取り除く", () => {
    const result = parsePreferences(
      JSON.stringify({
        font: "custom",
        customFont: 'Yu Gothic UI"; color:red',
      }),
    );
    expect(result.customFont).toBe("Yu Gothic UI colorred");
  });
});

describe("cleanFontName", () => {
  it("日本語の名前はそのまま使える", () => {
    expect(cleanFontName(" 游ゴシック Medium ")).toBe("游ゴシック Medium");
  });
});

describe("appFontFamily", () => {
  it("標準では見出しに Display を使う", () => {
    const family = appFontFamily(DEFAULT_PREFERENCES);
    expect(family.sans).toContain('"Gen Interface JP"');
    expect(family.heading).toContain('"Gen Interface JP Display"');
  });

  it("名前を指定したフォントを先頭にし、無いときのために標準のフォントを続ける", () => {
    const family = appFontFamily({
      font: "custom",
      customFont: "BIZ UDGothic",
    });
    expect(family.sans.startsWith('"BIZ UDGothic", "Gen Interface JP"')).toBe(
      true,
    );
    expect(family.heading).toBe(family.sans);
  });

  it("名前が空なら標準のフォントにする", () => {
    expect(appFontFamily({ font: "custom", customFont: "" })).toEqual(
      appFontFamily(DEFAULT_PREFERENCES),
    );
  });
});

describe("bodyStyle", () => {
  it("本文のフォント、大きさ、行間をまとめる", () => {
    expect(
      bodyStyle({ bodyFont: "sans", bodyFontSize: 16, bodyLineHeight: 1.8 }),
    ).toBe("font-family:system-ui, sans-serif;font-size:16px;line-height:1.8");
  });
});
