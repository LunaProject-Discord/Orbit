/**
 * 添付の PDF のプレビュー (components/mail/pdf-preview.tsx) で使う、画面に依らない計算。
 */

/** PDF をどう表示するか。iframe はブラウザーの PDF ビューア、pdfjs は pdf.js で canvas に描く。 */
export type PdfPreviewMethod = "iframe" | "pdfjs";

/**
 * PDF の表示方法を選ぶ。ブラウザーに PDF ビューアがあれば (PC のブラウザー、デスクトップ版)、
 * 慣れた操作 (検索、印刷など) ができるのでそれを使う。
 * スマホアプリ (Android の WebView) にはビューアが無く、iframe に入れても真っ白になる。
 * WebView は pdfViewerEnabled を正しく返さないことがあるので、アプリの中では常に pdf.js にする。
 */
export function pdfPreviewMethod(env: {
  /** navigator.pdfViewerEnabled。古いブラウザーでは undefined (ビューアがあるものとして扱う)。 */
  pdfViewerEnabled: boolean | undefined;
  nativeApp: boolean;
}): PdfPreviewMethod {
  return env.nativeApp || env.pdfViewerEnabled === false ? "pdfjs" : "iframe";
}

/** 拡大率の範囲 (1 が幅に合わせた大きさ)。 */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** ボタンで拡大・縮小するときの段階。 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** ボタンで 1 段階拡大 (direction = 1) または縮小 (-1) した拡大率。ピンチで半端な値になっていても次の段階へ進む。 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + epsilon)
      : [...ZOOM_STEPS].reverse().find((step) => step < zoom - epsilon);
  return next ?? (direction > 0 ? MAX_ZOOM : MIN_ZOOM);
}

/**
 * canvas 1 枚の画素数の上限。端末の解像度に合わせると、拡大したときに 1 枚で数百 MB になり、
 * Android の WebView では描けなかったりアプリごと落ちたりする。iOS / Android の canvas の上限 (約 1,670 万画素) に合わせる。
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

/**
 * 表示の 1px あたりに描く canvas の画素数。端末の解像度 (devicePixelRatio) に合わせて鮮明にするが、
 * canvas の面積が上限を超えるときは下げる (拡大したときに少しぼやけるだけで済む)。
 */
export function canvasPixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = MAX_CANVAS_PIXELS,
): number {
  const ratio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const area = cssWidth * cssHeight;
  if (!(area > 0)) return ratio;
  return Math.min(ratio, Math.sqrt(maxPixels / area));
}

export type PdfErrorKind = "password" | "invalid" | "unavailable";

/**
 * 読み込めなかった理由。pdf.js の例外は name で見分ける (クラスは動的に読み込むので instanceof を使わない)。
 * password: パスワード付き。invalid: 壊れているか PDF ではない。unavailable: pdf.js 自体を読み込めなかった (通信など)。
 */
export function pdfErrorKind(error: unknown): PdfErrorKind {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (name === "PasswordException") return "password";
  if (
    name === "InvalidPDFException" ||
    name === "FormatError" ||
    name === "UnknownErrorException"
  ) {
    return "invalid";
  }
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  // スクリプト (pdf.js 本体、ワーカー) を取得できなかった。
  if (
    name === "ChunkLoadError" ||
    name === "TypeError" ||
    /fake worker|dynamically imported module/i.test(message)
  ) {
    return "unavailable";
  }
  return "invalid";
}

/** 読み込めなかったときの説明。白い画面のままにせず、ほかの方法を案内する。 */
export function pdfErrorMessage(kind: PdfErrorKind): string {
  switch (kind) {
    case "password":
      return "パスワードで保護された PDF のため、ここでは表示できません。保存するか、別のアプリで開いてください。";
    case "unavailable":
      return "PDF を表示する準備ができませんでした。通信できる状態でもう一度開くか、保存して別のアプリで開いてください。";
    default:
      return "この PDF は壊れているか、対応していない形式のため表示できません。保存するか、別のアプリで開いてください。";
  }
}

/**
 * 縦に並んだページのうち、表示領域の上から 4 割の線にかかっているページの番号 (1 から)。
 * bottoms は各ページの下端の位置 (表示領域の上端からの距離、ページ順に増える)。
 */
export function currentPageIndex(
  bottoms: readonly number[],
  viewportHeight: number,
): number {
  const line = viewportHeight * 0.4;
  let low = 0;
  let high = bottoms.length - 1;
  if (high < 0) return 0;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((bottoms[middle] ?? 0) > line) high = middle;
    else low = middle + 1;
  }
  return low + 1;
}
