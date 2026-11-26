import { describe, expect, it } from "vitest";
import {
  DESKTOP_SCROLLBARS_ATTRIBUTE,
  DESKTOP_SCROLLBARS_SCRIPT,
  overScrollbar,
  type ScrollBox,
  usesDesktopScrollbars,
} from "@/lib/scrollbar-hover";

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

describe("usesDesktopScrollbars", () => {
  const env = (userAgent: string, extra: Record<string, unknown> = {}) => ({
    navigator: { userAgent, maxTouchPoints: 0, ...extra },
  });

  it("パソコンでは、タッチ操作の判定 (Windows のタブレットモード) でも使う", () => {
    expect(
      usesDesktopScrollbars(
        env("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140", {
          maxTouchPoints: 10,
        }),
      ),
    ).toBe(true);
    expect(
      usesDesktopScrollbars(env("Mozilla/5.0 (Macintosh; Intel Mac OS X)")),
    ).toBe(true);
  });

  it("スマホ・タブレットとスマホアプリでは使わない", () => {
    expect(
      usesDesktopScrollbars(env("Mozilla/5.0 (Linux; Android 15) Chrome/140")),
    ).toBe(false);
    expect(
      usesDesktopScrollbars(env("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)")),
    ).toBe(false);
    // iPadOS の Safari は Mac と名乗る。
    expect(
      usesDesktopScrollbars(
        env("Mozilla/5.0 (Macintosh; Intel Mac OS X)", { maxTouchPoints: 5 }),
      ),
    ).toBe(false);
    expect(
      usesDesktopScrollbars(
        env("Mozilla/5.0 (X11; Linux x86_64)", {
          userAgentData: { mobile: true },
        }),
      ),
    ).toBe(false);
    expect(
      usesDesktopScrollbars({
        ...env("Mozilla/5.0 (X11; Linux x86_64)"),
        Capacitor: { isNativePlatform: () => true },
      }),
    ).toBe(false);
  });

  it("head で動かすスクリプトは、単独で動く", () => {
    const root = {
      attrs: new Set<string>(),
      setAttribute(name: string) {
        this.attrs.add(name);
      },
    };
    new Function("window", "document", DESKTOP_SCROLLBARS_SCRIPT)(
      env("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
      { documentElement: root },
    );
    expect(root.attrs.has(DESKTOP_SCROLLBARS_ATTRIBUTE)).toBe(true);
  });
});
