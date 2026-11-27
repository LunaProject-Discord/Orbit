// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFonts, resetLocalFontsForTest } from "./local-fonts";
import {
  isWebFontStylesheet,
  loadWebFonts,
  resetWebFontsForTest,
  WEB_FONTS,
  webFontStylesheets,
  withWebFonts,
} from "./web-fonts";

afterEach(() => {
  resetWebFontsForTest();
  resetLocalFontsForTest();
  vi.restoreAllMocks();
  for (const link of document.head.querySelectorAll("link[data-web-font]")) {
    link.remove();
  }
});

/** 文字の幅を返す canvas の代わり。installed の名前のフォントだけ幅が変わる。 */
function mockCanvas(installed: string[]) {
  let font = "";
  const context = {
    set font(value: string) {
      font = value;
    },
    get font() {
      return font;
    },
    measureText: () => ({
      width: installed.some((name) => font.includes(`"${name}"`)) ? 120 : 100,
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
}

describe("withWebFonts", () => {
  it("端末に無い Web フォントを候補に足し、名前順に並べる", () => {
    const fonts = withWebFonts(
      normalizeFonts([{ family: "Noto Sans JP" }, { family: "Arial" }]),
    );
    expect(fonts.map((font) => [font.family, font.source])).toEqual([
      ["Arial", undefined],
      ["Gen Interface JP", "bundled"],
      ["Noto Sans JP", undefined],
      ["Noto Serif JP", "web"],
    ]);
    expect(fonts.find((font) => font.family === "Noto Serif JP")?.kind).toBe(
      "serif",
    );
  });
});

describe("webFontStylesheets", () => {
  it("端末に無いフォントのスタイルシートだけを返す", () => {
    mockCanvas(["Noto Sans JP"]);
    const urls = webFontStylesheets(
      ["Noto Sans JP", "noto serif jp", "Arial", ""],
      "page",
    );
    expect(urls).toEqual(
      WEB_FONTS.find((font) => font.family === "Noto Serif JP")?.stylesheets,
    );
    expect(urls[0]).toContain("fonts.googleapis.com");
  });

  it("同梱の Gen Interface JP は、メール本文の枠でだけ jsDelivr から読み込む", () => {
    mockCanvas([]);
    expect(webFontStylesheets(["Gen Interface JP"], "page")).toEqual([]);
    const urls = webFontStylesheets(["Gen Interface JP"], "frame");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/gen-interface-jp@[\d.]+\/cdn\/\d+\.css$/,
      );
      expect(isWebFontStylesheet(url)).toBe(true);
    }
  });

  it("調べた結果を覚え、Web フォントを読み込んだ後に調べ直さない", () => {
    mockCanvas([]);
    expect(webFontStylesheets(["Noto Serif JP"], "page")).toHaveLength(1);
    // 読み込んだ Web フォントで幅が変わっても、端末に入っているとは見なさない。
    mockCanvas(["Noto Serif JP"]);
    expect(webFontStylesheets(["Noto Serif JP"], "frame")).toHaveLength(1);
  });

  it("決まったスタイルシート以外は通さない", () => {
    expect(isWebFontStylesheet("https://example.com/a.css")).toBe(false);
  });
});

describe("loadWebFonts", () => {
  it("スタイルシートを 1 度だけ置く", () => {
    mockCanvas([]);
    loadWebFonts(["Noto Sans JP"]);
    loadWebFonts(["Noto Sans JP"]);
    const links = document.head.querySelectorAll("link[data-web-font]");
    expect(links).toHaveLength(1);
  });

  it("端末に入っていれば置かない", () => {
    mockCanvas(["Noto Sans JP"]);
    loadWebFonts(["Noto Sans JP"]);
    expect(document.head.querySelectorAll("link[data-web-font]")).toHaveLength(
      0,
    );
  });
});
