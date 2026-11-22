// Orbit のアイコンとロゴの SVG を作る (依存パッケージなし)。
//   node assets/brand/build.mjs
// 形の決まり:
//   - 輪 (軌道) の右下に、Luna Project の三日月 (黄色 #ffc636) が衛星として乗る。
//   - 輪の中のモチーフと色が製品ごとに変わる (Mail = 封筒の折り目、青紫)。
//   - ロゴの文字は LINE Seed (Luna Project のロゴと同じ書体) をパスにしたもの。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const MOON = readFileSync(here("./data/luna-moon-path.txt"), "utf8").trim();
const WORDMARK = JSON.parse(readFileSync(here("./data/wordmark.json"), "utf8"));

export const MOON_YELLOW = "#ffc636";
export const DARK_TILE = "#14162A";
/** from → to がタイルと明るい背景用の輪のグラデーション、tint → to が暗い背景用。 */
export const PRODUCTS = {
  orbit: {
    name: "",
    from: "#2B2F45",
    to: "#12141F",
    tint: "#FFFFFF",
    tintTo: "#C9CEE8",
  },
  mail: {
    name: "Mail",
    from: "#5B5BF0",
    to: "#8B5CF6",
    tint: "#A5A8FF",
    tintTo: "#8B5CF6",
  },
  calendar: {
    name: "Calendar",
    from: "#F9603A",
    to: "#F43F7A",
    tint: "#FF9A7A",
    tintTo: "#F43F7A",
  },
  contacts: {
    name: "Contacts",
    from: "#0FA58F",
    to: "#22B8CF",
    tint: "#5FE0CC",
    tintTo: "#22B8CF",
  },
};

const round = (n) => Math.round(n * 100) / 100;
const polar = (r, deg) => [
  round(256 + r * Math.cos((deg * Math.PI) / 180)),
  round(256 + r * Math.sin((deg * Math.PI) / 180)),
];

/**
 * 512 × 512 の枠に描いた記号 (輪 + モチーフ + 月)。
 * small は 32px 以下で使う版で、線を太く、月を大きくする。
 */
function glyph(product, fg, { small = false } = {}) {
  const r = 150;
  const sw = small ? 54 : 44;
  let inner = "";
  if (product === "mail") {
    const [lx, ly] = polar(r - 6, 207);
    const [rx, ry] = polar(r - 6, -27);
    inner = `<path d="M${lx} ${ly}L256 282L${rx} ${ry}" fill="none" stroke="${fg}" stroke-width="${sw - 6}" stroke-linejoin="round"/>`;
  } else if (product === "calendar") {
    const dots = [
      [-52, 6, 1],
      [0, 6, 1],
      [52, 6, 1],
      [-52, 58, 1],
      [0, 58, 0.45],
    ]
      .map(
        ([x, y, o]) =>
          `<circle cx="${256 + x}" cy="${256 + y}" r="17" fill="${fg}"${o < 1 ? ` opacity="${o}"` : ""}/>`,
      )
      .join("");
    inner = `<path d="M116 204H396" stroke="${fg}" stroke-width="34" clip-path="url(#inside)"/>${dots}`;
  } else if (product === "contacts") {
    inner = `<circle cx="256" cy="222" r="46" fill="${fg}"/><path d="M160 386a96 84 0 0 1 192 0z" fill="${fg}" clip-path="url(#inside)"/>`;
  }
  const scale = small ? 0.56 : 0.46;
  const [mx, my] = polar(r + 8, 42);
  const defs = `<clipPath id="inside"><circle cx="256" cy="256" r="${r - 4}"/></clipPath><mask id="moon-gap"><rect width="512" height="512" fill="#fff"/><circle cx="${mx}" cy="${my}" r="${small ? 90 : 74}" fill="#000"/></mask>`;
  const body = `<g mask="url(#moon-gap)">${inner}<circle cx="256" cy="256" r="${r}" fill="none" stroke="${fg}" stroke-width="${sw}"/></g><path transform="translate(${round(mx - 118 * scale)} ${round(my - 128 * scale)}) scale(${scale})" d="${MOON}" fill="${MOON_YELLOW}"/>`;
  return { defs, body };
}

const gradient = (id, from, to) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;

/**
 * アイコン。shape: rounded (角丸、角は透明) / square (四角いっぱい。OS が切り抜く用)。
 * 輪の中心を枠の中心に置く (月は輪から少しはみ出すが、輪を基準にしないと左に寄って見える)。
 * scale は記号の大きさ (1 = 枠いっぱいに近い)。maskable は安全領域に収まる 0.66。
 */
