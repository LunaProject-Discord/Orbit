import { describe, expect, it } from "vitest";
import { normalizeFonts } from "@/lib/local-fonts";
// 一覧は表示名 (label) の順。游ゴシックは英字の名前より後になる。
import { buildFontRows } from "./font-picker";

const fonts = normalizeFonts([
  { family: "Arial" },
  { family: "Consolas", monospace: true },
  { family: "Noto Serif JP" },
  { family: "Yu Gothic", label: "游ゴシック" },
  { family: "Wingdings" },
]);

const describeRows = (rows: ReturnType<typeof buildFontRows>) =>
  rows.map((row) =>
    row.kind === "font"
      ? row.font.family
      : row.kind === "typed"
        ? `typed:${row.family}`
        : row.kind,
  );

describe("buildFontRows", () => {
  it("自動 → その種類のフォント → 残り の順に、区切り線で分ける", () => {
    expect(
      describeRows(
        buildFontRows(fonts, { query: "", fontKind: "sans", canType: true }),
      ),
    ).toEqual([
      "empty",
      "separator",
      "Arial",
      "Yu Gothic",
      "separator",
      "Consolas",
      "Noto Serif JP",
      "Wingdings",
    ]);
    expect(
      describeRows(
        buildFontRows(fonts, { query: "", fontKind: "serif", canType: true }),
      ),
    ).toEqual([
      "empty",
      "separator",
      "Noto Serif JP",
      "separator",
      "Arial",
      "Consolas",
      "Wingdings",
      "Yu Gothic",
    ]);
    expect(
      describeRows(
        buildFontRows(fonts, { query: "", fontKind: "mono", canType: true }),
      )[2],
    ).toBe("Consolas");
  });

  it("検索で片方が空なら、余分な区切り線を入れない", () => {
    expect(
      describeRows(
        buildFontRows(fonts, {
          query: "serif",
          fontKind: "serif",
          canType: false,
        }),
      ),
    ).toEqual(["Noto Serif JP"]);
    expect(
      describeRows(
        buildFontRows(fonts, { query: "zz", fontKind: "sans", canType: true }),
      ),
    ).toEqual(["typed:zz"]);
  });

  it("種類を指定しなければ、今までどおり名前順", () => {
    expect(
      describeRows(buildFontRows(fonts, { query: "", canType: true })),
    ).toEqual([
      "empty",
      "Arial",
      "Consolas",
      "Noto Serif JP",
      "Wingdings",
      "Yu Gothic",
    ]);
  });
});
