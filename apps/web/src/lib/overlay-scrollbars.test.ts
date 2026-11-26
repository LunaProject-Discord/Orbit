import { describe, expect, it } from "vitest";
import { snapToPixel, thumbMetrics } from "@/lib/overlay-scrollbars";

describe("thumbMetrics", () => {
  it("中身が収まっていれば null を返す", () => {
    expect(thumbMetrics(400, 400, 0, 396)).toBeNull();
    expect(thumbMetrics(400, 300, 0, 396)).toBeNull();
    expect(thumbMetrics(0, 300, 0, 0)).toBeNull();
  });

  it("見えている割合に合わせた長さと、スクロール位置に合わせた場所を返す", () => {
    // 見えているのは 4 分の 1。バーは 400px。
    expect(thumbMetrics(400, 1600, 0, 400)).toEqual({
      size: 100,
      start: 0,
      ratio: 4,
    });
    expect(thumbMetrics(400, 1600, 600, 400)?.start).toBe(150);
    expect(thumbMetrics(400, 1600, 1200, 400)?.start).toBe(300);
  });

  it("中身がとても長くても、つまみは最小の長さを保つ", () => {
    const metrics = thumbMetrics(400, 40000, 39600, 400);
    expect(metrics?.size).toBe(36);
    expect(metrics?.start).toBe(364);
    // つまみを端から端まで動かすと、中身も端から端まで動く。
    expect((metrics?.ratio ?? 0) * 364).toBeCloseTo(39600);
  });

  it("行き過ぎたスクロール位置は、端に丸める", () => {
    expect(thumbMetrics(400, 1600, -50, 400)?.start).toBe(0);
    expect(thumbMetrics(400, 1600, 5000, 400)?.start).toBe(300);
  });
});

describe("snapToPixel", () => {
  it("画面の画素の境目に合わせる", () => {
    expect(snapToPixel(10.3, 1)).toBe(10);
    // 125% では 0.8px ごと。
    expect(snapToPixel(10.3, 1.25)).toBeCloseTo(10.4);
    expect(snapToPixel(6, 1.25)).toBeCloseTo(6.4);
    expect(snapToPixel(7.1, 2)).toBe(7);
  });
});
