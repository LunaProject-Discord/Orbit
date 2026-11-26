import { describe, expect, it } from "vitest";
import {
  compatibility,
  fetchAndroidRelease,
  fetchServerInfo,
  parseServerInfo,
} from "./body";

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

describe("Android の APK の情報", () => {
  const release = {
    version: "1.2.0",
    versionCode: 10200999,
    url: "https://x/app-update/releases/1.2.0/a.apk",
    sha256: "a".repeat(64),
    size: 1,
    mode: "auto",
  };

  it("204 なら新しい版は無い", async () => {
    const fetcher = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await fetchAndroidRelease("https://x", 1, fetcher)).toBeNull();
  });

  it("いまより新しい版だけを返す", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return Response.json(release);
    }) as unknown as typeof fetch;
    expect(await fetchAndroidRelease("https://x", 5, fetcher)).toMatchObject({
      versionCode: 10200999,
      mode: "auto",
    });
    expect(urls[0]).toBe("https://x/v1/app-update/android?versionCode=5");
    expect(
      await fetchAndroidRelease("https://x", 10200999, fetcher),
    ).toBeNull();
  });
});
