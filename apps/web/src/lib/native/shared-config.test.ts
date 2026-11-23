import { describe, expect, it } from "vitest";
import { readSharedConfig } from "./shared-config";

describe("readSharedConfig", () => {
  it("接続先とログインがそろっていれば使う (接続先は URL の形に整える)", () => {
    expect(
      readSharedConfig({
        found: true,
        serverUrl: "https://orbit.example.com/",
        sessionToken: "token.signature",
      }),
    ).toEqual({
      serverUrl: "https://orbit.example.com",
      sessionToken: "token.signature",
    });
  });

  it("見つからない、欠けている、形が違うものは使わない", () => {
    expect(readSharedConfig({ found: false })).toBeNull();
    expect(
      readSharedConfig({
        found: true,
        serverUrl: "https://a.example",
        sessionToken: " ",
      }),
    ).toBeNull();
    expect(
      readSharedConfig({
        found: true,
        serverUrl: "javascript:alert(1)",
        sessionToken: "t",
      }),
    ).toBeNull();
    expect(
      readSharedConfig({ found: true, serverUrl: 1, sessionToken: "t" }),
    ).toBeNull();
  });
});
