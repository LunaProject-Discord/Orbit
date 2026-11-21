import type { Address } from "@mail/db";
import type { MessageAddressObject, MessageStructureObject } from "imapflow";

/** PostgreSQL の text は NUL 文字を保存できないので取り除く。 */
export function clean(value: string | undefined | null): string {
  return (value ?? "").replaceAll("\u0000", "");
}

export function toAddresses(
  list: MessageAddressObject[] | undefined,
): Address[] {
  return (list ?? [])
    .filter((entry) => entry.address)
    .map((entry) => ({
      ...(entry.name ? { name: clean(entry.name) } : {}),
      address: clean(entry.address),
    }));
}

/** References ヘッダー (折り返しあり) から Message-ID の並びを取り出す。 */
export function parseReferences(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  const unfolded = headers.toString("latin1").replace(/\r?\n[ \t]+/g, " ");
  const line = /^references:(.*)$/im.exec(unfolded);
  return line?.[1]?.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * スレッドをまとめるキー。会話の起点になった Message-ID を使う。
 * 汎用 IMAP ではサーバーがスレッド ID をくれないため、ヘッダーから求める。
 */
export function threadKeyOf(input: {
  references: string[];
  inReplyTo?: string | undefined;
  messageId?: string | undefined;
  fallback: string;
}): string {
  return clean(
    input.references[0] ?? input.inReplyTo ?? input.messageId ?? input.fallback,
  );
}

export type AttachmentInfo = {
  partId: string;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
};

export type StructureInfo = {
  /** 本文 (text/plain) の位置。無ければ null。 */
  textPart: string | null;
  /** 本文 (text/html) の位置。無ければ null。 */
  htmlPart: string | null;
  attachments: AttachmentInfo[];
};

/** BODYSTRUCTURE から、本文に使うパートと添付ファイルの一覧を求める。 */
export function analyzeStructure(
  root: MessageStructureObject | undefined,
): StructureInfo {
  const info: StructureInfo = {
    textPart: null,
    htmlPart: null,
    attachments: [],
  };
  if (!root) return info;

  const walk = (node: MessageStructureObject) => {
    const type = node.type.toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const child of node.childNodes ?? []) walk(child);
      return;
    }
    // 単一パートのメールは part が付かないので、IMAP の規則どおり "1" とする。
    const partId = node.part ?? "1";
    const disposition = node.disposition?.toLowerCase();
    const filename =
      node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const isBodyCandidate = disposition !== "attachment" && !filename;
    if (type === "text/plain" && isBodyCandidate && !info.textPart) {
      info.textPart = partId;
      return;
    }
    if (type === "text/html" && isBodyCandidate && !info.htmlPart) {
      info.htmlPart = partId;
      return;
    }
    // 転送メール (message/rfc822) などは中に入らず、1 つの添付として扱う。
    info.attachments.push({
      partId,
      filename: filename ? clean(filename) : null,
      contentType: type,
      size: node.size ?? 0,
      contentId: node.id ? clean(node.id) : null,
      inline: disposition === "inline" || (!disposition && Boolean(node.id)),
    });
  };
  walk(root);
  return info;
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 一覧に出す抜粋用に HTML から文字だけを取り出す。表示用の変換ではない。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1]?.toLowerCase() === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : " ";
      }
      return entities[name.toLowerCase()] ?? match;
    });
}

const SNIPPET_LENGTH = 200;

export function makeSnippet(text: string | null, html: string | null): string {
  const source = text?.trim() ? text : html ? htmlToText(html) : "";
  const collapsed = source.replace(/\s+/g, " ").trim();
  // サロゲートペアの途中で切らないよう、コードポイント単位で数える。
  return Array.from(collapsed).slice(0, SNIPPET_LENGTH).join("");
}

export function toDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const specialUseMap = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "all",
  "\\flagged": "flagged",
} as const;

export function toSpecialUse(value: string | undefined) {
  if (!value) return null;
  return (
    specialUseMap[value.toLowerCase() as keyof typeof specialUseMap] ?? null
  );
}

export function flagsOf(flags: Set<string> | undefined) {
  const has = (flag: string) => flags?.has(flag) ?? false;
  return {
    seen: has("\\Seen"),
    flagged: has("\\Flagged"),
    answered: has("\\Answered"),
    draft: has("\\Draft"),
  };
}
