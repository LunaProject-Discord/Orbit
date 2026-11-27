import { useMemo } from "react";
import type { FontKind } from "@/lib/font-kind";
import {
  getLocalFontsState,
  type LocalFont,
  useLocalFonts,
} from "@/lib/local-fonts";

/**
 * 端末に入っていなくても選べるフォント。
 * - Gen Interface JP: アプリに同梱している (app/layout.tsx で npm の gen-interface-jp を読み込む) ので、
 *   画面ではいつでも使える。メール本文の枠 (別の文書) には同梱のフォントが届かないので、
 *   同じパッケージを jsDelivr から読み込む。Google Fonts には無い。
 * - Noto Sans JP と Noto Serif JP: 端末に無ければ Google Fonts から読み込む。
 */
export type WebFont = {
  family: string;
  /** どの種類のフォントか。設定の候補で、この種類の欄では上に並ぶ。 */
  kind: FontKind;
  /**
   * 読み込むスタイルシート。中の @font-face のファイルは、実際にその文字を描くときに読み込まれる。
   * 同梱のフォントでは、メール本文の枠の中でだけ使う。
   */
  stylesheets: readonly string[];
  /** アプリに同梱していて、画面ではいつでも使える。 */
  bundled: boolean;
};

/** 版は apps/web/package.json の gen-interface-jp (同梱しているもの) と合わせる。 */
const GEN_INTERFACE = "https://cdn.jsdelivr.net/npm/gen-interface-jp@0.8.0/cdn";
const GOOGLE_FONTS = "https://fonts.googleapis.com/css2";

export const WEB_FONTS: readonly WebFont[] = [
  {
    family: "Gen Interface JP",
    kind: "sans",
    // 本文に使う太さ (標準と太字) だけ。1 つの太さで 110 KB ほどある。
    stylesheets: [400, 700].map((w) => `${GEN_INTERFACE}/${w}.css`),
    bundled: true,
  },
  {
    family: "Noto Sans JP",
    kind: "sans",
    stylesheets: [
      `${GOOGLE_FONTS}?family=Noto+Sans+JP:wght@100..900&display=swap`,
    ],
    bundled: false,
  },
  {
    family: "Noto Serif JP",
    kind: "serif",
    stylesheets: [
      `${GOOGLE_FONTS}?family=Noto+Serif+JP:wght@200..900&display=swap`,
    ],
    bundled: false,
  },
];

/** Web フォントのスタイルシートとフォントのファイルを配るオリジン (メール本文の枠の CSP に足す)。 */
export const WEB_FONT_STYLE_ORIGINS = [
  "https://fonts.googleapis.com",
  "https://cdn.jsdelivr.net",
] as const;
export const WEB_FONT_FILE_ORIGINS = [
  "https://fonts.gstatic.com",
  "https://cdn.jsdelivr.net",
] as const;

/** WEB_FONTS のスタイルシートか (メール本文の枠に入れてよい URL だけを通す)。 */
export function isWebFontStylesheet(url: string): boolean {
  return WEB_FONTS.some((font) => font.stylesheets.includes(url));
}

function findWebFont(family: string): WebFont | undefined {
  const key = family.trim().toLowerCase();
  return WEB_FONTS.find((font) => font.family.toLowerCase() === key);
}

/** 端末に入っているかを調べた結果。Web フォントを読み込む前の結果を覚えておく。 */
const installedCache = new Map<string, boolean>();

/**
 * 端末に入っているフォントかを、文字の幅で調べる。
 * 指定したフォントが無ければ、続きの総称ファミリーで描かれて幅が同じになる。
 * 同じ名前の Web フォントを読み込んだ後は、そちらの幅になってしまうので、読み込む前に調べる。
 */
