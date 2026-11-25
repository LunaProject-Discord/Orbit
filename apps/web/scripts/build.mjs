// Web のビルド。画面の版 (ビルドした日時) を決めて画面に埋め込み、
// 書き出したあとにオフライン用の一覧 (precache-manifest.json) と
// アプリの画面の自動更新用の一覧 (app-update/manifest.json) を作る。
import { spawnSync } from "node:child_process";

/** 画面の版。ビルドした日時 (UTC) を YYYYMMDDHHmmss の形にしたもので、大小で新旧を比べられる。 */
function buildVersion() {
  const given = process.env.BUILD_VERSION?.trim();
  if (given) {
    if (!/^\d{14}$/.test(given)) {
      throw new Error(
        "BUILD_VERSION は YYYYMMDDHHmmss (14 桁の数字) で渡してください。",
      );
    }
    return given;
  }
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

const env = { ...process.env, NEXT_PUBLIC_BUILD_VERSION: buildVersion() };

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("next", ["build"]);
run(process.execPath, ["scripts/precache-manifest.mjs"]);
run(process.execPath, ["scripts/app-update-manifest.mjs"]);
