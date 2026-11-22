// ビルドした静的ファイル (out/) のうち、オフラインで画面を開くのに必要なものの一覧を作る。
// サービスワーカー (public/sw.js) がこの一覧を読み、端末に保存する。
// フォントは数が多い (文字の範囲ごとに分かれている) ので一覧に入れず、使った分だけ保存させる。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../out", import.meta.url));
const OUTPUT = "precache-manifest.json";
const EXTENSIONS = new Set([
  ".html",
  ".txt",
  ".js",
  ".css",
  ".ico",
  ".json",
  // アイコンと Web アプリの manifest (ホーム画面に追加したアプリや通知で使う)
  ".png",
  ".svg",
  ".webmanifest",
]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const hash = createHash("sha256");
const files = [];
for (const path of walk(out).sort()) {
  const name = `/${relative(out, path).split(sep).join("/")}`;
  if (name === `/${OUTPUT}` || name === "/sw.js") continue;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || !EXTENSIONS.has(name.slice(dot))) continue;
  files.push(name);
  hash.update(name).update(readFileSync(path));
}

const manifest = { version: hash.digest("hex").slice(0, 16), files };
writeFileSync(join(out, OUTPUT), `${JSON.stringify(manifest)}\n`);
console.log(
  `precache-manifest.json: ${files.length} files (${manifest.version})`,
);
