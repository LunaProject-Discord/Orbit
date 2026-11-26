// リリースの版 (1.2.0、1.3.0-beta.2) から、Android の versionCode を決める (.github/workflows/android.yml から呼ぶ)。
//   node scripts/android-version-code.mjs 1.2.0   → 10200999
// 新しい版ほど大きくなるようにする (Android は小さい番号への入れ替えを許さない)。
//   major × 10,000,000 + minor × 100,000 + patch × 1,000 + (正式版は 999、プレリリースは末尾の数 (0〜998))
import { pathToFileURL } from "node:url";

export function versionCode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(
    version.trim(),
  );
  if (!match) throw new Error(`版の書式が不正です: ${version}`);
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (major > 200 || minor > 99 || patch > 99) {
    throw new Error(
      `versionCode に収まりません (major 200、minor 99、patch 99 まで): ${version}`,
    );
  }
  let suffix = 999;
  if (match[4]) {
    const number = /(\d+)$/.exec(match[4]);
    suffix = Math.min(number ? Number(number[1]) : 0, 998);
  }
  return major * 10_000_000 + minor * 100_000 + patch * 1_000 + suffix;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(versionCode(process.argv[2] ?? ""));
}
