// GitHub Actions でのビルドに重ねる Tauri の設定を作る (.github/workflows/desktop.yml から呼ぶ)。
//   node apps/desktop/scripts/ci-config.mjs <書き出し先>
// 環境変数 (シークレットや変数) の有無に合わせて、次を切り替える。
// - 自動更新: 署名の鍵 (HAS_UPDATER_KEY) と公開鍵 (TAURI_UPDATER_PUBKEY) があれば有効にする。
//   無ければ更新の仕組みを入れない (アプリ側は plugins.updater が無いと更新を確認しない)。
// - Windows の署名: 証明書を取り込んであれば (WINDOWS_CERTIFICATE_THUMBPRINT)、それで署名する。
// - macOS の署名: Apple の証明書が無ければ、その場限りの署名 (ad-hoc) を付ける
//   (署名が全く無いと、Apple シリコンの Mac では起動できない)。
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 環境変数から、重ねる設定を組み立てる。 */
export function buildConfig(env) {
  const config = { bundle: {}, plugins: {} };

  const pubkey = (env.TAURI_UPDATER_PUBKEY ?? "").trim();
  const endpoint = (env.TAURI_UPDATER_ENDPOINT ?? "").trim();
  if (env.HAS_UPDATER_KEY === "true" && pubkey && endpoint) {
    config.bundle.createUpdaterArtifacts = true;
    config.plugins.updater = { pubkey, endpoints: [endpoint] };
  }

  const thumbprint = (env.WINDOWS_CERTIFICATE_THUMBPRINT ?? "").trim();
  if (thumbprint) {
    config.bundle.windows = {
      certificateThumbprint: thumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: "http://timestamp.digicert.com",
    };
  }

  if (env.HAS_APPLE_CERTIFICATE !== "true") {
    config.bundle.macOS = { signingIdentity: "-" };
  }

  return config;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const output = process.argv[2];
  if (!output) {
    console.error("使い方: node ci-config.mjs <書き出し先>");
    process.exit(1);
  }
  const config = buildConfig(process.env);
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    `自動更新: ${config.plugins.updater ? "有効" : "無効"} / Windows の署名: ${
      config.bundle.windows ? "あり" : "なし"
    } / macOS の署名: ${config.bundle.macOS ? "ad-hoc" : "Apple の証明書"}`,
  );
}
