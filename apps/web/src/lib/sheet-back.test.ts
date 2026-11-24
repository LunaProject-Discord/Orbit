import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTopSheet, openSheetCount, registerSheetBack } from "./sheet-back";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe("closeTopSheet", () => {
  it("開いていなければ何もしない", () => {
    expect(closeTopSheet()).toBe(false);
  });

  it("後に開いたシートから閉じる", () => {
    const first = vi.fn();
    const second = vi.fn();
    cleanups.push(registerSheetBack(first, false));
    const removeSecond = registerSheetBack(second, false);
    cleanups.push(removeSecond);
    expect(closeTopSheet()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    removeSecond();
    expect(closeTopSheet()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("閉じたシートは数えない", () => {
    const remove = registerSheetBack(vi.fn(), false);
    expect(openSheetCount()).toBe(1);
    remove();
    remove();
    expect(openSheetCount()).toBe(0);
  });
});

describe("CloseWatcher", () => {
  it("ブラウザーの戻る操作で閉じ、閉じたら見張りをやめる", () => {
    const watchers: { onclose: (() => void) | null; destroy: () => void }[] =
      [];
    vi.stubGlobal(
      "CloseWatcher",
      class {
        onclose: (() => void) | null = null;
        destroy = vi.fn();
        constructor() {
          watchers.push(this);
        }
      },
    );
    const close = vi.fn();
    const remove = registerSheetBack(close);
    expect(watchers).toHaveLength(1);
    watchers[0]?.onclose?.();
    expect(close).toHaveBeenCalledTimes(1);
    remove();
    // 戻る操作で閉じた見張りは、ブラウザーがすでに外している。
    expect(watchers[0]?.destroy).not.toHaveBeenCalled();
    expect(openSheetCount()).toBe(0);
  });

  it("ほかの方法で閉じたら、見張りを外す", () => {
    const destroy = vi.fn();
    vi.stubGlobal(
      "CloseWatcher",
      class {
        onclose = null;
        destroy = destroy;
      },
    );
    const remove = registerSheetBack(vi.fn());
    remove();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
