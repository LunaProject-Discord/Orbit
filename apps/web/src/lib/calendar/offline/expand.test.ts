import { describe, expect, it } from "vitest";
import { expandRange } from "@/lib/calendar/offline/expand";
import { searchLocal } from "@/lib/calendar/offline/search";
import { event } from "@/lib/calendar/offline/test-support";

const RANGE = { from: "2026-03-01", to: "2026-04-01", timeZone: "Asia/Tokyo" };

describe("expandRange (API の GET /events と同じ手順)", () => {
  it("繰り返しを回に展開し、EXDATE と例外と取り消しを反映する", () => {
    const master = event({
      id: "m1",
      rrule: "RRULE:FREQ=WEEKLY;COUNT=5",
      exdates: ["2026-03-16T01:00:00Z"],
    });
    const moved = event({
      id: "x1",
      parentId: "m1",
      recurrenceId: "2026-03-09T01:00:00Z",
      startAt: "2026-03-10T03:00:00.000Z",
      endAt: "2026-03-10T04:00:00.000Z",
      summary: "移動した回",
    });
    const cancelled = event({
      id: "x2",
      parentId: "m1",
      recurrenceId: "2026-03-23T01:00:00Z",
      status: "cancelled",
    });
    const range = expandRange([master, moved, cancelled], RANGE);
    expect(
      range.occurrences.map((o) => [o.eventId, o.recurrenceId, o.startAt]),
    ).toEqual([
      ["m1", "2026-03-02T01:00:00Z", "2026-03-02T01:00:00Z"],
      ["x1", "2026-03-09T01:00:00Z", "2026-03-10T03:00:00Z"],
      ["m1", "2026-03-30T01:00:00Z", "2026-03-30T01:00:00Z"],
    ]);
    expect(range.events.map((e) => e.id).sort()).toEqual(["m1", "x1"]);
  });

  it("単発の予定は範囲にかかるものだけ。取り消した原本は出さない", () => {
    const inside = event({ id: "a" });
    const outside = event({
      id: "b",
      startAt: "2026-05-01T00:00:00.000Z",
      endAt: "2026-05-01T01:00:00.000Z",
    });
    const cancelled = event({ id: "c", status: "cancelled" });
    const allDay = event({
      id: "d",
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-02-28",
      endDate: "2026-03-02",
    });
    const range = expandRange([inside, outside, cancelled, allDay], RANGE);
    expect(range.occurrences.map((o) => o.eventId)).toEqual(["a", "d"]);
    expect(range.occurrences[1]).toMatchObject({
      allDay: true,
      startDate: "2026-02-28",
      endDate: "2026-03-02",
      startAt: null,
      recurrenceId: null,
    });
  });

  it("範囲の前に始まった繰り返しも出る (終日)", () => {
    const yearly = event({
      id: "y",
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2020-03-15",
      endDate: "2020-03-16",
      rrule: "FREQ=YEARLY",
    });
    const range = expandRange([yearly], RANGE);
    expect(range.occurrences).toEqual([
      {
        eventId: "y",
        masterId: "y",
        recurrenceId: "2026-03-15",
        allDay: true,
        startAt: null,
        endAt: null,
        startDate: "2026-03-15",
        endDate: "2026-03-16",
      },
    ]);
  });
});

describe("searchLocal", () => {
  it("題名・場所・メモに全角半角と大小を無視して、すべての語を含むものを新しい順に", () => {
    const a = event({ id: "a", summary: "ＡＢＣ 定例", location: "会議室" });
    const b = event({
      id: "b",
      summary: "abc",
      description: "会議室で",
      startAt: "2026-04-01T00:00:00.000Z",
    });
    const c = event({ id: "c", summary: "abc" });
    expect(searchLocal([a, b, c], "abc 会議室").map((e) => e.id)).toEqual([
      "b",
      "a",
    ]);
    expect(searchLocal([a], "  ")).toEqual([]);
  });
});
