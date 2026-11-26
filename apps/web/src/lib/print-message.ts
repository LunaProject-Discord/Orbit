/**
 * メールの印刷 (デスクトップ版の Ctrl+P)。
 *
 * 画面をそのまま印刷すると、一覧やボタンまで入ってしまう。印刷用の文書 (件名、差出人・宛先・日時、本文) を
 * 組み立て、見えない枠 (iframe) に入れて、その枠だけを印刷する。
 * 本文の表示と同じく、CSP で外部への通信とスクリプトを止める。
 */

import type { Address } from "@/lib/api";
import { addressFull } from "@/lib/format";

/** 印刷する 1 通。 */
export type PrintableMessage = {
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  /** 表示用に整えた日時。 */
  date: string;
  bodyHtml: string | null;
  bodyText: string | null;
  /** 添付ファイルの名前 (本文に埋め込んだ画像は含めない)。 */
  attachments: string[];
};

export type PrintOptions = {
  /** 外部の画像を読み込むか (本文の表示で「画像を表示」にしているとき)。 */
  allowRemoteImages?: boolean;
  /** 本文のフォント、大きさ、行間 (本文の表示と同じ設定)。 */
  bodyStyle?: string;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML として解釈されないよう、記号を置き換える。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const addresses = (list: Address[]) =>
  escapeHtml(list.map((item) => addressFull(item)).join(", "));

const STYLE = [
  "@page{margin:15mm}",
  "html{background:#fff;color:#111}",
  "body{margin:0;font-family:system-ui,sans-serif}",
  ".orbit-print-subject{margin:0 0 12px;font-size:18px;font-weight:600;overflow-wrap:anywhere}",
  ".orbit-print-message{padding:12px 0;border-top:1px solid #bbb}",
  ".orbit-print-head{margin-bottom:12px;border-collapse:collapse;font-size:12px}",
  ".orbit-print-head th{padding:1px 12px 1px 0;color:#555;font-weight:normal;text-align:left;vertical-align:top;white-space:nowrap}",
  ".orbit-print-head td{padding:1px 0;overflow-wrap:anywhere}",
  ".orbit-print-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}",
  ".orbit-print-body{overflow-wrap:anywhere}",
  ".orbit-print-body img{max-width:100%;height:auto}",
].join("");

/** 印刷用の文書を組み立てる。件名は会話の最初のメールのものを使う。 */
export function buildPrintDocument(
  messages: PrintableMessage[],
  {
    allowRemoteImages = false,
    bodyStyle = "font-size:14px;line-height:1.6",
  }: PrintOptions = {},
): string {
  const subject = messages[0]?.subject || "(件名なし)";
  const imgSrc = allowRemoteImages ? "data: https:" : "data:";
  const sections = messages.map((message) => {
    const rows = [
      ["差出人", addresses(message.from)],
      ["宛先", addresses(message.to)],
      ["Cc", addresses(message.cc)],
      ["日時", escapeHtml(message.date)],
      ["添付", escapeHtml(message.attachments.join(", "))],
    ]
      .filter(([, value]) => value !== "")
      .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
      .join("");
    const body = message.bodyHtml
      ? message.bodyHtml
      : `<pre class="orbit-print-text">${escapeHtml(message.bodyText ?? "")}</pre>`;
    return [
      '<section class="orbit-print-message">',
      `<table class="orbit-print-head">${rows}</table>`,
      `<div class="orbit-print-body" style="${escapeHtml(bodyStyle)}">${body}</div>`,
      "</section>",
    ].join("");
  });
  return [
    '<!doctype html><html lang="ja"><head>',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(subject)}</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    `<h1 class="orbit-print-subject">${escapeHtml(subject)}</h1>`,
    ...sections,
    "</body></html>",
  ].join("");
}

/** 前回の印刷に使った枠。印刷の画面が閉じるまで残しておき、次の印刷のときに外す。 */
let lastFrame: HTMLIFrameElement | null = null;

/**
 * 文書を印刷する。見えない枠に入れて、読み込みが終わったら印刷の画面を出す。
 * 枠ではスクリプトを動かさない (印刷の画面を出すことだけを許す)。
 */
export function printHtml(html: string, doc: Document = document): void {
  lastFrame?.remove();
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // display:none の枠は印刷できないので、大きさを 0 にして隠す。
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  frame.addEventListener(
    "load",
    () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        // 印刷できない環境では何もしない。
      }
    },
    { once: true },
  );
  frame.srcdoc = html;
  doc.body.append(frame);
  lastFrame = frame;
}
