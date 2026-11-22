import { describe, expect, it } from "vitest";
import {
  PULL_MAX,
  PULL_THRESHOLD,
  pullDistance,
  pullIntent,
  shouldRefresh,
} from "@/lib/pull-to-refresh";

describe("pullIntent", () => {
  it("少ししか動いていない間は決めない", () => {
    expect(pullIntent(2, 5)).toBeNull();
  });

  it("下への動きだけを引っ張りとする", () => {
    expect(pullIntent(3, 20)).toBe(true);
    expect(pullIntent(0, -20)).toBe(false);
  });

  it("横の動き (行のスワイプ) と斜めの動きは引っ張りではない", () => {
    expect(pullIntent(30, 4)).toBe(false);
    expect(pullIntent(20, 22)).toBe(false);
  });
});

describe("pullDistance", () => {
  it("指の動きの半分だけ動く", () => {
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(-30)).toBe(0);
    expect(pullDistance(60)).toBe(30);
  });

  it("しきい値を超えると重くなり、上限は超えない", () => {
    expect(pullDistance(PULL_THRESHOLD * 2)).toBe(PULL_THRESHOLD);
    const far = pullDistance(400);
    expect(far).toBeGreaterThan(PULL_THRESHOLD);
    expect(far).toBeLessThan(PULL_MAX);
    expect(pullDistance(100000)).toBeLessThan(PULL_MAX);
    expect(pullDistance(500)).toBeGreaterThan(far);
  });
});

describe("shouldRefresh", () => {
  it("しきい値まで引っ張って離したら更新する", () => {
    expect(shouldRefresh(PULL_THRESHOLD - 1)).toBe(false);
    expect(shouldRefresh(PULL_THRESHOLD)).toBe(true);
  });
});
