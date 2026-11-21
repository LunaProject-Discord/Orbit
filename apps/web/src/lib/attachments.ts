import type { Attachment } from "@/lib/api";

type FileInfo = Pick<Attachment, "contentType" | "filename">;

/** カードのアイコンと色を決めるための、ファイルの種類。 */
export type AttachmentKind =
  | "image"
  | "pdf"
  | "sheet"
  | "document"
  | "slides"
  | "archive"
  | "audio"
  | "video"
  | "text"
  | "mail"
  | "file";

function extensionOf(filename: string | null): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename ?? "");
  return match?.[1]?.toLowerCase() ?? "";
}

const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  pdf: "pdf",
  xls: "sheet",
  xlsx: "sheet",
  xlsm: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  pages: "document",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  "7z": "archive",
  rar: "archive",
  lzh: "archive",
  txt: "text",
  log: "text",
  md: "text",
  json: "text",
  xml: "text",
  eml: "mail",
  msg: "mail",
};

/**
 * ファイルの種類。メールに書かれた種類は当てにならないことがある
 * (何でも application/octet-stream で送るソフトがある) ので、拡張子も見る。
 */
export function attachmentKind(file: FileInfo): AttachmentKind {
  const type = file.contentType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type === "message/rfc822") return "mail";
  if (type === "text/csv" || /spreadsheet|ms-excel/.test(type)) return "sheet";
  if (/presentation|ms-powerpoint/.test(type)) return "slides";
  if (/wordprocessing|msword|opendocument\.text/.test(type)) return "document";
  if (/zip|compressed|x-tar/.test(type)) return "archive";
  const byExtension = KIND_BY_EXTENSION[extensionOf(file.filename)];
  if (byExtension) return byExtension;
  return type.startsWith("text/") ? "text" : "file";
}

/** 画面の中で表示できる画像の種類。blob に付ける種類もここから選ぶ。 */
const PREVIEW_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

const TEXT_EXTENSIONS = new Set(["txt", "log", "md", "csv", "tsv", "json"]);

/** これより大きいファイルは、プレビューせずに保存してもらう。 */
export const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export type Preview =
  /** type は、blob に付ける種類 (メールに書かれた種類はそのまま使わない)。 */
  { kind: "image"; type: string } | { kind: "pdf" } | { kind: "text" };

/** 画面の中でプレビューできるファイルなら、その方法。できなければ null。 */
export function previewOf(
  file: FileInfo & Pick<Attachment, "size">,
): Preview | null {
  if (file.size > MAX_PREVIEW_BYTES) return null;
  const type = file.contentType.toLowerCase();
  const extension = extensionOf(file.filename);
  const imageType =
    Object.values(PREVIEW_IMAGE_TYPES).find((value) => value === type) ??
    (type === "image/jpg" ? "image/jpeg" : undefined) ??
    (type.startsWith("image/") || type === "application/octet-stream"
      ? PREVIEW_IMAGE_TYPES[extension]
      : undefined);
  if (imageType) return { kind: "image", type: imageType };
  if (
    type === "application/pdf" ||
    (type === "application/octet-stream" && extension === "pdf")
  ) {
    return { kind: "pdf" };
  }
  if (
    file.size <= MAX_TEXT_PREVIEW_BYTES &&
    (type === "text/plain" ||
      type === "text/csv" ||
      ((type.startsWith("text/") || type === "application/octet-stream") &&
        TEXT_EXTENSIONS.has(extension)) ||
      type === "application/json")
  ) {
    return { kind: "text" };
  }
  return null;
}

/** Content-ID の前後の <> を取り除く (IMAP は <> 付き、Microsoft Graph は無しで返す)。 */
export function normalizeContentId(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "");
}

const CID_REFERENCE = /(["'(=]\s*)cid:([^"'\s)>]+)/gi;

function decodeCid(value: string): string {
  try {
    return normalizeContentId(decodeURIComponent(value));
  } catch {
    return normalizeContentId(value);
  }
}

/** HTML の本文が cid: で参照している Content-ID。 */
export function referencedContentIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(CID_REFERENCE)) {
    if (match[2]) ids.add(decodeCid(match[2]));
  }
  return ids;
}

/**
 * 本文に埋め込んで表示する画像 (本文から cid: で参照されている画像の添付ファイル)。
 * これ以外の添付ファイルは、本文の下にカードで並べる。
 */
export function splitAttachments(
  html: string | null,
  attachments: Attachment[],
): { embedded: Attachment[]; listed: Attachment[] } {
  const referenced = html ? referencedContentIds(html) : new Set<string>();
  const embedded: Attachment[] = [];
  const listed: Attachment[] = [];
  for (const file of attachments) {
    const isEmbedded =
      file.contentId !== null &&
      file.contentType.toLowerCase().startsWith("image/") &&
      referenced.has(normalizeContentId(file.contentId));
    (isEmbedded ? embedded : listed).push(file);
  }
  return { embedded, listed };
}

/** 本文の cid: の参照を、取得済みの画像の URL (data:) に置き換える。 */
export function replaceCidReferences(
  html: string,
  urls: ReadonlyMap<string, string>,
): string {
  if (urls.size === 0) return html;
  return html.replace(CID_REFERENCE, (match, prefix: string, id: string) => {
    const url = urls.get(decodeCid(id));
    return url ? `${prefix}${url}` : match;
  });
}

/** 添付ファイルを取得できなかった理由の説明。code は API が返すエラーコード。 */
export function attachmentErrorMessage(code: string | null): string {
  switch (code) {
    case "account_unavailable":
      return "このアカウントは同期が止まっているため、添付ファイルを取得できません。";
    case "not_found":
      return "添付ファイルがメールサーバーに見つかりませんでした。";
    case "too_large":
      return "添付ファイルが大きすぎるため取得できません。";
    case "timeout":
      return "添付ファイルの取得に時間がかかっています。少し待ってからもう一度お試しください。";
    default:
      return "添付ファイルを取得できませんでした。もう一度お試しください。";
  }
}
