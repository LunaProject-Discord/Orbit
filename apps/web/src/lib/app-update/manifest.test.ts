import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatBuildVersion,
  isNewerVersion,
  isSafeBundlePath,
  verifyManifest,
} from "./manifest";

const SHA = "a".repeat(64);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: raw.toString("base64"), privateKey };
}

function envelope(
  payload: unknown,
  privateKey: ReturnType<typeof keyPair>["privateKey"],
) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return JSON.stringify({
    payload: text,
    signature: sign(null, Buffer.from(text), privateKey).toString("base64"),
  });
}

const validPayload = {
  format: 1,
  version: "20261125023000",
  builtAt: "2026-11-25T02:30:00.000Z",
  minNativeApi: 1,
  files: [
    { path: "/index.html", sha256: SHA, size: 10 },
    { path: "/_next/static/chunks/a.js", sha256: SHA, size: 20 },
  ],
};

describe("verifyManifest", () => {
  it("署名が正しければ中身を返す", async () => {
    const { publicKey, privateKey } = keyPair();
    const result = await verifyManifest(
      envelope(validPayload, privateKey),
      publicKey,
    );
    expect(result).toEqual({
      ok: true,
      manifest: {
        version: "20261125023000",
        builtAt: "2026-11-25T02:30:00.000Z",
        minNativeApi: 1,
        files: validPayload.files,
      },
    });
  });

  it("別の鍵で署名されたものは使わない", async () => {
    const { publicKey } = keyPair();
    const other = keyPair();
    const result = await verifyManifest(
      envelope(validPayload, other.privateKey),
      publicKey,
    );
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("署名のあとに書き換えられたものは使わない", async () => {
    const { publicKey, privateKey } = keyPair();
    const signed = JSON.parse(envelope(validPayload, privateKey));
    signed.payload = signed.payload.replace("20261125023000", "20991231000000");
    const result = await verifyManifest(JSON.stringify(signed), publicKey);
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("フォルダの外を指すパスを含むものは使わない", async () => {
    const { publicKey, privateKey } = keyPair();
    const payload = {
      ...validPayload,
      files: [
        ...validPayload.files,
        { path: "/../secret", sha256: SHA, size: 1 },
      ],
    };
    const result = await verifyManifest(
      envelope(payload, privateKey),
      publicKey,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("index.html が無いものや、形の違うものは使わない", async () => {
    const { publicKey, privateKey } = keyPair();
    const noIndex = { ...validPayload, files: [validPayload.files[1]] };
    expect(
      await verifyManifest(envelope(noIndex, privateKey), publicKey),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyManifest("not json", publicKey)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      await verifyManifest(
        envelope({ ...validPayload, version: "1.0" }, privateKey),
        publicKey,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("isSafeBundlePath", () => {
  it("out/ の中のファイルのパスだけを通す", () => {
    expect(isSafeBundlePath("/index.html")).toBe(true);
    expect(isSafeBundlePath("/_next/static/media/a-b.p.woff2")).toBe(true);
    expect(isSafeBundlePath("index.html")).toBe(false);
    expect(isSafeBundlePath("/a/../b")).toBe(false);
    expect(isSafeBundlePath("/a//b")).toBe(false);
    expect(isSafeBundlePath("/a\\b")).toBe(false);
    expect(isSafeBundlePath("/./a")).toBe(false);
  });
});

describe("isNewerVersion", () => {
  it("ビルドした日時で新旧を比べる", () => {
    expect(isNewerVersion("20261125023000", "20261124000000")).toBe(true);
    expect(isNewerVersion("20261124000000", "20261125023000")).toBe(false);
    expect(isNewerVersion("20261125023000", "20261125023000")).toBe(false);
    // 開発中の画面 (版が無い) は更新しない。
    expect(isNewerVersion("20261125023000", null)).toBe(false);
  });
});

describe("formatBuildVersion", () => {
  it("版を日時の形にする", () => {
    expect(formatBuildVersion("20261125023000")).toMatch(/^2026\/11\/25 /);
    expect(formatBuildVersion(null)).toBeNull();
    expect(formatBuildVersion("abc")).toBeNull();
  });
});
