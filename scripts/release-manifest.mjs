// リリースのファイルの一覧を作る (.github/workflows/release.yml から呼ぶ)。
//   node scripts/release-manifest.mjs <リリースのファイルの置き場> <版>
// - デスクトップ版の OS ごとの一覧 (latest-*.json) を 1 つの latest.json にまとめる (署名が 1 つも無ければ作らない)。
// - すべてのファイルの SHA-256 を SHA256SUMS に書く。サーバーは取り込むときにこれで照合する
//   (apps/api/src/cli/fetch-app-release.ts)。
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function buildManifest(dir, version, now = new Date()) {
  const platforms = {};
  for (const name of readdirSync(dir).sort()) {
    if (!/^latest-[a-z]+\.json$/.test(name)) continue;
    const fragment = JSON.parse(readFileSync(join(dir, name), "utf8"));
    Object.assign(platforms, fragment.platforms ?? {});
    rmSync(join(dir, name));
  }
  if (Object.keys(platforms).length > 0) {
    const latest = {
      version,
      pub_date: now.toISOString(),
      notes: `Orbit ${version}`,
      platforms,
    };
    writeFileSync(
      join(dir, "latest.json"),
      `${JSON.stringify(latest, null, 2)}\n`,
    );
  }
  const lines = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "SHA256SUMS" || !statSync(join(dir, name)).isFile()) continue;
    const hash = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
    lines.push(`${hash}  ${name}`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return { platforms: Object.keys(platforms), files: lines.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error("使い方: node scripts/release-manifest.mjs <置き場> <版>");
    process.exit(1);
  }
  const result = buildManifest(dir, version);
  console.log(
    `ファイル ${result.files} 個、デスクトップ版の自動更新の対象: ${result.platforms.join(", ") || "なし"}`,
  );
}
