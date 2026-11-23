// Android アプリのアイコンと起動画面の画像を、assets/brand/ の SVG から作る。
//   pnpm --filter @orbit/mobile icons
// 描画にはヘッドレスブラウザー (Playwright の Chromium) を使う (assets/brand/export-png.mjs と同じ)。
// リポジトリの依存には入れていないので、Playwright が入っている環境で実行する。
// 書き出した画像はコミットしてあるので、ロゴを変えたときだけ実行すればよい。
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const svg = (name) =>
  readFileSync(here(`../../../assets/brand/svg/${name}.svg`), "utf8");
const res = here("../android/app/src/main/res/");

/** 画面の密度ごとの倍率 (mdpi = 1)。 */
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const browser = await chromium.launch();
const page = await browser.newPage();

/**
 * size px の正方形に SVG を描いて保存する。
 * scale は正方形に対する絵の大きさ、round は丸く切り抜くかどうか。
 */
async function render(name, size, output, { scale = 1, round = false } = {}) {
  mkdirSync(output.slice(0, output.lastIndexOf("/")), { recursive: true });
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>
      html,body{margin:0;background:transparent}
      div{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;overflow:hidden;${round ? "border-radius:50%" : ""}}
      svg{display:block;width:${size * scale}px;height:${size * scale}px;flex:none}
    </style><div>${svg(name)}</div>`,
  );
  await page.locator("div").screenshot({ path: output, omitBackground: true });
}

for (const [density, factor] of Object.entries(densities)) {
  const dir = `${res}mipmap-${density}/`;
  // Android 8 以降の adaptive icon の前景 (108dp)。OS が丸や角丸に切り抜くので、
  // 絵が安全領域に収まっている maskable 版を全面に敷く。
  await render(
    "orbit-mail-icon-maskable",
    108 * factor,
    `${dir}ic_launcher_foreground.png`,
  );
  // Android 7 以前のアイコン (48dp)。
  await render("orbit-mail-icon", 48 * factor, `${dir}ic_launcher.png`);
  await render(
    "orbit-mail-icon-maskable",
    48 * factor,
    `${dir}ic_launcher_round.png`,
    { scale: 1.25, round: true },
  );
  // 起動画面の中央に出す記号 (288dp の枠の中央 3 分の 2 に収める)。明るい画面用と暗い画面用。
  await render(
    "orbit-mail-mark",
    288 * factor,
    `${res}drawable-${density}/splash_icon.png`,
    { scale: 0.5 },
  );
  await render(
    "orbit-mail-mark-dark",
    288 * factor,
    `${res}drawable-night-${density}/splash_icon.png`,
    { scale: 0.5 },
  );
}

// Google Play に登録するアイコン (512px、角は Play 側が丸める)。
await render("orbit-mail-icon-square", 512, here("../store/play-icon-512.png"));

await browser.close();
console.log("Android のアイコンと起動画面の画像を書き出しました。");
