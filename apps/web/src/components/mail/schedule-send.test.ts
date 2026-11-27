import { describe, expect, it } from "vitest";
import {
  combineDateTime,
  schedulePresets,
  scheduleProblem,
} from "@/components/mail/schedule-send";

describe("schedulePresets", () => {
  it("明日の朝・午後と、次の月曜日の朝を出す", () => {
    // 2026-11-27 は金曜日。
    const presets = schedulePresets(new Date(2026, 10, 27, 15, 30));
    expect(presets.map((preset) => preset.label)).toEqual([
      "明日の朝",
      "明日の午後",
      "月曜日の朝",
    ]);
    expect(presets[0]?.at).toEqual(new Date(2026, 10, 28, 8, 0));
    expect(presets[1]?.at).toEqual(new Date(2026, 10, 28, 13, 0));
    expect(presets[2]?.at).toEqual(new Date(2026, 10, 30, 8, 0));
  });

  it("明日が月曜日なら、月曜日の朝は出さない", () => {
    const presets = schedulePresets(new Date(2026, 10, 29, 10, 0));
    expect(presets.map((preset) => preset.label)).toEqual([
      "明日の朝",
      "明日の午後",
    ]);
  });

  it("月曜日には、翌週の月曜日を出す", () => {
    const presets = schedulePresets(new Date(2026, 10, 30, 10, 0));
    expect(presets[2]?.at).toEqual(new Date(2026, 11, 7, 8, 0));
  });
});

describe("日時の入力", () => {
  it("日付と時刻を合わせる", () => {
    expect(combineDateTime("2026-12-01", "09:30")).toEqual(
      new Date(2026, 11, 1, 9, 30),
    );
    expect(combineDateTime("", "09:30")).toBeNull();
    expect(combineDateTime("2026-12-01", "")).toBeNull();
  });

  it("過ぎた日時と 1 年より先は予約できない", () => {
    const now = new Date(2026, 10, 27, 12, 0).getTime();
    expect(scheduleProblem(new Date(2026, 10, 27, 11, 0), now)).not.toBeNull();
    expect(scheduleProblem(new Date(2026, 10, 28, 8, 0), now)).toBeNull();
    expect(scheduleProblem(new Date(2028, 0, 1), now)).toBe(
      "予約できるのは 1 年先までです。",
    );
    expect(scheduleProblem(null, now)).not.toBeNull();
  });
});
