// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { backAction, isNativeApp, toThemeMode } from "./app";

type TestWindow = { Capacitor?: { isNativePlatform: () => boolean } };
const w = window as unknown as TestWindow;

afterEach(() => {
  delete w.Capacitor;
});

describe("isNativeApp", () => {
  it("ブラウザーでは false", () => {
    expect(isNativeApp()).toBe(false);
    w.Capacitor = { isNativePlatform: () => false };
    expect(isNativeApp()).toBe(false);
  });

  it("スマホアプリの中では true", () => {
    w.Capacitor = { isNativePlatform: () => true };
    expect(isNativeApp()).toBe(true);
  });
});

describe("toThemeMode", () => {
  it("ライトとダーク以外はシステムに従う", () => {
    expect(toThemeMode("light")).toBe("light");
    expect(toThemeMode("dark")).toBe("dark");
    expect(toThemeMode("system")).toBe("system");
    expect(toThemeMode(undefined)).toBe("system");
  });
});

describe("backAction", () => {
  it("戻れるなら戻り、戻れなければアプリを裏へ回す", () => {
    expect(backAction(true)).toBe("back");
    expect(backAction(false)).toBe("minimize");
  });
});
