import { describe, expect, it } from "vitest";
import {
  canvasPixelRatio,
  clampZoom,
  currentPageIndex,
  MAX_CANVAS_PIXELS,
  pdfErrorKind,
  pdfErrorMessage,
  pdfPreviewMethod,
  stepZoom,
} from "@/lib/pdf-preview";

describe("pdfPreviewMethod", () => {
  it("スマホアプリの中では、ビューアの有無にかかわらず pdf.js で描く", () => {
    expect(pdfPreviewMethod({ pdfViewerEnabled: true, nativeApp: true })).toBe(
      "pdfjs",
    );
    expect(
      pdfPreviewMethod({ pdfViewerEnabled: undefined, nativeApp: true }),
    ).toBe("pdfjs");
  });

  it("ブラウザーにビューアが無いと分かるときだけ pdf.js、それ以外は iframe", () => {
    expect(
      pdfPreviewMethod({ pdfViewerEnabled: false, nativeApp: false }),
    ).toBe("pdfjs");
    expect(pdfPreviewMethod({ pdfViewerEnabled: true, nativeApp: false })).toBe(
      "iframe",
    );
    expect(
      pdfPreviewMethod({ pdfViewerEnabled: undefined, nativeApp: false }),
    ).toBe("iframe");
  });
});

describe("拡大率", () => {
  it("範囲に収める", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(1.7)).toBe(1.7);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("ボタンでは段階ごとに進み、半端な値からは次の段階へ", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });
});

describe("canvasPixelRatio", () => {
  it("小さいページは端末の解像度のまま描く", () => {
    expect(canvasPixelRatio(360, 509, 3)).toBe(3);
  });

  it("canvas の面積が上限を超えるときは下げる", () => {
    const ratio = canvasPixelRatio(1440, 2036, 3);
    expect(ratio).toBeLessThan(3);
    expect(1440 * ratio * 2036 * ratio).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS + 1,
    );
  });

  it("解像度が分からなければ 1 として扱う", () => {
    expect(canvasPixelRatio(100, 100, Number.NaN)).toBe(1);
    expect(canvasPixelRatio(0, 0, 2)).toBe(2);
  });
});

describe("pdfErrorKind", () => {
  it("パスワード付き、壊れたファイル、読み込めなかったスクリプトを見分ける", () => {
    expect(pdfErrorKind({ name: "PasswordException" })).toBe("password");
    expect(pdfErrorKind({ name: "InvalidPDFException" })).toBe("invalid");
    expect(pdfErrorKind(new Error("something"))).toBe("invalid");
    expect(
      pdfErrorKind(
        new TypeError("Failed to fetch dynamically imported module"),
      ),
    ).toBe("unavailable");
    expect(pdfErrorKind(new Error('Setting up fake worker failed: "x".'))).toBe(
      "unavailable",
    );
    expect(pdfErrorKind(null)).toBe("invalid");
  });

  it("どの場合も、保存か別のアプリで開くことを案内する", () => {
    for (const kind of ["password", "invalid", "unavailable"] as const) {
      expect(pdfErrorMessage(kind)).toMatch(/保存/);
    }
  });
});

describe("currentPageIndex", () => {
  it("表示領域の上から 4 割の線にかかっているページ", () => {
    // 高さ 1000 の表示領域。線は 400。
    expect(currentPageIndex([500, 1100, 1700], 1000)).toBe(1);
    expect(currentPageIndex([-200, 390, 1000], 1000)).toBe(3);
    expect(currentPageIndex([-200, 410, 1000], 1000)).toBe(2);
    expect(currentPageIndex([-900, -300, 100], 1000)).toBe(3);
    expect(currentPageIndex([], 1000)).toBe(0);
  });
});
