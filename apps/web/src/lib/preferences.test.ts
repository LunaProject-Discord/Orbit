import { describe, expect, it } from "vitest";
import {
  appFontFamily,
  bodyExtraCss,
  bodyFontFamily,
  bodyStyle,
  cleanFontName,
  DEFAULT_PREFERENCES,
  genericFontFamily,
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

  it("アカウントのマークは、標準では設定したアイコンを出す", () => {
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

describe("cleanFontName の記号", () => {
  it("+ と () は残し、CSS を壊す記号は取り除く", () => {
    expect(cleanFontName("M+ 1p")).toBe("M+ 1p");
    expect(cleanFontName("Source Han Sans (JP)")).toBe("Source Han Sans (JP)");
    expect(cleanFontName('a"b\\c<d>e;f')).toBe("abcdef");
  });
});

describe("genericFontFamily", () => {
  it("指定が無ければ、最後は総称ファミリーに任せる", () => {
    expect(genericFontFamily("sans").endsWith(", sans-serif")).toBe(true);
    expect(genericFontFamily("serif").endsWith(", serif")).toBe(true);
    expect(genericFontFamily("mono").endsWith(", monospace")).toBe(true);
  });

  it("種類ごとのフォントを先頭に置き、無いときのための続きを残す", () => {
    expect(genericFontFamily("serif", { serifFont: "BIZ UDMincho" })).toBe(
      `"BIZ UDMincho", ${genericFontFamily("serif")}`,
    );
    expect(
      genericFontFamily("mono", { monoFont: "Cascadia Mono" }).startsWith(
        '"Cascadia Mono", ',
      ),
    ).toBe(true);
    // ほかの種類のフォントは混ざらない。
    expect(genericFontFamily("sans", { serifFont: "BIZ UDMincho" })).toBe(
      genericFontFamily("sans"),
    );
  });
});

describe("appFontFamily", () => {
  it("ゴシック体・明朝体・等幅は、種類ごとのフォントを使う", () => {
    const names = {
      customFont: "",
      sansFont: "BIZ UDPGothic",
      serifFont: "BIZ UDPMincho",
      monoFont: "Cascadia Mono",
    };
    expect(appFontFamily({ font: "sans", ...names }).sans).toBe(
      genericFontFamily("sans", names),
    );
    expect(appFontFamily({ font: "serif", ...names }).heading).toBe(
      genericFontFamily("serif", names),
    );
    expect(appFontFamily({ font: "mono", ...names }).sans).toBe(
      genericFontFamily("mono", names),
    );
    // 既定のフォントが何でも、等幅の表示には等幅のフォントを使う。
    expect(appFontFamily({ font: "default", ...names }).mono).toBe(
      genericFontFamily("mono", names),
    );
  });

  it("システム標準は端末の画面のフォントにする", () => {
    expect(appFontFamily({ font: "system", customFont: "" }).sans).toBe(
      "system-ui, sans-serif",
    );
  });

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

describe("bodyExtraCss", () => {
  it("等幅のフォントを設定していなければ、何も足さない", () => {
    expect(bodyExtraCss({})).toBe("");
    expect(bodyExtraCss({ monoFont: '";' })).toBe("");
  });

  it("等幅のフォントを、フォントの指定が無い等幅の部分に使う", () => {
    const css = bodyExtraCss({ monoFont: "Cascadia Mono" });
    expect(css.startsWith("pre,code,")).toBe(true);
    expect(css).toContain('{font-family:"Cascadia Mono", ');
    expect(css.endsWith("monospace}")).toBe(true);
  });
});

describe("bodyFontFamily", () => {
  it("一覧から選んだフォントを先頭にし、無いときのためにゴシック体を続ける", () => {
    expect(
      bodyFontFamily({
        bodyFont: "custom",
        bodyCustomFont: "BIZ UDPGothic",
        sansFont: "Meiryo",
      }),
    ).toBe('"BIZ UDPGothic", "Meiryo", system-ui, sans-serif');
    expect(bodyFontFamily({ bodyFont: "custom", bodyCustomFont: "" })).toBe(
      "system-ui, sans-serif",
    );
  });
});

describe("bodyStyle", () => {
  it("本文のフォント、大きさ、行間をまとめる", () => {
    expect(
      bodyStyle({ bodyFont: "sans", bodyFontSize: 16, bodyLineHeight: 1.8 }),
    ).toBe("font-family:system-ui, sans-serif;font-size:16px;line-height:1.8");
  });

  it("種類ごとのフォントを設定していれば、本文にも使う", () => {
    const names = { sansFont: "BIZ UDPGothic", serifFont: "BIZ UDPMincho" };
    const base = { bodyFontSize: 14, bodyLineHeight: 1.6 };
    expect(bodyStyle({ bodyFont: "sans", ...base, ...names })).toContain(
      'font-family:"BIZ UDPGothic", system-ui, sans-serif;',
    );
    expect(bodyStyle({ bodyFont: "serif", ...base, ...names })).toContain(
      'font-family:"BIZ UDPMincho", ',
    );
  });
});
