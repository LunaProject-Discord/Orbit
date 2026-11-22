// SVG から PNG と favicon.ico の元になる画像を書き出す。
//   node assets/brand/build.mjs && node assets/brand/export-png.mjs
// 描画にはヘッドレスブラウザー (Playwright の Chromium) を使う。リポジトリの依存には入れていないので、
// Playwright が入っている環境で実行する。favicon.ico は最後に表示するコマンド (ImageMagick) でまとめる。
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const web = here("../../apps/web/");

/** [SVG の名前, 幅 (px), 出力先] */
const jobs = [
  // Web (PWA)
  ["orbit-mail-icon", 192, `${web}public/icons/icon-192.png`],
  ["orbit-mail-icon", 512, `${web}public/icons/icon-512.png`],
  ["orbit-mail-icon-maskable", 192, `${web}public/icons/maskable-192.png`],
  ["orbit-mail-icon-maskable", 512, `${web}public/icons/maskable-512.png`],
  ["orbit-mail-icon-square", 180, `${web}src/app/apple-icon.png`],
  // favicon.ico の元
  ["orbit-mail-icon-small", 16, here("./png/favicon-16.png")],
  ["orbit-mail-icon-small", 32, here("./png/favicon-32.png")],
  ["orbit-mail-icon", 48, here("./png/favicon-48.png")],
  // Desktop (Tauri) / スマホアプリ (Capacitor) 用の素材
  ["orbit-mail-icon", 1024, here("./png/orbit-mail-icon-1024.png")],
  ["orbit-mail-icon-dark", 1024, here("./png/orbit-mail-icon-dark-1024.png")],
  [
    "orbit-mail-icon-square",
    1024,
    here("./png/orbit-mail-icon-square-1024.png"),
  ],
  [
    "orbit-mail-icon-maskable",
    1024,
    here("./png/orbit-mail-icon-maskable-1024.png"),
  ],
  ["orbit-mail-logo", 1200, here("./png/orbit-mail-logo.png")],
  ["orbit-mail-logo-dark", 1200, here("./png/orbit-mail-logo-dark.png")],
];

mkdirSync(here("./png/"), { recursive: true });
mkdirSync(`${web}public/icons/`, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, width, output] of jobs) {
  const svg = readFileSync(here(`./svg/${name}.svg`), "utf8");
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:auto}</style>${svg}`,
  );
  await page.locator("svg").screenshot({ path: output, omitBackground: true });
}
await browser.close();
console.log(
  "PNG を書き出しました。favicon.ico は次のコマンドで作ります:\n  convert assets/brand/png/favicon-16.png assets/brand/png/favicon-32.png assets/brand/png/favicon-48.png apps/web/src/app/favicon.ico",
);
