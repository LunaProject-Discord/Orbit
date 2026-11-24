import { describe, expect, it } from "vitest";
import {
  autoScrollStep,
  bandMode,
  bandRect,
  combineBand,
  rowsInBand,
  sameSelection,
} from "./rubber-band";

const rows = [
  { id: "a", start: 0, end: 80 },
  { id: "b", start: 80, end: 160 },
  { id: "c", start: 160, end: 240 },
  { id: "d", start: 240, end: 320 },
];

describe("bandMode", () => {
  it("押していたキーで選び方が決まる", () => {
    const none = { shiftKey: false, ctrlKey: false, metaKey: false };
    expect(bandMode(none)).toBe("replace");
    expect(bandMode({ ...none, shiftKey: true })).toBe("add");
    expect(bandMode({ ...none, ctrlKey: true })).toBe("toggle");
    expect(bandMode({ ...none, metaKey: true, shiftKey: true })).toBe("toggle");
  });
});

describe("rowsInBand", () => {
  it("範囲に掛かった行を並び順で返す", () => {
    expect(rowsInBand(rows, 100, 170)).toEqual(["b", "c"]);
  });
  it("上へ向かって描いても同じ", () => {
    expect(rowsInBand(rows, 170, 100)).toEqual(["b", "c"]);
  });
  it("端が接しているだけの行は含めない", () => {
    expect(rowsInBand(rows, 80, 160)).toEqual(["b"]);
  });
  it("行の無い余白だけなら空", () => {
    expect(rowsInBand(rows, 400, 500)).toEqual([]);
  });
});

describe("combineBand", () => {
  const base = new Set(["a", "c"]);
  it("replace は掛かった行だけ", () => {
    expect([...combineBand(base, ["b", "c"], "replace")]).toEqual(["b", "c"]);
  });
  it("add は元の選択に加える", () => {
    expect([...combineBand(base, ["b", "c"], "add")].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  it("toggle は掛かった行を反転する", () => {
    expect([...combineBand(base, ["b", "c"], "toggle")].sort()).toEqual([
      "a",
      "b",
    ]);
  });
  it("元の選択は変えない", () => {
    combineBand(base, ["b"], "add");
    expect([...base]).toEqual(["a", "c"]);
  });
});

describe("sameSelection", () => {
  it("中身で比べる", () => {
    expect(sameSelection(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameSelection(new Set(["a"]), new Set(["b"]))).toBe(false);
    expect(sameSelection(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});

describe("autoScrollStep", () => {
  it("端から離れていれば動かさない", () => {
    expect(autoScrollStep(300, 0, 600)).toBe(0);
  });
  it("上の端ではマイナス、下の端ではプラス", () => {
    expect(autoScrollStep(10, 0, 600)).toBeLessThan(0);
    expect(autoScrollStep(590, 0, 600)).toBeGreaterThan(0);
  });
  it("端に近いほど速く、枠の外では最大", () => {
    expect(Math.abs(autoScrollStep(5, 0, 600))).toBeGreaterThan(
      Math.abs(autoScrollStep(30, 0, 600)),
    );
    expect(autoScrollStep(-50, 0, 600, 40, 24)).toBe(-24);
    expect(autoScrollStep(700, 0, 600, 40, 24)).toBe(24);
  });
});

describe("bandRect", () => {
  it("始点と今の点から四角を作る", () => {
    expect(bandRect({ x: 50, y: 200 }, { x: 10, y: 100 })).toEqual({
      left: 10,
      top: 100,
      width: 40,
      height: 100,
    });
  });
});
