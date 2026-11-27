import { describe, expect, it } from "vitest";
import {
  expandOccurrences,
  normalizeRecurrenceId,
  type RecurrenceException,
} from "./recurrence.js";

const tokyo = { defaultTimeZone: "Asia/Tokyo" };
const week = (from: string, to: string, timeZone = "Asia/Tokyo") => ({
  from,
  to,
  timeZone,
});

describe("expandOccurrences", () => {
  it("繰り返さない予定は範囲にかかれば 1 回", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-12-01T01:00:00Z",
      endAt: "2026-12-01T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: null,
    };
    expect(
      expandOccurrences(event, [], week("2026-12-01", "2026-12-02"), tokyo),
    ).toEqual([
      {
        exception: null,
        recurrenceId: null,
        allDay: false,
        startAt: "2026-12-01T01:00:00Z",
        endAt: "2026-12-01T02:00:00Z",
      },
    ]);
    expect(
      expandOccurrences(event, [], week("2026-12-02", "2026-12-03"), tokyo),
    ).toEqual([]);
  });

  it("夏時間をまたいでも現地の時刻を保つ", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-10-26T13:00:00Z", // 9:00 EDT
      endAt: "2026-10-26T14:00:00Z",
      startTimeZone: "America/New_York",
      rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-10-01", "2026-12-01", "America/New_York"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-10-26T13:00:00Z",
      "2026-11-02T14:00:00Z", // 9:00 EST
      "2026-11-09T14:00:00Z",
    ]);
  });

  it("EXDATE を除き、COUNT は除く前に数える", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-12-01T00:00:00Z",
      endAt: "2026-12-01T01:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: "RRULE:FREQ=DAILY;COUNT=4",
      exdates: ["2026-12-02T09:00:00+09:00"],
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-11-30", "2026-12-10"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-12-01T00:00:00Z",
      "2026-12-03T00:00:00Z",
      "2026-12-04T00:00:00Z",
    ]);
  });

  it("例外は中身を差し替え、取り消した回は出さず、範囲に動かした回は出す", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-12-07T01:00:00Z", // 月曜 10:00 JST
      endAt: "2026-12-07T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: "FREQ=WEEKLY",
    };
    const exceptions: RecurrenceException<string>[] = [
      {
        key: "moved",
        recurrenceId: "2026-12-14T01:00:00.000Z",
        cancelled: false,
        allDay: false,
        startAt: "2026-12-15T05:00:00Z",
        endAt: "2026-12-15T06:00:00Z",
        startTimeZone: "Asia/Tokyo",
      },
      {
        key: "cancelled",
        recurrenceId: "2026-12-21T01:00:00Z",
        cancelled: true,
        allDay: false,
        startAt: "2026-12-21T01:00:00Z",
        endAt: "2026-12-21T02:00:00Z",
        startTimeZone: "Asia/Tokyo",
      },
      {
        // 翌週の回を、この週の金曜へ動かした。
        key: "pulled",
        recurrenceId: "2026-12-28T01:00:00Z",
        cancelled: false,
        allDay: false,
        startAt: "2026-12-25T01:00:00Z",
        endAt: "2026-12-25T02:00:00Z",
        startTimeZone: "Asia/Tokyo",
      },
    ];
    const result = expandOccurrences(
      event,
      exceptions,
      week("2026-12-13", "2026-12-27"),
      tokyo,
    );
    expect(
      result.map((o) => [o.exception, o.recurrenceId, !o.allDay && o.startAt]),
    ).toEqual([
      ["moved", "2026-12-14T01:00:00Z", "2026-12-15T05:00:00Z"],
      ["pulled", "2026-12-28T01:00:00Z", "2026-12-25T01:00:00Z"],
    ]);
  });

  it("範囲の前に始まって範囲にかかる回も出す", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-11-30T14:00:00Z", // 23:00 JST から 3 時間
      endAt: "2026-11-30T17:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: "FREQ=DAILY",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-12-02", "2026-12-03"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-12-01T14:00:00Z",
      "2026-12-02T14:00:00Z",
    ]);
  });

  it("終日の繰り返しは日付で展開する (うるう日は 4 年ごと)", () => {
    const event = {
      allDay: true as const,
      startDate: "2024-02-29",
      endDate: "2024-03-01",
      rrule: "FREQ=YEARLY",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2024-01-01", "2029-01-01"),
      tokyo,
    );
    expect(result).toEqual([
      {
        exception: null,
        recurrenceId: "2024-02-29",
        allDay: true,
        startDate: "2024-02-29",
        endDate: "2024-03-01",
      },
      {
        exception: null,
        recurrenceId: "2028-02-29",
        allDay: true,
        startDate: "2028-02-29",
        endDate: "2028-03-01",
      },
    ]);
  });

  it("終日の UNTIL (日付) は最後の日を含む", () => {
    const event = {
      allDay: true as const,
      startDate: "2026-12-28",
      endDate: "2026-12-29",
      rrule: "FREQ=DAILY;UNTIL=20261230",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-12-01", "2027-01-31"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
    ]);
  });

  it("月の最後の金曜", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-01-30T01:00:00Z",
      endAt: "2026-01-30T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: "FREQ=MONTHLY;BYDAY=-1FR",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-05-01", "2026-08-01"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-05-29T01:00:00Z",
      "2026-06-26T01:00:00Z",
      "2026-07-31T01:00:00Z",
    ]);
  });

  it("RDATE を足す", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-12-01T01:00:00Z",
      endAt: "2026-12-01T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: null,
      rdates: ["2026-12-05T01:00:00Z"],
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-12-01", "2026-12-10"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-12-01T01:00:00Z",
      "2026-12-05T01:00:00Z",
    ]);
  });

  it("浮動時刻は既定のタイムゾーンで展開する", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-12-01T00:00:00Z",
      endAt: "2026-12-01T01:00:00Z",
      startTimeZone: null,
      rrule: "FREQ=DAILY;COUNT=2",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-12-01", "2026-12-05"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual([
      "2026-12-01T00:00:00Z",
      "2026-12-02T00:00:00Z",
    ]);
  });

  it("読めない規則は最初の回だけ出す", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-12-01T00:00:00Z",
      endAt: "2026-12-01T01:00:00Z",
      startTimeZone: "Asia/Tokyo",
      rrule: "FREQ=SOMETIMES",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-12-01", "2026-12-05"),
      tokyo,
    );
    expect(result.map((o) => o.recurrenceId)).toEqual(["2026-12-01T00:00:00Z"]);
  });

  it("上限を超えて作らない", () => {
    const event = {
      allDay: false as const,
      startAt: "2026-01-01T00:00:00Z",
      endAt: "2026-01-01T00:01:00Z",
      startTimeZone: "UTC",
      rrule: "FREQ=MINUTELY",
    };
    const result = expandOccurrences(
      event,
      [],
      week("2026-01-01", "2026-02-01", "UTC"),
      { defaultTimeZone: "UTC", limit: 100 },
    );
    expect(result).toHaveLength(100);
  });
});

describe("normalizeRecurrenceId", () => {
  it("オフセットやミリ秒の違いをそろえる", () => {
    expect(normalizeRecurrenceId("2026-12-01T10:00:00.000+09:00")).toBe(
      "2026-12-01T01:00:00Z",
    );
    expect(normalizeRecurrenceId("2026-12-01")).toBe("2026-12-01");
  });
});
