// .env を用意する。無ければ .env.example から作り、空の秘密の値を乱数で埋める。
// openssl や cp に頼らないので、Windows (PowerShell / cmd) でもそのまま動く。
//
//   pnpm env:init
//
// 既に値が入っている項目は変更しない (鍵を作り直すと保存済みの認証情報を復号できなくなるため)。
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const envPath = fileURLToPath(new URL(".env", root));
const examplePath = fileURLToPath(new URL(".env.example", root));

/** 乱数で埋める項目。どちらも base64 で表した 32 バイト。 */
const SECRET_KEYS = ["BETTER_AUTH_SECRET", "CREDENTIALS_ENCRYPTION_KEY"];

const created = !existsSync(envPath);
let content = readFileSync(created ? examplePath : envPath, "utf8");

const generated = [];
for (const key of SECRET_KEYS) {
  // 改行が CRLF の場合 (Windows で取得した場合) も空とみなす。
  const pattern = new RegExp(`^${key}=[ \\t]*(?=\\r?$)`, "m");
  const secret = randomBytes(32).toString("base64");
  if (pattern.test(content)) {
    content = content.replace(pattern, `${key}=${secret}`);
    generated.push(key);
  } else if (!new RegExp(`^${key}=`, "m").test(content)) {
    content = `${content.replace(/\s*$/, "")}\n${key}=${secret}\n`;
    generated.push(key);
  }
}

if (created || generated.length > 0) {
  writeFileSync(envPath, content);
}
console.log(
  created ? ".env を作成しました。" : ".env は既にあるため、そのまま使います。",
);
console.log(
  generated.length > 0
    ? `生成した値: ${generated.join(", ")}`
    : "秘密の値は設定済みのため、変更していません。",
);
