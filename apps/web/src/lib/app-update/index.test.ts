import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeUpdateInfo, NativeUpdater } from "./native";

const SHA = "b".repeat(64);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");

function manifestText(version: string, minNativeApi = 1) {
  const payload = JSON.stringify({
    format: 1,
    version,
    builtAt: "2026-11-25T00:00:00.000Z",
    minNativeApi,
    files: [{ path: "/index.html", sha256: SHA, size: 1 }],
  });
  return JSON.stringify({
    payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString("base64"),
  });
}

let info: NativeUpdateInfo;
let manifest: string;
const updater = {
  platform: "desktop",
  info: vi.fn(async () => info),
  fetchManifest: vi.fn(async () => manifest),
  download: vi.fn(async ({ version }: { version: string }) => {
    info = { ...info, pending: version };
  }),
  ready: vi.fn(async () => {}),
  apply: vi.fn(async () => {}),
} satisfies NativeUpdater;

vi.mock("./native", () => ({ nativeUpdater: () => updater }));
vi.mock("@/lib/server-url", () => ({
  apiUrl: () => "https://orbit.example.com",
}));

async function load(buildVersion: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_BUILD_VERSION", buildVersion);
  return import("./index");
}

beforeEach(() => {
  info = {
    nativeVersion: "0.1.0",
    nativeApi: 1,
    publicKey: PUBLIC_KEY,
    running: null,
    pending: null,
  };
  for (const fn of Object.values(updater)) {
    if (typeof fn === "function") fn.mockClear();
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkForAppUpdate", () => {
  it("新しい版があれば、変わったファイルの一覧を渡して取得させる", async () => {
    const module = await load("20261124000000");
    manifest = manifestText("20261125000000");
    await module.checkForAppUpdate();
    expect(updater.fetchManifest).toHaveBeenCalledWith(
      "https://orbit.example.com/app-update/manifest.json",
    );
    expect(updater.download).toHaveBeenCalledWith({
      version: "20261125000000",
      baseUrl: "https://orbit.example.com/app-update/files/",
      files: [{ path: "/index.html", sha256: SHA, size: 1 }],
    });
    expect(module.appUpdateState().status).toEqual({
      kind: "ready",
      version: "20261125000000",
    });
  });

  it("いまの画面と同じか古い版なら取得しない", async () => {
    const module = await load("20261125000000");
    manifest = manifestText("20261125000000");
    await module.checkForAppUpdate();
    manifest = manifestText("20261120000000");
    await module.checkForAppUpdate();
    expect(updater.download).not.toHaveBeenCalled();
  });

  it("取得済みの版と同じなら取り直さない", async () => {
    const module = await load("20261124000000");
    info = { ...info, pending: "20261125000000" };
    manifest = manifestText("20261125000000");
    await module.checkForAppUpdate();
    expect(updater.download).not.toHaveBeenCalled();
  });

  it("アプリ本体の機能が足りない版は取得しない", async () => {
    const module = await load("20261124000000");
    manifest = manifestText("20261125000000", 2);
    await module.checkForAppUpdate();
    expect(updater.download).not.toHaveBeenCalled();
    expect(module.appUpdateState().status).toEqual({
      kind: "native-required",
      version: "20261125000000",
    });
  });

  it("公開鍵の無いビルドでは確かめない", async () => {
    const module = await load("20261124000000");
    info = { ...info, publicKey: null };
    await module.checkForAppUpdate();
    expect(updater.fetchManifest).not.toHaveBeenCalled();
    expect(module.appUpdateState().status).toEqual({ kind: "disabled" });
  });

  it("署名が正しくなければ取得しない", async () => {
    const module = await load("20261124000000");
    const other = generateKeyPairSync("ed25519").publicKey;
    info = {
      ...info,
      publicKey: other
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
    };
    manifest = manifestText("20261125000000");
    await module.checkForAppUpdate();
    expect(updater.download).not.toHaveBeenCalled();
  });
});
