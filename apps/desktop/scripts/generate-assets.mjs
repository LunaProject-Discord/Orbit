// デスクトップ版のアイコンとインストーラーの画像を assets/brand/svg/ から作る。
//   node apps/desktop/scripts/generate-assets.mjs
// 描画には Playwright の Chromium、まとめるのには ImageMagick (convert) と Tauri の CLI (tauri icon) を使う。
// どれもリポジトリの依存には入れていないので、それらが入っている環境で実行し、できたファイルをコミットする。
//
// 作るもの (apps/desktop/src-tauri/ の下):
// - icons/            アプリ本体 (Orbit) のアイコン。tauri icon で作り、.ico だけは小さい版を混ぜて作り直す。
// - icons/apps/       Orbit Mail / Calendar / Contacts のショートカットとウィンドウのアイコン (.ico と .png)。
// - windows/images/   インストーラーの画面に出すロゴ (画面の拡大率ごとの BMP)。
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const brand = here("../../../assets/brand/svg/");
const tauri = here("../src-tauri/");

/** インストーラーの画面の背景 (assets/brand/README.md の暗い背景のタイルの色)。windows/installer.nsi と合わせる。 */
export const SPLASH_BACKGROUND = "#14162A";
/** インストーラーのロゴの幅 (100% の拡大率での px)。windows/installer.nsi と合わせる。 */
const SPLASH_LOGO_WIDTH = 168;
/** ショートカットを置くアプリ (未実装のものも、アイコンだけ先に用意しておく)。 */
const APPS = ["mail", "calendar", "contacts"];

const work = mkdtempSync(join(tmpdir(), "orbit-desktop-assets-"));
const browser = await chromium.launch();
const page = await browser.newPage();

/** SVG を指定の幅の PNG にする。background を渡すと、透明な部分をその色で塗る。 */
async function render(name, width, output, background = "transparent") {
  const svg = readFileSync(join(brand, `${name}.svg`), "utf8");
  await page.setContent(
    `<style>html,body{margin:0;background:${background}}svg{display:block;width:${width}px;height:auto}</style>${svg}`,
  );
  await page
    .locator("svg")
    .screenshot({ path: output, omitBackground: background === "transparent" });
  return output;
}

/** Windows の .ico (16〜256px)。32px 以下は線を太くした小さい版 (-small) を使う。 */
async function ico(name, output) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const source = size <= 32 ? `${name}-small` : name;
    pngs.push(await render(source, size, join(work, `${name}-${size}.png`)));
  }
  execFileSync("convert", [...pngs, output]);
}

try {
  // アプリ本体 (Orbit) のアイコン。tauri icon は 1 枚の画像から全部の大きさを作る。
  const source = await render(
    "orbit-icon",
    1024,
    join(work, "orbit-icon-1024.png"),
  );
  const generated = join(work, "tauri-icons");
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@orbit/desktop",
      "exec",
      "tauri",
      "icon",
      source,
      "-o",
      generated,
    ],
    {
      stdio: "inherit",
    },
  );
  for (const file of [
    "32x32.png",
    "64x64.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.icns",
    "icon.png",
    "Square30x30Logo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square89x89Logo.png",
    "Square107x107Logo.png",
    "Square142x142Logo.png",
    "Square150x150Logo.png",
    "Square284x284Logo.png",
    "Square310x310Logo.png",
    "StoreLogo.png",
  ]) {
    copyFileSync(join(generated, file), join(tauri, "icons", file));
  }
  await ico("orbit-icon", join(tauri, "icons/icon.ico"));

  // 各アプリのショートカットとウィンドウのアイコン。
  mkdirSync(join(tauri, "icons/apps"), { recursive: true });
  for (const app of APPS) {
    await ico(`orbit-${app}-icon`, join(tauri, `icons/apps/orbit-${app}.ico`));
    await render(
      `orbit-${app}-icon`,
      256,
      join(tauri, `icons/apps/orbit-${app}.png`),
    );
  }

  // インストーラーのロゴ。NSIS は BMP しか読めないので、背景を塗った 24 ビットの BMP にする。
  mkdirSync(join(tauri, "windows/images"), { recursive: true });
  for (const scale of [100, 125, 150, 200]) {
    const width = Math.round((SPLASH_LOGO_WIDTH * scale) / 100);
    const png = await render(
      "orbit-logo-dark",
      width,
      join(work, `logo-${scale}.png`),
      SPLASH_BACKGROUND,
    );
    execFileSync("convert", [
      png,
      "-type",
      "TrueColor",
      `BMP3:${join(tauri, `windows/images/logo-${scale}.bmp`)}`,
    ]);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
console.log("デスクトップ版のアイコンとインストーラーの画像を作りました。");
