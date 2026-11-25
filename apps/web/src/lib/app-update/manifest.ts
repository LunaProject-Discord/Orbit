/**
 * 画面の自動更新の一覧 (サーバーの /app-update/manifest.json) の読み取りと署名の確認。
 * 一覧は scripts/app-update-manifest.mjs が作る。しくみは docs/app-update.md。
 */

import appUpdateConfig from "../../../app-update.json";

/** この画面が必要とする、アプリ側 (Tauri / Android) の機能の版。 */
export const MIN_NATIVE_API: number = appUpdateConfig.minNativeApi;

/** この画面の版 (ビルドした日時、UTC の YYYYMMDDHHmmss)。開発中 (next dev) は null。 */
export const BUILD_VERSION: string | null = isBuildVersion(
  process.env.NEXT_PUBLIC_BUILD_VERSION,
)
  ? (process.env.NEXT_PUBLIC_BUILD_VERSION as string)
  : null;

export type ManifestFile = { path: string; sha256: string; size: number };

export type Manifest = {
  version: string;
  builtAt: string;
  minNativeApi: number;
  files: ManifestFile[];
};

/** 一覧の大きさの上限 (ファイルが数千あっても収まる)。 */
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export function isBuildVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d{14}$/.test(value);
}

/** a が b より新しい版か。b が null (開発中) なら更新しない。 */
export function isNewerVersion(a: string, b: string | null): boolean {
  if (!isBuildVersion(a) || !isBuildVersion(b)) return false;
  return a > b;
}

/** 版 (UTC の YYYYMMDDHHmmss) を、その端末の日時で「2026/11/25 11:30」の形にする。 */
export function formatBuildVersion(version: string | null): string | null {
  if (!isBuildVersion(version)) return null;
  const [, y, mo, d, h, mi, s] =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version) ?? [];
  const date = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ),
  );
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * 一覧に載せてよいパスか。アプリ側も同じ確認をするが、ここでも先に弾く。
 * "/" で始まり、"." や ".." の区切りや、バックスラッシュなどを含まないもの。
 */
export function isSafeBundlePath(path: string): boolean {
  if (!path.startsWith("/") || path.length > 512) return false;
  if (!/^[A-Za-z0-9._\-/@+~%()[\]]+$/.test(path)) return false;
  return path
    .slice(1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

function parseManifest(payload: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.format !== 1) return null;
  if (!isBuildVersion(v.version)) return null;
  if (typeof v.builtAt !== "string") return null;
  if (typeof v.minNativeApi !== "number" || !Number.isInteger(v.minNativeApi))
    return null;
  if (!Array.isArray(v.files) || v.files.length === 0) return null;
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const file of v.files) {
    if (typeof file !== "object" || file === null) return null;
    const f = file as Record<string, unknown>;
    if (typeof f.path !== "string" || !isSafeBundlePath(f.path)) return null;
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))
      return null;
    if (typeof f.size !== "number" || !Number.isInteger(f.size) || f.size < 0)
      return null;
    if (seen.has(f.path)) return null;
    seen.add(f.path);
    files.push({ path: f.path, sha256: f.sha256, size: f.size });
  }
  if (!seen.has("/index.html")) return null;
  return {
    version: v.version,
    builtAt: v.builtAt,
    minNativeApi: v.minNativeApi,
    files,
  };
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export type VerifyResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; reason: "invalid" | "signature" | "unsupported" };

/**
 * 一覧の署名を確かめてから中身を返す。publicKey は Ed25519 の公開鍵 (32 バイト) の Base64 で、
 * アプリ側に埋め込まれたもの。署名を確かめられない環境 (WebCrypto の無い WebView) では
 * unsupported を返し、更新しない。
 */
export async function verifyManifest(
  text: string,
  publicKey: string,
): Promise<VerifyResult> {
  if (text.length > MAX_MANIFEST_BYTES) return { ok: false, reason: "invalid" };
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof envelope !== "object" || envelope === null)
    return { ok: false, reason: "invalid" };
  const { payload, signature } = envelope as Record<string, unknown>;
  if (typeof payload !== "string" || typeof signature !== "string")
    return { ok: false, reason: "invalid" };

  const keyBytes = decodeBase64(publicKey);
  const signatureBytes = decodeBase64(signature);
  if (keyBytes?.length !== 32 || signatureBytes?.length !== 64)
    return { ok: false, reason: "signature" };

  // WebCrypto の Ed25519 は、WebView によっては無かったり応答が返らなかったりする (WebKitGTK 2.52 で確認)。
  // どの環境でも同じに動くよう、署名の計算は @noble/ed25519 で行う (SHA-512 だけ WebCrypto を使う)。
  if (!globalThis.crypto?.subtle) return { ok: false, reason: "unsupported" };
  let valid = false;
  try {
    const { verifyAsync } = await import("@noble/ed25519");
    valid = await verifyAsync(
      signatureBytes,
      new TextEncoder().encode(payload),
      keyBytes,
    );
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!valid) return { ok: false, reason: "signature" };

  const manifest = parseManifest(payload);
  return manifest ? { ok: true, manifest } : { ok: false, reason: "invalid" };
}
