/**
 * アプリ本体の配布 (docs/updates.md)。deploy/app-releases/ (コンテナでは APP_RELEASES_DIR) に
 * リリースのファイルを版ごとに置き、CURRENT に書いた版を配る。
 *
 *   app-releases/
 *     CURRENT                 配る版 (例 "1.2.0")
 *     1.2.0/
 *       SHA256SUMS            ファイルの SHA-256 (リリースのワークフローが作る)
 *       latest.json           デスクトップ版の更新の一覧 (Tauri の updater の静的な形。url はファイル名だけ)
 *       android.json          Android の APK の情報
 *       Orbit-Mail_1.2.0_x64-setup.exe など
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** 版の書式 (semver の major.minor.patch と、任意の -プレリリース)。 */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** リリースに含めるファイルの名前。パスの区切りや先頭のドットは許さない。 */
export const RELEASE_FILE_NAME = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,199}$/;

const desktopPlatform = z.object({
  url: z.string().regex(RELEASE_FILE_NAME),
  signature: z.string().min(1).max(10_000),
});

const desktopManifest = z.object({
  version: z.string().regex(RELEASE_VERSION),
  notes: z.string().max(100_000).optional(),
  pub_date: z.string().max(100).optional(),
  platforms: z.record(z.string().regex(/^[a-z0-9_-]{1,64}$/), desktopPlatform),
});

const androidManifest = z.object({
  version: z.string().regex(RELEASE_VERSION),
  versionCode: z.number().int().positive(),
  file: z.string().regex(RELEASE_FILE_NAME),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});

export type DesktopManifest = z.infer<typeof desktopManifest>;
export type AndroidManifest = z.infer<typeof androidManifest>;

/** 配る版 (CURRENT)。無い、または書式が違えば null。 */
export async function currentRelease(dir: string): Promise<string | null> {
  try {
    const version = (await readFile(join(dir, "CURRENT"), "utf8")).trim();
    return RELEASE_VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function readJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    console.warn(`[アプリの配布] ${path} の形が正しくありません。`);
  } catch {
    console.warn(`[アプリの配布] ${path} を JSON として読めません。`);
  }
  return null;
}

/** ファイルを配る URL。 */
export function releaseFileUrl(
  publicUrl: string,
  version: string,
  file: string,
): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/app-update/releases/${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

/**
 * デスクトップ版の更新の一覧。Tauri の updater がそのまま読める形 (url を完全な URL にしたもの) にする。
 */
export async function desktopRelease(
  dir: string,
  publicUrl: string,
): Promise<DesktopManifest | null> {
  const version = await currentRelease(dir);
  if (!version) return null;
  const manifest = await readJson(
    join(dir, version, "latest.json"),
    desktopManifest,
  );
  if (!manifest || manifest.version !== version) return null;
  const platforms: DesktopManifest["platforms"] = {};
  for (const [key, platform] of Object.entries(manifest.platforms)) {
    platforms[key] = {
      signature: platform.signature,
      url: releaseFileUrl(publicUrl, version, platform.url),
    };
  }
  return { ...manifest, platforms };
}

export type AndroidRelease = AndroidManifest & { url: string };

export async function androidRelease(
  dir: string,
  publicUrl: string,
): Promise<AndroidRelease | null> {
  const version = await currentRelease(dir);
  if (!version) return null;
  const manifest = await readJson(
    join(dir, version, "android.json"),
    androidManifest,
  );
  if (!manifest || manifest.version !== version) return null;
  return {
    ...manifest,
    url: releaseFileUrl(publicUrl, version, manifest.file),
  };
}

/**
 * semver の比較 (ビルドメタデータ + は無視)。a が新しければ正、古ければ負、同じなら 0。
 * 書式が違うものは比べられないので null。
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match =
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        value.trim(),
      );
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ? match[4].split(".") : [],
    };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  // プレリリースの無いほうが新しい。
  if (x.pre.length === 0 || y.pre.length === 0) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < length; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return Math.sign(d);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
