// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fontListSupport,
  loadLocalFonts,
  normalizeFonts,
  preloadLocalFonts,
  resetLocalFontsForTest,
  searchFonts,
} from "./local-fonts";

type FontWindow = {
  queryLocalFonts?: () => Promise<{ family: string }[]>;
  __TAURI_INTERNALS__?: unknown;
};
const fontWindow = window as unknown as FontWindow;

afterEach(() => {
  delete fontWindow.queryLocalFonts;
  delete fontWindow.__TAURI_INTERNALS__;
  resetLocalFontsForTest();
  vi.restoreAllMocks();
});

describe("fontListSupport", () => {
  it("一覧を取る手段が無いブラウザーでは none", () => {
    expect(fontListSupport()).toBe("none");
  });

  it("queryLocalFonts があれば browser、デスクトップ版では desktop", () => {
    fontWindow.queryLocalFonts = async () => [];
    expect(fontListSupport()).toBe("browser");
    fontWindow.__TAURI_INTERNALS__ = {};
    expect(fontListSupport()).toBe("desktop");
  });
});

describe("normalizeFonts", () => {
  it("太さ違いをまとめ、名前順に並べる", () => {
    expect(
      normalizeFonts([
        { family: "Yu Gothic" },
        { family: "Arial" },
        { family: "Yu Gothic" },
      ]).map((font) => font.family),
    ).toEqual(["Arial", "Yu Gothic"]);
  });

  it("縦書き用の別名と、設定に保存できない名前は出さない", () => {
    expect(
      normalizeFonts([
        { family: "@MS Gothic" },
        { family: 'Bad"Name' },
        { family: "" },
        { family: 1 },
        { family: "M+ 1p" },
      ]).map((font) => font.family),
    ).toEqual(["M+ 1p"]);
  });

  it("日本語の名前と等幅の印を引き継ぐ", () => {
    expect(
      normalizeFonts([
        { family: "MS Gothic", label: "ＭＳ ゴシック", monospace: true },
      ]),
    ).toEqual([
      { family: "MS Gothic", label: "ＭＳ ゴシック", monospace: true },
    ]);
  });
});

describe("searchFonts", () => {
  const fonts = normalizeFonts([
    { family: "Yu Gothic", label: "游ゴシック" },
    { family: "Yu Mincho", label: "游明朝" },
    { family: "BIZ UDPGothic" },
  ]);

  it("表示名でも CSS の名前でも探せる", () => {
    expect(searchFonts(fonts, "明朝").map((font) => font.family)).toEqual([
      "Yu Mincho",
    ]);
    expect(searchFonts(fonts, "yu goth").map((font) => font.family)).toEqual([
      "Yu Gothic",
    ]);
  });

  it("検索語が空なら全部返す", () => {
    expect(searchFonts(fonts, "  ")).toHaveLength(3);
  });
});

describe("loadLocalFonts", () => {
  it("一覧を取れない環境では、何も呼ばずに終わる", async () => {
    await expect(loadLocalFonts()).resolves.toBeUndefined();
    await expect(preloadLocalFonts()).resolves.toBeUndefined();
  });

  it("取得済みなら、もう一度は尋ねない", async () => {
    const query = vi.fn(async () => [{ family: "Arial" }]);
    fontWindow.queryLocalFonts = query;
    await loadLocalFonts();
    await loadLocalFonts();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("拒否されても例外にせず、次に開いたときにまた試せる", async () => {
    const query = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    fontWindow.queryLocalFonts = query;
    await expect(loadLocalFonts()).resolves.toBeUndefined();
    await loadLocalFonts();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
