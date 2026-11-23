import { describe, expect, it } from "vitest";
import { isWindowPath } from "./windows";

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
