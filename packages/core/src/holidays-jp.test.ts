import { describe, expect, it } from "vitest";
import { computeHolidays, japaneseHolidays } from "./holidays-jp.js";

describe("日本の祝日", () => {
  it("計算した祝日が、内閣府の一覧 (2022〜2027 年) と一致する", () => {
    for (let year = 2022; year <= 2027; year++) {
      const listed = japaneseHolidays(year, year).map(
        ({ date, name }) => `${date} ${name}`,
      );
      const computed = computeHolidays(year).map(
        ({ date, name }) => `${date} ${name}`,
      );
      expect(computed, String(year)).toEqual(listed);
    }
  });

  it("一覧より後の年は計算で補う", () => {
    const holidays = japaneseHolidays(2028, 2028);
    expect(holidays[0]).toEqual({ date: "2028-01-01", name: "元日" });
    // 2028 年 7 月の第 3 月曜日。
    expect(holidays).toContainEqual({ date: "2028-07-17", name: "海の日" });
  });

  it("振替休日と国民の休日を入れる", () => {
    // 2026 年の敬老の日 (9/21 月) と秋分の日 (9/23 水) の間。
    expect(computeHolidays(2026)).toContainEqual({
      date: "2026-09-22",
      name: "休日",
    });
    // 2026 年 5 月 3 日は日曜日なので、5 月 6 日が振替休日。
    expect(computeHolidays(2026)).toContainEqual({
      date: "2026-05-06",
      name: "休日",
    });
  });
});
