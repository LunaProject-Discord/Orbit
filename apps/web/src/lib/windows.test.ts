// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { parseRoute } from "./route";
import { composeWindowPath, isWindowPath, readComposeWindow } from "./windows";

describe("isWindowPath", () => {
  it("アプリの画面のパスだけを開く", () => {
    expect(isWindowPath("/")).toBe(true);
    expect(isWindowPath("/accounts/a/messages/b?q=x")).toBe(true);
    expect(isWindowPath("/compose/new")).toBe(true);
  });

  it("外の URL になりうるものは開かない", () => {
    expect(isWindowPath("https://example.com/")).toBe(false);
    expect(isWindowPath("//example.com/")).toBe(false);
    expect(isWindowPath("/\\example.com")).toBe(false);
    expect(isWindowPath("")).toBe(false);
  });
});

describe("作成専用のウィンドウ", () => {
  afterEach(() => window.sessionStorage.clear());

  it("URL に印を付けても、画面の状態はそのまま読める", () => {
    const path = composeWindowPath("/compose/new");
    expect(path).toBe("/compose/new?window=compose");
    expect(composeWindowPath("/accounts/a/compose/new?q=x", true)).toBe(
      "/accounts/a/compose/new?q=x&window=compose&fresh=1",
    );
    expect(isWindowPath(path)).toBe(true);
    expect(parseRoute(path).composeId).toBe("new");
  });

  it("URL の印を覚えて、読み込み直しても作成専用のままにする", () => {
    const first = readComposeWindow(
      new URLSearchParams("window=compose&fresh=1"),
    );
    expect(first).toEqual({ compose: true, fresh: true });
    // URL が書き換わった後に読み込み直したとき。消すかどうかの印は引き継がない。
    expect(readComposeWindow(new URLSearchParams(""))).toEqual({
      compose: true,
      fresh: false,
    });
  });

  it("印が無ければ普通の画面", () => {
    expect(readComposeWindow(new URLSearchParams("q=x"))).toEqual({
      compose: false,
      fresh: false,
    });
  });
});
