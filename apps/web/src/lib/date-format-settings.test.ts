import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeDateStyle,
  currentDateStyle,
  legacyDateStyle,
  parseDateStyle,
  refreshDateStyle,
  resetDateStyleForTest,
} from "./date-format-settings";
import { DEFAULT_DATE_STYLE } from "./format";

afterEach(() => resetDateStyleForTest());

describe("parseDateStyle", () => {
  it("形の合わない項目は標準の値にする", () => {
    expect(parseDateStyle(null)).toEqual(DEFAULT_DATE_STYLE);
    expect(
      parseDateStyle({
        listDate: "always",
        shortDateFormat: "  ",
        longDateFormat: "y".repeat(100),
        shortTimeFormat: "H:mm",
      }),
    ).toEqual({
      ...DEFAULT_DATE_STYLE,
      longDateFormat: "y".repeat(64),
      shortTimeFormat: "H:mm",
    });
  });
});

describe("legacyDateStyle", () => {
  it("端末ごとの設定だったころに選んでいた形式を読む", () => {
    expect(
      legacyDateStyle(JSON.stringify({ shortDateFormat: "yyyy-MM-dd" })),
    ).toEqual({ ...DEFAULT_DATE_STYLE, shortDateFormat: "yyyy-MM-dd" });
  });

  it("以前の 12 時間制の設定を時刻の書式に移す", () => {
    const style = legacyDateStyle(JSON.stringify({ hour12: true }));
    expect(style?.shortTimeFormat).toBe("tth:mm");
    expect(style?.longTimeFormat).toBe("tth:mm:ss");
  });

  it("標準のままや読めない値なら null", () => {
    expect(legacyDateStyle(JSON.stringify({ density: "compact" }))).toBeNull();
    expect(legacyDateStyle("壊れた値")).toBeNull();
    expect(legacyDateStyle(null)).toBeNull();
  });
});

describe("サーバーとのやり取り", () => {
  it("サーバーの設定を使う", async () => {
    await refreshDateStyle(async () => ({
      dateFormat: { ...DEFAULT_DATE_STYLE, shortTimeFormat: "H:mm" },
    }));
    expect(currentDateStyle().shortTimeFormat).toBe("H:mm");
  });

  it("サーバーに無ければ標準の値", async () => {
    await refreshDateStyle(async () => ({ dateFormat: null }));
    expect(currentDateStyle()).toEqual(DEFAULT_DATE_STYLE);
  });

  it("変えた設定を保存し、失敗したら元に戻す", async () => {
    const save = vi.fn(async () => {});
    expect(await changeDateStyle({ listDate: "datetime" }, save)).toBe(true);
    expect(save).toHaveBeenCalledWith({
      ...DEFAULT_DATE_STYLE,
      listDate: "datetime",
    });
    expect(
      await changeDateStyle({ listDate: "auto" }, async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
    expect(currentDateStyle().listDate).toBe("datetime");
  });
});