export function icon(
  product,
  { theme = "light", shape = "rounded", scale = 0.88, small = false } = {},
) {
  const p = PRODUCTS[product];
  const dark = theme === "dark";
  const g = glyph(product, dark ? "url(#ink)" : "#fff", { small });
  const tile = `<rect width="512" height="512"${shape === "rounded" ? ' rx="116"' : ""} fill="${dark ? DARK_TILE : "url(#tile)"}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>${gradient("tile", p.from, p.to)}${gradient("ink", p.tint, p.tintTo)}${g.defs}</defs>${tile}<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${g.body}</g></svg>\n`;
}

/** 背景のない記号だけ。theme は置く背景の明暗。 */
export function mark(product, { theme = "light" } = {}) {
  const p = PRODUCTS[product];
  const dark = theme === "dark";
  const g = glyph(product, "url(#ink)");
  // 月が右下にはみ出す分を含めて切り出す。
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 400 400"><defs>${dark ? gradient("ink", p.tint, p.tintTo) : gradient("ink", p.from, p.to)}${g.defs}</defs>${g.body}</svg>\n`;
}

/** 横組みロゴ (記号 + 「Orbit」+ 製品名)。高さ 120。 */
export function logo(product, { theme = "light" } = {}) {
  const p = PRODUCTS[product];
  const dark = theme === "dark";
  const g = glyph(product, "url(#ink)");
  const text = dark ? "#fff" : "#000";
  const size = 0.62; // 文字の大きさ (100 単位のパスに掛ける)
  const x0 = 136;
  const baseline = 60 + (WORDMARK.capHeight * size) / 2;
  const orbit = `<path transform="translate(${x0} ${round(baseline)}) scale(${size})" d="${WORDMARK.Orbit.d}" fill="${text}"/>`;
  let width = x0 + WORDMARK.Orbit.width * size;
  let name = "";
  if (p.name) {
    const x = width + 17;
    name = `<path transform="translate(${round(x)} ${round(baseline)}) scale(${size})" d="${WORDMARK[p.name].d}" fill="${text}" opacity=".7"/>`;
    width = x + WORDMARK[p.name].width * size;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width + 8)} 120"><defs>${dark ? gradient("ink", p.tint, p.tintTo) : gradient("ink", p.from, p.to)}${g.defs}</defs><g transform="translate(4 4) scale(0.28) translate(-64 -64)">${g.body}</g>${orbit}${name}</svg>\n`;
}

if (process.argv[1] === here("./build.mjs")) {
  const out = here("./svg/");
  mkdirSync(out, { recursive: true });
  const write = (name, svg) => writeFileSync(`${out}${name}.svg`, svg);
  for (const product of Object.keys(PRODUCTS)) {
    const base = product === "orbit" ? "orbit" : `orbit-${product}`;
    for (const theme of ["light", "dark"]) {
      const suffix = theme === "dark" ? "-dark" : "";
      write(`${base}-mark${suffix}`, mark(product, { theme }));
      write(`${base}-logo${suffix}`, logo(product, { theme }));
      write(`${base}-icon${suffix}`, icon(product, { theme }));
    }
    write(
      `${base}-icon-square`,
      icon(product, { shape: "square", scale: 0.84 }),
    );
    write(
      `${base}-icon-maskable`,
      icon(product, { shape: "square", scale: 0.66 }),
    );
    write(`${base}-icon-small`, icon(product, { small: true, scale: 0.9 }));
  }
  // Web の画面に直接描くための形のデータ (components/brand/orbit-logo.tsx が使う)。
  const data = [
    "// assets/brand/build.mjs が作るファイル。手で書き換えない。",
    `export const MOON_PATH =\n  ${JSON.stringify(MOON)};`,
    `export const WORDMARK_ORBIT = {\n  d: ${JSON.stringify(WORDMARK.Orbit.d)},\n  width: ${WORDMARK.Orbit.width},\n};`,
    `export const WORDMARK_MAIL = {\n  d: ${JSON.stringify(WORDMARK.Mail.d)},\n  width: ${WORDMARK.Mail.width},\n};`,
  ];
  writeFileSync(
    here("../../apps/web/src/components/brand/brand-data.ts"),
    `${data.join("\n")}\n`,
  );
  console.log(`wrote SVG files to ${out}`);
}
