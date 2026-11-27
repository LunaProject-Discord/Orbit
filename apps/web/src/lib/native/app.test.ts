// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  backAction,
  isNativeApp,
  runAppBackHandler,
  setAppBackHandler,
  toThemeMode,
} from "./app";

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

describe("setAppBackHandler", () => {
  it("後に登録したものを使い、解除すると前の登録に戻る", () => {
    expect(runAppBackHandler()).toBe(false);
    const calls: string[] = [];
    const removeCalendar = setAppBackHandler(() => {
      calls.push("calendar");
      return true;
    });
    // カレンダーの上で設定を開くと、設定を受け持つメールの画面が登録する。
    const removeSettings = setAppBackHandler(() => {
      calls.push("settings");
      return true;
    });
    expect(runAppBackHandler()).toBe(true);
    // 設定を閉じたら、カレンダーの登録に戻る。
    removeSettings();
    expect(runAppBackHandler()).toBe(true);
    expect(calls).toEqual(["settings", "calendar"]);
    removeCalendar();
    expect(runAppBackHandler()).toBe(false);
  });

  it("先に登録したものを先に解除しても、後の登録は残る", () => {
    const first = setAppBackHandler(() => false);
    const second = setAppBackHandler(() => true);
    first();
    expect(runAppBackHandler()).toBe(true);
    second();
    expect(runAppBackHandler()).toBe(false);
  });
});
