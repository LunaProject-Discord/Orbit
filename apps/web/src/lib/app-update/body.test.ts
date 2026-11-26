import { describe, expect, it } from "vitest";
import { compatibility, fetchServerInfo, parseServerInfo } from "./body";

const info = {
  name: "orbit",
  version: "1.2.0",
  commit: "abc",
  api: { version: 3, minVersion: 2 },
  updates: {
    channel: "beta",
    pinnedVersion: null,
    serverAutoUpdate: true,
    appUpdate: "auto",
  },
};

describe("サーバーの情報", () => {
  it("読み取り、知らない値は安全な既定にする", () => {
    expect(parseServerInfo(info)).toEqual({
      version: "1.2.0",
      commit: "abc",
      api: { version: 3, minVersion: 2 },
      updates: {
        channel: "beta",
        pinnedVersion: null,
        serverAutoUpdate: true,
        appUpdate: "auto",
      },
    });
    expect(
      parseServerInfo({
        ...info,
        updates: { channel: "x", appUpdate: "always" },
      })?.updates,
    ).toEqual({
      channel: "stable",
      pinnedVersion: null,
      serverAutoUpdate: false,
      appUpdate: "notify",
    });
    expect(parseServerInfo({ name: "mail-api", version: 1 })).toBeNull();
  });

  it("API の版の範囲が重なるかで互換性を判定する", () => {
    expect(
      compatibility({ version: 3, minVersion: 2 }, { min: 1, max: 2 }),
    ).toBe("ok");
    expect(
      compatibility({ version: 3, minVersion: 3 }, { min: 1, max: 2 }),
    ).toBe("client-too-old");
    expect(
      compatibility({ version: 1, minVersion: 1 }, { min: 2, max: 3 }),
    ).toBe("server-too-old");
  });

  it("/v1/server-info の無い古いサーバーでは null", async () => {
    const fetcher = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchServerInfo("https://x", fetcher)).toBeNull();
  });
});
