import { describe, expect, it } from "vitest";
import { overScrollbar, type ScrollBox } from "@/lib/scrollbar-hover";

/** 左上が (100, 50)、幅 300・高さ 200、枠線 1px の要素。 */
const box = (bars: {
  vertical?: boolean;
  horizontal?: boolean;
}): ScrollBox => ({
  left: 100,
  top: 50,
  clientLeft: 1,
  clientTop: 1,
  clientWidth: 298 - (bars.vertical ? 12 : 0),
  clientHeight: 198 - (bars.horizontal ? 12 : 0),
  offsetWidth: 300,
  offsetHeight: 200,
});

describe("overScrollbar", () => {
  it("縦のスクロールバーの帯に入っているときだけ true を返す", () => {
    const target = box({ vertical: true });
    expect(overScrollbar({ clientX: 386, clientY: 100 }, target)).toBe(false);
    expect(overScrollbar({ clientX: 387, clientY: 100 }, target)).toBe(true);
    expect(overScrollbar({ clientX: 398, clientY: 100 }, target)).toBe(true);
  });

  it("横のスクロールバーの帯に入っているときだけ true を返す", () => {
    const target = box({ horizontal: true });
    expect(overScrollbar({ clientX: 200, clientY: 236 }, target)).toBe(false);
    expect(overScrollbar({ clientX: 200, clientY: 237 }, target)).toBe(true);
  });

  it("スクロールバーが無い要素では、端にいても false を返す", () => {
    const target = box({});
    expect(overScrollbar({ clientX: 399, clientY: 249 }, target)).toBe(false);
  });
});
