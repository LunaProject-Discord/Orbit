// リリース用に、デスクトップ版のビルド結果を集める (.github/workflows/desktop.yml から呼ぶ)。
//   node apps/desktop/scripts/release-assets.mjs <書き出し先> <windows|macos|linux>
// - インストーラーを、空白を含まない名前で <書き出し先> へ写す (GitHub Releases は空白を . に変えるため)。
// - 自動更新の署名 (.sig) があるものは、Tauri の updater の一覧の platforms にする分を
//   <書き出し先>/latest-<OS>.json に書く。url はファイル名だけで、配るサーバーが完全な URL にする
//   (apps/api/src/lib/app-releases.ts)。リリースのワークフローが 3 つの OS 分をまとめて latest.json にする。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** ファイル名から、Tauri の updater の platforms のキーを決める。対象外なら []。 */
export function platformKeys(os, file) {
  const arch = /(?:_|-)(?:arm64|aarch64)(?:[_.-]|$)/i.test(file)
    ? "aarch64"
    : "x86_64";
  if (os === "windows") {
    if (file.endsWith("-setup.exe"))
      return [`windows-${arch}-nsis`, `windows-${arch}`];
    if (file.endsWith(".msi")) return [`windows-${arch}-msi`];
  }
  if (os === "macos" && file.endsWith(".app.tar.gz")) {
    // Apple シリコンと Intel の両方で動く 1 つのアプリ (universal) なので、両方に同じものを載せる。
    return [
      "darwin-aarch64",
      "darwin-x86_64",
      "darwin-aarch64-app",
      "darwin-x86_64-app",
    ];
  }
  if (os === "linux") {
    if (file.endsWith(".AppImage"))
      return [`linux-${arch}-appimage`, `linux-${arch}`];
    if (file.endsWith(".deb")) return [`linux-${arch}-deb`];
    if (file.endsWith(".rpm")) return [`linux-${arch}-rpm`];
  }
  return [];
}

const INSTALLERS = [
  ".exe",
  ".msi",
  ".dmg",
  ".app.tar.gz",
  ".AppImage",
  ".deb",
  ".rpm",
];

function walk(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      // .app はフォルダなので中には入らない (配るのは .app.tar.gz)。
      if (!name.endsWith(".app")) walk(path, found);
    } else if (INSTALLERS.some((ext) => name.endsWith(ext))) {
      found.push(path);
    }
  }
  return found;
}

export function safeName(name) {
  return name.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._+-]/g, "_");
}

export function collect(targetDir, out, os) {
  const bundles = walk(targetDir).filter((path) =>
    path.includes(`${join("release", "bundle")}`),
  );
  if (bundles.length === 0)
    throw new Error(`ビルド結果が見つかりません: ${targetDir}`);
  mkdirSync(out, { recursive: true });
  const platforms = {};
  for (const path of bundles) {
    const name = safeName(basename(path));
    copyFileSync(path, join(out, name));
    console.log(`リリースに載せる: ${name}`);
    const sig = `${path}.sig`;
    if (!existsSync(sig)) continue;
    const signature = readFileSync(sig, "utf8").trim();
    for (const key of platformKeys(os, name)) {
      platforms[key] = { url: name, signature };
    }
  }
  writeFileSync(
    join(out, `latest-${os}.json`),
    `${JSON.stringify({ platforms }, null, 2)}\n`,
  );
  return platforms;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [out, os] = process.argv.slice(2);
  if (!out || !["windows", "macos", "linux"].includes(os)) {
    console.error(
      "使い方: node release-assets.mjs <書き出し先> <windows|macos|linux>",
    );
    process.exit(1);
  }
  const target = fileURLToPath(new URL("../src-tauri/target", import.meta.url));
  const platforms = collect(target, out, os);
  console.log(
    `自動更新の対象: ${Object.keys(platforms).join(", ") || "なし (署名の鍵が未登録)"}`,
  );
}
