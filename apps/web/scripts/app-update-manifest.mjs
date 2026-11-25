// アプリ (デスクトップ版、スマホアプリ) の画面の自動更新に使う一覧を作る。
// out/ のすべてのファイルの SHA-256 を並べ、秘密鍵 (APP_UPDATE_SIGNING_KEY) で署名して
// out/app-update/manifest.json に書き出す。アプリはこれを取得し、署名を確かめてから
// 変わったファイルだけを取得する。しくみは docs/app-update.md。
//
// APP_UPDATE_SIGNING_KEY は Ed25519 の秘密鍵 (PKCS#8 の DER を Base64 にしたもの)。
// 無ければ一覧を作らない (アプリは画面を更新せず、同梱の画面を使い続ける)。
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../out", import.meta.url));
const DIR = "app-update";
const { minNativeApi } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../app-update.json", import.meta.url)),
    "utf8",
  ),
);

const version = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "";
if (!/^\d{14}$/.test(version)) {
  throw new Error(
    "NEXT_PUBLIC_BUILD_VERSION がありません (scripts/build.mjs から実行してください)。",
  );
}

const keyText = process.env.APP_UPDATE_SIGNING_KEY?.trim();
if (!keyText) {
  console.log(
    "app-update/manifest.json: APP_UPDATE_SIGNING_KEY が無いので作りません。",
  );
  process.exit(0);
}
const key = createPrivateKey({
  key: Buffer.from(keyText, "base64"),
  format: "der",
  type: "pkcs8",
});
if (key.asymmetricKeyType !== "ed25519") {
  throw new Error("APP_UPDATE_SIGNING_KEY は Ed25519 の秘密鍵にしてください。");
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = [];
for (const path of walk(out).sort()) {
  const name = `/${relative(out, path).split(sep).join("/")}`;
  if (name.startsWith(`/${DIR}/`)) continue;
  const content = readFileSync(path);
  files.push({
    path: name,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  });
}

const payload = JSON.stringify({
  format: 1,
  version,
  builtAt: new Date().toISOString(),
  minNativeApi,
  files,
});
const signature = sign(null, Buffer.from(payload, "utf8"), key).toString(
  "base64",
);

mkdirSync(join(out, DIR), { recursive: true });
writeFileSync(
  join(out, DIR, "manifest.json"),
  `${JSON.stringify({ payload, signature })}\n`,
);
console.log(`app-update/manifest.json: ${files.length} files (${version})`);
