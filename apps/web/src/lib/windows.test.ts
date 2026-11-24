// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { parseRoute } from "./route";
import { isWindowPath, readWindowMode, windowModePath } from "./windows";

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

describe("1 つのことだけを出すウィンドウ", () => {
  afterEach(() => window.sessionStorage.clear());

  it("URL に印を付けても、画面の状態はそのまま読める", () => {
    const path = windowModePath("/compose/new", "compose");
    expect(path).toBe("/compose/new?window=compose");
    expect(windowModePath("/accounts/a/compose/new?q=x", "compose", true)).toBe(
      "/accounts/a/compose/new?q=x&window=compose&fresh=1",
    );
    expect(isWindowPath(path)).toBe(true);
    expect(parseRoute(path).composeId).toBe("new");
    const id = "01a20b7a-0000-7000-8000-000000000001";
    expect(
      parseRoute(windowModePath(`/messages/${id}`, "message")).messageId,
    ).toBe(id);
  });

  it("URL の印を覚えて、読み込み直しても同じ種類のままにする", () => {
    expect(
      readWindowMode(new URLSearchParams("window=compose&fresh=1")),
    ).toEqual({ mode: "compose", fresh: true });
    // URL が書き換わった後に読み込み直したとき。消すかどうかの印は引き継がない。
    expect(readWindowMode(new URLSearchParams(""))).toEqual({
      mode: "compose",
      fresh: false,
    });
  });

  it("メールだけのウィンドウ", () => {
    expect(
      readWindowMode(new URLSearchParams("window=message&fresh=1")),
    ).toEqual({ mode: "message", fresh: false });
  });

  it("印が無い、知らない値なら普通の画面", () => {
    expect(readWindowMode(new URLSearchParams("window=other"))).toEqual({
      mode: null,
      fresh: false,
    });
  });
});