function measureInstalled(family: string): boolean {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  if (!context) return false;
  const text = "mmmmmmmmmmlli10WWあア永漢字";
  for (const base of ["monospace", "serif", "sans-serif"]) {
    context.font = `72px ${base}`;
    const fallback = context.measureText(text).width;
    context.font = `72px "${family}", ${base}`;
    if (context.measureText(text).width !== fallback) return true;
  }
  return false;
}

/**
 * このフォントが端末で使えるか。フォントの一覧を取れていれば一覧にあるかを見る
 * (Android アプリでは、一覧にあるフォントはファイルを読み込んで使える)。
 */
export function isFontInstalled(family: string): boolean {
  const key = family.trim().toLowerCase();
  const { status, fonts } = getLocalFontsState();
  if (
    status === "ready" &&
    fonts.some((font) => !font.source && font.family.toLowerCase() === key)
  ) {
    return true;
  }
  if (typeof document === "undefined") return true;
  let installed = installedCache.get(key);
  if (installed === undefined) {
    installed = measureInstalled(family);
    installedCache.set(key, installed);
  }
  return installed;
}

/** フォントの一覧で、端末に入っているフォントとして見つかるか。 */
function inLocalList(family: string): boolean {
  const key = family.toLowerCase();
  const { status, fonts } = getLocalFontsState();
  return (
    status === "ready" &&
    fonts.some((font) => !font.source && font.family.toLowerCase() === key)
  );
}

/**
 * 指定したフォントのうち、端末に無く Web フォントとして読み込む必要があるもののスタイルシート。
 * target は読み込む先: page は画面 (同梱のフォントは要らない)、frame はメール本文の枠。
 */
export function webFontStylesheets(
  families: readonly string[],
  target: "page" | "frame",
): string[] {
  const urls: string[] = [];
  for (const family of families) {
    const font = findWebFont(family);
    if (!font) continue;
    if (font.bundled) {
      // 画面では同梱のフォントを使う。画面には同梱のフォントがあるので、文字の幅では
      // 端末に入っているか分からない。本文の枠では、一覧に無ければ読み込む。
      if (target === "page" || inLocalList(font.family)) continue;
    } else if (isFontInstalled(font.family)) {
      continue;
    }
    for (const url of font.stylesheets) {
      if (!urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/**
 * 端末に無ければ、そのフォントの Web フォントを画面に読み込む。
 * 一度置いたスタイルシートは外さない (使わなければフォントのファイルは読み込まれない)。
 */
export function loadWebFonts(families: readonly string[]) {
  if (typeof document === "undefined") return;
  for (const url of webFontStylesheets(families, "page")) {
    if (document.head.querySelector(`link[data-web-font="${url}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.dataset.webFont = url;
    link.referrerPolicy = "no-referrer";
    document.head.append(link);
  }
}

/**
 * 設定の候補に出すフォント: 端末のフォントに、端末に無い Web フォント (と同梱のフォント) を足して名前順に並べる。
 */
export function withWebFonts(fonts: readonly LocalFont[]): LocalFont[] {
  const result = [...fonts];
  for (const font of WEB_FONTS) {
    const key = font.family.toLowerCase();
    if (result.some((item) => item.family.toLowerCase() === key)) continue;
    result.push({
      family: font.family,
      label: font.family,
      monospace: false,
      kind: font.kind === "serif" ? "serif" : "sans",
      source: font.bundled ? "bundled" : "web",
    });
  }
  return result.sort((a, b) => a.label.localeCompare(b.label, "ja"));
}

/**
 * 指定したフォントのうち、Web フォントとして読み込むもののスタイルシート (メール本文の枠に入れる)。
 * フォントの一覧が届いたら調べ直す。
 */
export function useWebFontStylesheets(families: readonly string[]): string[] {
  const { fonts } = useLocalFonts();
  const key = families.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 配列は中身 (key) で比べ、一覧が届いたら調べ直す
  return useMemo(() => webFontStylesheets(families, "frame"), [key, fonts]);
}

/** テスト用: 調べた結果を捨てる。 */
export function resetWebFontsForTest() {
  installedCache.clear();
}
