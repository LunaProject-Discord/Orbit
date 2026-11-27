import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
  formatTimeRange,
  minutesOnDay,
  shiftDate,
  showsInAllDayRow,
  toLocal,
  viewRange,
  viewTitle,
} from "@/lib/calendar/dates";

const d = (value: string) => Temporal.PlainDate.from(value);
const tz = "Asia/Tokyo";
const occurrence = (fields: Record<string, unknown>) => ({
  eventId: "e",
  masterId: "e",
  recurrenceId: null,
  allDay: false,
  startAt: null,
  endAt: null,
  startDate: null,
  endDate: null,
  ...fields,
});

describe("viewRange", () => {
  it("週は日曜から", () => {
    const { from, to } = viewRange("week", d("2026-11-27"));
    expect([from.toString(), to.toString()]).toEqual([
      "2026-11-22",
      "2026-11-29",
    ]);
  });
  it("月はその月を含む週すべて", () => {
    const nov = viewRange("month", d("2026-11-27"));
    expect([nov.from.toString(), nov.to.toString()]).toEqual([
      "2026-11-01",
      "2026-12-06",
    ]);
    // 2026 年 5 月は金曜始まりで 6 週になる。
    const may = viewRange("month", d("2026-05-10"));
    expect([may.from.toString(), may.to.toString()]).toEqual([
      "2026-04-26",
      "2026-06-07",
    ]);
  });
});

describe("shiftDate", () => {
  it("月は 1 日に移ってから動かす (31 日から 2 月へ行ける)", () => {
    expect(shiftDate("month", d("2027-01-31"), 1).toString()).toBe(
      "2027-02-01",
    );
    expect(shiftDate("3day", d("2026-11-27"), -1).toString()).toBe(
      "2026-11-24",
    );
  });
});

describe("viewTitle", () => {
  it("日本語の見出し", () => {
    expect(viewTitle("week", d("2026-11-27"))).toBe("2026年11月");
    expect(viewTitle("day", d("2026-11-27"))).toBe("2026年11月27日(金)");
  });
});

describe("toLocal と minutesOnDay", () => {
  it("時刻付きの予定を表示するタイムゾーンの時刻にする", () => {
    const local = toLocal(
      occurrence({
        startAt: "2026-11-27T01:00:00Z",
        endAt: "2026-11-27T02:30:00Z",
      }),
      tz,
    );
    if (!local) throw new Error();
    expect(formatTimeRange(local)).toBe("10:00〜11:30");
    expect(minutesOnDay(local, d("2026-11-27"), tz)).toEqual({
      start: 600,
      end: 690,
    });
    expect(minutesOnDay(local, d("2026-11-28"), tz)).toBeNull();
  });

  it("日をまたぐ予定は、それぞれの日に分けてかかる。0 時ちょうどに終われば前の日まで", () => {
    const local = toLocal(
      occurrence({
        startAt: "2026-11-27T13:00:00Z", // 22:00
        endAt: "2026-11-27T15:00:00Z", // 翌 0:00
      }),
      tz,
    );
    if (!local) throw new Error();
    expect(local.lastDay.toString()).toBe("2026-11-27");
    expect(minutesOnDay(local, d("2026-11-27"), tz)).toEqual({
      start: 1320,
      end: 1440,
    });
    expect(minutesOnDay(local, d("2026-11-28"), tz)).toBeNull();
    expect(showsInAllDayRow(local)).toBe(false);
  });

  it("終日の予定は終わりの日を含まない", () => {
    const local = toLocal(
      occurrence({
        allDay: true,
        startDate: "2026-11-27",
        endDate: "2026-11-30",
      }),
      tz,
    );
    if (!local) throw new Error();
    expect([local.firstDay.toString(), local.lastDay.toString()]).toEqual([
      "2026-11-27",
      "2026-11-29",
    ]);
    expect(formatTimeRange(local)).toBe("11月27日〜11月29日");
    expect(showsInAllDayRow(local)).toBe(true);
  });
});
