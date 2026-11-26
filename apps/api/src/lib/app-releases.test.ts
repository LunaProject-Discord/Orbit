import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  currentRelease,
  desktopRelease,
} from "./app-releases.js";
import { loadUpdatePolicy } from "./update-policy.js";

describe("compareVersions", () => {
  it("major.minor.patch を数として比べる", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("v1.2.0", "1.2.1")).toBe(-1);
  });
  it("プレリリースは正式版より古い", () => {
    expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBe(-1);
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.10")).toBe(-1);
    expect(compareVersions("1.2.0-beta.1", "1.1.9")).toBe(1);
  });
  it("ビルドメタデータは無視し、書式が違えば null", () => {
    expect(compareVersions("1.2.0+abc", "1.2.0")).toBe(0);
    expect(compareVersions("latest", "1.2.0")).toBeNull();
  });
});

describe("loadUpdatePolicy", () => {
  it("既定は stable、固定なし、サーバーの自動更新はオフ、アプリは auto", () => {
    expect(loadUpdatePolicy({})).toEqual({
      channel: "stable",
      pinnedVersion: null,
      serverAutoUpdate: false,
      appUpdate: "auto",
    });
  });
  it("値を読み、不正な値は既定に戻す", () => {
    expect(
      loadUpdatePolicy({
        ORBIT_UPDATE_CHANNEL: "Beta",
        ORBIT_UPDATE_VERSION: "v1.2.0",
        ORBIT_SERVER_AUTO_UPDATE: "true",
        ORBIT_APP_UPDATE: "notify",
      }),
    ).toEqual({
      channel: "beta",
      pinnedVersion: "1.2.0",
      serverAutoUpdate: true,
      appUpdate: "notify",
    });
    expect(
      loadUpdatePolicy({
        ORBIT_UPDATE_CHANNEL: "nightly",
        ORBIT_UPDATE_VERSION: "1.2",
        ORBIT_APP_UPDATE: "always",
      }),
    ).toMatchObject({
      channel: "stable",
      pinnedVersion: null,
      appUpdate: "auto",
    });
  });
});

describe("配布するリリースの読み込み", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-releases-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function put(version: string, name: string, value: unknown) {
    await mkdir(join(dir, version), { recursive: true });
    await writeFile(join(dir, version, name), JSON.stringify(value));
  }

  it("CURRENT が無ければ配らない", async () => {
    expect(await currentRelease(dir)).toBeNull();
    expect(await desktopRelease(dir, "https://orbit.example.com")).toBeNull();
  });

  it("デスクトップ版の一覧のファイル名を、配る URL に置き換える", async () => {
    await writeFile(join(dir, "CURRENT"), "1.2.0\n");
    await put("1.2.0", "latest.json", {
      version: "1.2.0",
      platforms: {
        "windows-x86_64-nsis": {
          url: "Orbit-Mail_1.2.0_x64-setup.exe",
          signature: "sig",
        },
      },
    });
    expect(await desktopRelease(dir, "https://orbit.example.com/")).toEqual({
      version: "1.2.0",
      platforms: {
        "windows-x86_64-nsis": {
          url: "https://orbit.example.com/app-update/releases/1.2.0/Orbit-Mail_1.2.0_x64-setup.exe",
          signature: "sig",
        },
      },
    });
  });

  it("版が CURRENT と違う一覧や、パスを含むファイル名は使わない", async () => {
    await writeFile(join(dir, "CURRENT"), "1.2.0");
    await put("1.2.0", "latest.json", { version: "1.1.0", platforms: {} });
    expect(await desktopRelease(dir, "https://x")).toBeNull();
    await put("1.2.0", "latest.json", {
      version: "1.2.0",
      platforms: { "linux-x86_64": { url: "../secret", signature: "s" } },
    });
    expect(await desktopRelease(dir, "https://x")).toBeNull();
  });
});
