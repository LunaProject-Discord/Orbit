// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  desktopPlatform,
  invokeDesktop,
  isDesktopApp,
  listenDesktop,
  toDesktopPlatform,
} from "./app";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as unknown as TauriWindow).__TAURI_INTERNALS__;
  delete document.documentElement.dataset.desktop;
});

describe("isDesktopApp", () => {
  it("ブラウザーでは false", () => {
    expect(isDesktopApp()).toBe(false);
  });

  it("Tauri の中では true", () => {
    (window as unknown as TauriWindow).__TAURI_INTERNALS__ = {};
    expect(isDesktopApp()).toBe(true);
  });
});

describe("desktopPlatform", () => {
  it("html の data-desktop から OS を読む", () => {
    expect(desktopPlatform()).toBeNull();
    document.documentElement.dataset.desktop = "macos";
    expect(desktopPlatform()).toBe("macos");
  });

  it("知らない値は null", () => {
    expect(toDesktopPlatform("windows")).toBe("windows");
    expect(toDesktopPlatform("linux")).toBe("linux");
    expect(toDesktopPlatform("android")).toBeNull();
    expect(toDesktopPlatform(undefined)).toBeNull();
  });
});

describe("ブラウザーでの呼び出し", () => {
  it("コマンドは呼ばずに null を返す", async () => {
    await expect(invokeDesktop("set_unread_count", { count: 1 })).resolves.toBe(
      null,
    );
  });

  it("イベントの登録は何もしない", () => {
    const stop = listenDesktop("desktop://open-message", () => {
      throw new Error("呼ばれないはず");
    });
    expect(() => stop()).not.toThrow();
  });
});
