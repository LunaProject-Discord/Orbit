import type { Address } from "@orbit/db";
import {
  type AddressObject,
  type Attachment,
  type EmailAddress,
  simpleParser,
} from "mailparser";
import { parseListHeaders } from "./message-headers.js";
import { clean, makeSnippet, threadKeyOf, toDate } from "./message-parse.js";

/** 本文 1 つあたりの上限 (文字数)。IMAP の取り込み (2 MiB) とそろえる。 */
const MAX_BODY_CHARS = 2 * 1024 * 1024;

export type ParsedAttachment = {
  /** 原文の中での添付ファイルの位置。原文から取り出すときに使う。 */
  partId: string;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
};

/** 原文 (RFC 5322) から取り出した、取り込みに要る値。 */
export type ParsedRawMessage = {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  /** ヘッダーから求めたスレッドのキー (取り込み済みのメールとの突き合わせ前)。 */
  threadKey: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  sender: Address[];
  listId: string | null;
  listUnsubscribe: string[];
  sentAt: Date | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string;
  attachments: ParsedAttachment[];
};

function flatten(list: EmailAddress[]): EmailAddress[] {
  return list.flatMap((entry) =>
    entry.group ? flatten(entry.group) : [entry],
  );
}

function toAddresses(
  value: AddressObject | AddressObject[] | undefined,
): Address[] {
  const objects = value ? (Array.isArray(value) ? value : [value]) : [];
  return flatten(objects.flatMap((object) => object.value))
    .filter((entry) => entry.address)
    .map((entry) => ({
      ...(entry.name ? { name: clean(entry.name) } : {}),
      address: clean(entry.address),
    }));
}

function limit(value: string | null): string | null {
  if (!value) return null;
  return clean(
    value.length > MAX_BODY_CHARS ? value.slice(0, MAX_BODY_CHARS) : value,
  );
}

/** 原文のヘッダー部分 (最初の空行まで)。 */
function headerSection(raw: Buffer): Buffer {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  const end = crlf === -1 ? lf : lf === -1 ? crlf : Math.min(crlf, lf);
  return end === -1 ? raw : raw.subarray(0, end + 2);
}

/** 添付ファイルの一覧で使う位置。解析し直しても同じ値になるよう、出てきた順の番号にする。 */
function partIdOf(index: number): string {
  return String(index + 1);
}

/** 原文を解析する。添付ファイルの中身は捨て、一覧だけを返す。 */
export async function parseRawMessage(
  raw: Buffer,
  fallbackKey: string,
): Promise<ParsedRawMessage> {
  const mail = await simpleParser(raw, {
    // HTML 本文の cid: は残す (IMAP と同じく、画面がインライン画像を添付ファイルから表示する)。
    keepCidLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  const references = (
    Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? mail.references.split(/\s+/)
        : []
  )
    .map((value) => clean(value.trim()))
    .filter(Boolean);
  const messageIdHeader = mail.messageId ? clean(mail.messageId) : null;
  const inReplyTo = mail.inReplyTo ? clean(mail.inReplyTo) : null;
  const bodyText = limit(mail.text ?? null);
  const bodyHtml = limit(typeof mail.html === "string" ? mail.html : null);
  const headers = headerSection(raw);
  const sender = mail.headers.get("sender") as AddressObject | undefined;
  return {
    messageIdHeader,
    inReplyTo,
    references,
    threadKey: threadKeyOf({
      references,
      inReplyTo: inReplyTo ?? undefined,
      messageId: messageIdHeader ?? undefined,
      fallback: fallbackKey,
    }),
    subject: clean(mail.subject),
    from: toAddresses(mail.from),
    to: toAddresses(mail.to),
    cc: toAddresses(mail.cc),
    bcc: toAddresses(mail.bcc),
    replyTo: toAddresses(mail.replyTo),
    sender: toAddresses(sender),
    ...parseListHeaders(headers),
    sentAt: toDate(mail.date),
    bodyText,
    bodyHtml,
    snippet: makeSnippet(bodyText, bodyHtml),
    attachments: mail.attachments.map((file, index) => ({
      partId: partIdOf(index),
      filename: file.filename ? clean(file.filename) : null,
      contentType: file.contentType.toLowerCase(),
      size: file.size,
      contentId: file.contentId ? clean(file.contentId) : null,
      inline:
        file.contentDisposition === "inline" ||
        (!file.contentDisposition && Boolean(file.contentId)),
    })),
  };
}

/** 原文から、partId の添付ファイルの中身を取り出す。無ければ null。 */
export async function extractAttachment(
  raw: Buffer,
  partId: string,
): Promise<Attachment | null> {
  const mail = await simpleParser(raw, {
    keepCidLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  const index = Number(partId) - 1;
  return Number.isInteger(index) ? (mail.attachments[index] ?? null) : null;
}
