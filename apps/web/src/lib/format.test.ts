import { describe, expect, it } from "vitest";
import { formatCompactDate } from "./format";

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
      formatCompactDate(at(2026, 10, 22, 21, 44), now, {
        listDate: "auto",
        hour12: true,
      }),
    ).toBe("午後9:44");
  });

  it("日時として読めない値は空文字", () => {
    expect(formatCompactDate("x", now)).toBe("");
  });
});
