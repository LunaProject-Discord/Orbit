import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BodyPrefetcher,
  HOVER_DELAY_MS,
  SCROLL_SETTLE_MS,
  VISIBLE_DELAY_MS,
} from "./body-prefetch";

function setup() {
  const sent: [string[], string][] = [];
  const prefetcher = new BodyPrefetcher((ids, reason) =>
    sent.push([ids, reason]),
  );
  return { prefetcher, sent };
}

describe("BodyPrefetcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("カーソルが少し止まっていた行だけを頼み、同じメールは 1 回だけ", () => {
    const { prefetcher, sent } = setup();
    prefetcher.hover("a");
    vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    prefetcher.hover("b");
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(sent).toEqual([[["b"], "hover"]]);
    prefetcher.hover(null);
    prefetcher.hover("b");
    vi.advanceTimersByTime(HOVER_DELAY_MS);
    expect(sent).toHaveLength(1);
  });

  it("スクロール中は頼まず、止まってからカーソルの下の行を頼む", () => {
    const { prefetcher, sent } = setup();
    prefetcher.scrolled();
    prefetcher.hover("a");
    vi.advanceTimersByTime(SCROLL_SETTLE_MS - 1);
    prefetcher.scrolled();
    prefetcher.hover("b");
    vi.advanceTimersByTime(SCROLL_SETTLE_MS + HOVER_DELAY_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([[["b"], "hover"]]);
  });

  it("見えている行は、顔ぶれが変わったときだけ上から順にまとめて頼む", () => {
    const { prefetcher, sent } = setup();
    prefetcher.visible(["a", "b"]);
    prefetcher.visible(["a", "b"]);
    vi.advanceTimersByTime(VISIBLE_DELAY_MS);
    expect(sent).toEqual([[["a", "b"], "visible"]]);
    // 一覧を読み直しても、顔ぶれが同じなら頼み直さない。
    prefetcher.visible(["a", "b"]);
    vi.advanceTimersByTime(VISIBLE_DELAY_MS);
    expect(sent).toHaveLength(1);
    // a の本文が入って、残りが b だけになった。
    prefetcher.visible(["b"]);
    vi.advanceTimersByTime(VISIBLE_DELAY_MS);
    expect(sent[1]).toEqual([["b"], "visible"]);
    prefetcher.visible([]);
    vi.advanceTimersByTime(VISIBLE_DELAY_MS);
    expect(sent).toHaveLength(2);
  });

  it("スクロールの途中で通り過ぎた行は頼まない", () => {
    const { prefetcher, sent } = setup();
    prefetcher.scrolled();
    prefetcher.visible(["a", "b"]);
    vi.advanceTimersByTime(100);
    prefetcher.scrolled();
    prefetcher.visible(["c", "d"]);
    vi.advanceTimersByTime(SCROLL_SETTLE_MS + VISIBLE_DELAY_MS);
    expect(sent).toEqual([[["c", "d"], "visible"]]);
  });

  it("片付けたあとは頼まない", () => {
    const { prefetcher, sent } = setup();
    prefetcher.hover("a");
    prefetcher.visible(["a"]);
    prefetcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });
});
