/**
 * アプリ本体の配布用のファイルを GitHub Releases から取り込む (deploy/app-release.sh から呼ぶ)。
 *
 *   node apps/api/dist/cli/fetch-app-release.js <版> <置き場>
 *
 * リリースの SHA256SUMS に載っているファイルをすべて取得し、SHA-256 を照合してから <置き場>/<版>/ に置く。
 * 環境変数:
 *   ORBIT_RELEASES_REPO   取得元のリポジトリ (owner/name)
 *   ORBIT_RELEASES_TOKEN  非公開のリポジトリのときに使う、読み取り用のトークン (任意)
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RELEASE_FILE_NAME, RELEASE_VERSION } from "../lib/app-releases.js";

const [versionArg, dirArg] = process.argv.slice(2);
const version = versionArg?.replace(/^v/, "");
const repo = process.env.ORBIT_RELEASES_REPO?.trim();
const token = process.env.ORBIT_RELEASES_TOKEN?.trim();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!version || !dirArg || !RELEASE_VERSION.test(version)) {
  fail("使い方: fetch-app-release.js <版 (例 1.2.0)> <置き場>");
}
if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  fail("ORBIT_RELEASES_REPO (owner/name) が正しくありません。");
}
const dir = dirArg;

function headers(accept: string): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": "orbit-server",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type Asset = { name: string; url: string; size: number };

async function releaseAssets(): Promise<Asset[]> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/tags/v${encodeURIComponent(version as string)}`,
    { headers: headers("application/vnd.github+json") },
  );
  if (response.status === 404) {
    fail(
      token
        ? `リリース v${version} が見つかりません。`
        : `リリース v${version} が見つかりません (リポジトリが非公開なら、deploy/.env の ORBIT_RELEASES_TOKEN が要ります)。`,
    );
  }
  if (!response.ok) {
    fail(`リリースの情報を取得できませんでした (HTTP ${response.status})。`);
  }
  const body = (await response.json()) as { assets?: unknown };
  if (!Array.isArray(body.assets))
    fail("リリースの情報の形が正しくありません。");
  return body.assets.flatMap((asset) => {
    const a = asset as Record<string, unknown>;
    return typeof a.name === "string" &&
      typeof a.url === "string" &&
      typeof a.size === "number"
      ? [{ name: a.name, url: a.url, size: a.size }]
      : [];
  });
}

/** ファイルを取得して書き出し、SHA-256 を返す。 */
async function download(asset: Asset, path: string): Promise<string> {
  // fetch は別のホストへ転送されるとき Authorization を外すので、トークンは GitHub の外へ渡らない。
  const response = await fetch(asset.url, {
    headers: headers("application/octet-stream"),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    fail(`${asset.name} を取得できませんでした (HTTP ${response.status})。`);
  }
  const hash = createHash("sha256");
  const body = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(path, { mode: 0o644 }));
  return hash.digest("hex");
}

function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(trimmed);
    if (!match?.[1] || !match[2] || !RELEASE_FILE_NAME.test(match[2])) {
      fail(`SHA256SUMS の行を読めません: ${trimmed}`);
    }
    sums.set(match[2], match[1]);
  }
  return sums;
}

async function main() {
  const assets = await releaseAssets();
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const sumsAsset = byName.get("SHA256SUMS");
  if (!sumsAsset) fail(`リリース v${version} に SHA256SUMS がありません。`);

  const target = join(dir, version as string);
  const work = join(dir, `.${version}.partial-${process.pid}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const sumsPath = join(work, "SHA256SUMS");
    await download(sumsAsset, sumsPath);
    const { readFile } = await import("node:fs/promises");
    const sums = parseSums(await readFile(sumsPath, "utf8"));
    for (const [name, expected] of sums) {
      const asset = byName.get(name);
      if (!asset) fail(`リリースに ${name} がありません。`);
      console.log(`取得: ${name} (${Math.round(asset.size / 1024)} KB)`);
      const actual = await download(asset, join(work, name));
      if (actual !== expected) fail(`${name} の SHA-256 が一致しません。`);
    }
    await rm(target, { recursive: true, force: true });
    await rename(work, target);
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
  const info = await stat(target);
  if (info.isDirectory()) console.log(`取り込みました: ${target}`);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
