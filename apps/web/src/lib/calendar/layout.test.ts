import { describe, expect, it } from "vitest";
import { layoutBars, layoutTimed } from "@/lib/calendar/layout";

describe("layoutTimed", () => {
  it("重ならない予定は 1 列", () => {
    const placed = layoutTimed([
      { id: "a", start: 600, end: 660 },
      { id: "b", start: 660, end: 720 },
    ]);
    expect(placed.map((p) => [p.id, p.column, p.columns])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });

  it("重なる予定は列を分け、かたまりごとに列の数を決める", () => {
    const placed = layoutTimed([
      { id: "a", start: 900, end: 960 },
      { id: "b", start: 930, end: 990 },
      { id: "c", start: 960, end: 1020 },
      { id: "d", start: 1080, end: 1140 },
    ]);
    expect(placed.map((p) => [p.id, p.column, p.columns])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 2],
      ["d", 0, 1],
    ]);
  });

  it("長さ 0 の予定も重なりを見る", () => {
    const placed = layoutTimed([
      { id: "a", start: 600, end: 600 },
      { id: "b", start: 610, end: 640 },
    ]);
    expect(placed.map((p) => p.column)).toEqual([0, 1]);
  });
});

describe("layoutBars", () => {
  it("重なる帯は別の段に、空いた段は使い回す", () => {
    const placed = layoutBars([
      { id: "trip", from: 5, to: 6 },
      { id: "holiday", from: 1, to: 1 },
      { id: "week", from: 0, to: 6 },
      { id: "short", from: 2, to: 3 },
    ]);
    expect(Object.fromEntries(placed.map((p) => [p.id, p.lane]))).toEqual({
      week: 0,
      holiday: 1,
      short: 1,
      trip: 1,
    });
  });
});
