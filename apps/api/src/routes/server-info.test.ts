import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpdatePolicy } from "../lib/update-policy.js";
import { serverInfoRoutes } from "./server-info.js";

const policy: UpdatePolicy = {
  channel: "stable",
  pinnedVersion: "1.2.0",
  serverAutoUpdate: true,
  appUpdate: "auto",
};

describe("サーバー情報とアプリ本体の更新", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "server-info-"));
    await writeFile(join(dir, "CURRENT"), "1.2.0");
    await mkdir(join(dir, "1.2.0"));
    await writeFile(
      join(dir, "1.2.0", "latest.json"),
      JSON.stringify({
        version: "1.2.0",
        platforms: { "linux-x86_64": { url: "a.AppImage", signature: "s" } },
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const app = (overrides: Partial<UpdatePolicy> = {}) =>
    serverInfoRoutes({
      build: { version: "1.2.0", commit: "abc" },
      policy: { ...policy, ...overrides },
      releasesDir: dir,
      publicUrl: "https://orbit.example.com",
    });

  it("版と方針を返す", async () => {
    const response = await app().request("/server-info");
    expect(await response.json()).toEqual({
      name: "orbit",
      version: "1.2.0",
      commit: "abc",
      api: { version: 1, minVersion: 1 },
      updates: {
        channel: "stable",
        pinnedVersion: "1.2.0",
        serverAutoUpdate: true,
        appUpdate: "auto",
      },
    });
  });

  it("デスクトップ版: 古い版からは一覧を返し、同じ版なら 204", async () => {
    const older = await app().request("/app-update/desktop?current=1.1.0");
    expect(older.status).toBe(200);
    expect(await older.json()).toMatchObject({
      version: "1.2.0",
      platforms: {
        "linux-x86_64": {
          url: "https://orbit.example.com/app-update/releases/1.2.0/a.AppImage",
        },
      },
    });
    expect(
      (await app().request("/app-update/desktop?current=1.2.0")).status,
    ).toBe(204);
    // サーバーを古い版に固定しても、新しいアプリを古い版へ戻すことはしない。
    expect(
      (await app().request("/app-update/desktop?current=1.3.0")).status,
    ).toBe(204);
  });

  it("ORBIT_APP_UPDATE=off なら本体は配らない", async () => {
    expect(
      (await app({ appUpdate: "off" }).request("/app-update/desktop")).status,
    ).toBe(204);
  });
});
