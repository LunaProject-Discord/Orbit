// 添付の PDF を pdf.js で表示する (components/mail/pdf-preview.tsx) ために、
// pdf.js が実行中に取得するファイルを public/pdfjs/<版>/ へ写す。next build と next dev の前に実行する。
//
// - pdf.worker.min.js: PDF を読むワーカー。拡張子を .js にするのは、.mjs の種類 (MIME) を
//   JavaScript として返さない配信元 (アプリの中の配信など) でも、モジュールとして読み込めるようにするため。
// - cmaps/: 日本語などの CJK の PDF に要る文字の対応表 (約 170 ファイル)。
// - standard_fonts/: PDF に埋め込まれていない標準のフォント。
// - wasm/: JPEG 2000 や JBIG2 の画像、色の変換に使う。PDF の中のスクリプトは実行しないので、
//   その実行環境 (quickjs) は写さない。
// - iccs/: 色の変換に使うプロファイル。
//
// 版をパスに入れるので、同じ URL の中身は変わらない (サービスワーカーは取得した分をそのまま保存して使う)。
// public/pdfjs/ は生成物なので Git には入れない (.gitignore)。
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(
  readFileSync(join(source, "package.json"), "utf8"),
);
const root = fileURLToPath(new URL("../public/pdfjs", import.meta.url));
const target = join(root, version);

// 前の版のファイルを残さない。
rmSync(root, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

cpSync(
  join(source, "legacy/build/pdf.worker.min.mjs"),
  join(target, "pdf.worker.min.js"),
);
cpSync(join(source, "LICENSE"), join(target, "LICENSE"));
for (const dir of ["cmaps", "standard_fonts", "iccs"]) {
  cpSync(join(source, dir), join(target, dir), { recursive: true });
}
cpSync(join(source, "wasm"), join(target, "wasm"), {
  recursive: true,
  filter: (path) => !/quickjs/i.test(path),
});

console.log(`pdfjs: public/pdfjs/${version}/ に写しました。`);
