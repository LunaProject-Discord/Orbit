import { describe, expect, it } from "vitest";
import {
  type DateStyle,
  DEFAULT_DATE_FORMATS,
  formatCompactDate,
  formatDateWith,
  formatExactDate,
  formatFullDate,
  formatListDate,
} from "./format";

const style = (formats: Partial<DateStyle> = {}): DateStyle => ({
  listDate: "auto",
  ...DEFAULT_DATE_FORMATS,
  ...formats,
});

describe("formatCompactDate", () => {
  const now = new Date(2026, 10, 22, 23, 0);
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString();

  it("今日なら時刻だけ", () => {
    expect(formatCompactDate(at(2026, 10, 22, 21, 44), now)).toBe("21:44");
  });

  it("今年なら月日と時刻", () => {
    expect(formatCompactDate(at(2026, 0, 5, 9, 3), now)).toBe("1/5 09:03");
  });

  it("去年以前は年月日と時刻", () => {
    expect(formatCompactDate(at(2025, 11, 31, 18, 30), now)).toBe(
      "2025/12/31 18:30",
    );
  });

  it("12 時間制の設定に従う", () => {
    expect(
      formatCompactDate(
        at(2026, 10, 22, 21, 44),
        now,
        style({ shortTimeFormat: "tth:mm" }),
      ),
    ).toBe("午後9:44");
  });

  it("日時として読めない値は空文字", () => {
    expect(formatCompactDate("x", now)).toBe("");
  });
});

describe("formatExactDate", () => {
  const at = (...parts: [number, number, number, number, number, number]) =>
    new Date(...parts).toISOString();

  it("年月日・曜日・秒まで出す", () => {
    expect(formatExactDate(at(2026, 10, 24, 9, 5, 7))).toBe(
      "2026年11月24日(火) 09:05:07",
    );
  });

  it("12 時間制の設定に従う", () => {
    expect(
      formatExactDate(
        at(2026, 10, 24, 21, 44, 30),
        style({ longTimeFormat: "tth:mm:ss" }),
      ),
    ).toBe("2026年11月24日(火) 午後9:44:30");
  });

  it("日時として読めない値は空文字", () => {
    expect(formatExactDate("x")).toBe("");
  });
});

describe("formatDateWith", () => {
  const date = new Date(2026, 0, 5, 0, 7, 3);

  it("Windows と同じ書き方の書式に従う", () => {
    expect(formatDateWith(date, "yyyy/MM/dd")).toBe("2026/01/05");
    expect(formatDateWith(date, "yy/M/d")).toBe("26/1/5");
    expect(formatDateWith(date, "yyyy年M月d日 dddd")).toBe(
      "2026年1月5日 月曜日",
    );
    expect(formatDateWith(date, "MMM d日(ddd)")).toBe("1月 5日(月)");
    expect(formatDateWith(date, "H:mm:ss")).toBe("0:07:03");
    expect(formatDateWith(date, "tt hh:mm")).toBe("午前 12:07");
    expect(formatDateWith(new Date(2026, 0, 5, 13, 0), "tth:m")).toBe(
      "午後1:0",
    );
  });

  it("囲んだ文字と \\ の後ろはそのまま出す", () => {
    expect(formatDateWith(date, "'Today' H\\h")).toBe("Today 0h");
    expect(formatDateWith(date, '"ddd"')).toBe("ddd");
  });
});

describe("書式の設定を一覧・見出しに使う", () => {
  const now = new Date(2026, 10, 24, 12, 0);
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString();
  const custom = style({
    shortDateFormat: "yyyy-MM-dd",
    monthDayFormat: "M月d日",
    longDateFormat: "yyyy年M月d日 dddd",
    shortTimeFormat: "H:mm",
  });

  it("一覧は今日なら短い時刻、今年なら月日、それ以外は短い日付", () => {
    expect(formatListDate(at(2026, 10, 24, 9, 5), now, custom)).toBe("9:05");
    expect(formatListDate(at(2026, 2, 1, 9, 5), now, custom)).toBe("3月1日");
    expect(formatListDate(at(2025, 2, 1, 9, 5), now, custom)).toBe(
      "2025-03-01",
    );
    expect(
      formatListDate(at(2026, 10, 24, 9, 5), now, {
        ...custom,
        listDate: "datetime",
      }),
    ).toBe("11月24日 9:05");
  });

  it("見出しは長い日付と短い時刻", () => {
    expect(formatFullDate(at(2026, 10, 24, 9, 5), custom)).toBe(
      "2026年11月24日 火曜日 9:05",
    );
  });
});
