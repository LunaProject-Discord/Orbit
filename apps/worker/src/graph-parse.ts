import type { Address, messages } from "@orbit/db";
import {
  type AttachmentInfo,
  clean,
  makeSnippet,
  toDate,
} from "./message-parse.js";

type GraphRecipient = {
  emailAddress?: { name?: string | null; address?: string | null } | null;
};

/** Microsoft Graph の message。$select で指定した項目と、変更があった項目だけが入る。 */
export type GraphMessage = {
  id: string;
  "@removed"?: { reason?: string };
  conversationId?: string | null;
  internetMessageId?: string | null;
  subject?: string | null;
  from?: GraphRecipient | null;
  /** 実際に送った人 (代理送信では from と違う)。 */
  sender?: GraphRecipient | null;
  /** メールのヘッダー。1 通ずつの取得で $select に指定したときだけ届く。 */
  internetMessageHeaders?:
    | { name?: string | null; value?: string | null }[]
    | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  bccRecipients?: GraphRecipient[] | null;
  replyTo?: GraphRecipient[] | null;
  sentDateTime?: string | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  hasAttachments?: boolean | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  flag?: { flagStatus?: string | null } | null;
  body?: { contentType?: string | null; content?: string | null } | null;
};

/** 一覧の取得で要求する項目。本文は大きいので別に取得する。 */
export const MESSAGE_SELECT = [
  "conversationId",
  "internetMessageId",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "sentDateTime",
  "receivedDateTime",
  "bodyPreview",
  "hasAttachments",
  "isRead",
  "isDraft",
  "flag",
].join(",");

const WELL_KNOWN_FOLDERS = {
  inbox: "inbox",
  sentitems: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  junkemail: "junk",
  archive: "archive",
} as const;

/** Graph の既定フォルダ名 (well-known name) と、このアプリでの役割の対応。 */
export const wellKnownFolders = Object.entries(WELL_KNOWN_FOLDERS) as [
  keyof typeof WELL_KNOWN_FOLDERS,
  (typeof WELL_KNOWN_FOLDERS)[keyof typeof WELL_KNOWN_FOLDERS],
][];

function toAddresses(
  list: (GraphRecipient | null | undefined)[] | null | undefined,
): Address[] {
  const result: Address[] = [];
  for (const entry of list ?? []) {
    const address = entry?.emailAddress?.address;
    if (!address) continue;
    const name = entry.emailAddress?.name;
    result.push({
      // 名前が無いとき Graph はアドレスを名前に入れてくる。重複するので省く。
      ...(name && name !== address ? { name: clean(name) } : {}),
      address: clean(address),
    });
  }
  return result;
}

export type MessageValues = Partial<
  Pick<
    typeof messages.$inferInsert,
    | "threadKey"
    | "messageIdHeader"
    | "subject"
    | "from"
    | "to"
    | "cc"
    | "bcc"
    | "replyTo"
    | "sender"
    | "sentAt"
    | "receivedAt"
    | "snippet"
    | "hasAttachments"
    | "seen"
    | "flagged"
    | "draft"
  >
>;

/**
 * Graph の message を messages テーブルの値に変換する。
 * 差分取得では変更のあった項目しか届かないことがあるため、届いた項目だけを返す
 * (届かなかった項目で既存の値を上書きしない)。
 */
export function toMessageValues(item: GraphMessage): MessageValues {
  const values: MessageValues = {};
  if (item.conversationId) values.threadKey = clean(item.conversationId);
  if (item.internetMessageId !== undefined) {
    values.messageIdHeader = item.internetMessageId
      ? clean(item.internetMessageId)
      : null;
  }
  if (item.subject !== undefined) values.subject = clean(item.subject);
  if (item.from !== undefined) values.from = toAddresses([item.from]);
  if (item.sender !== undefined) values.sender = toAddresses([item.sender]);
  if (item.toRecipients !== undefined) {
    values.to = toAddresses(item.toRecipients);
  }
  if (item.ccRecipients !== undefined) {
    values.cc = toAddresses(item.ccRecipients);
  }
  if (item.bccRecipients !== undefined) {
    values.bcc = toAddresses(item.bccRecipients);
  }
  if (item.replyTo !== undefined) values.replyTo = toAddresses(item.replyTo);
  if (item.sentDateTime !== undefined) {
    values.sentAt = toDate(item.sentDateTime ?? undefined);
  }
  const receivedAt = toDate(item.receivedDateTime ?? undefined);
  if (receivedAt) values.receivedAt = receivedAt;
  if (item.bodyPreview != null) {
    values.snippet = makeSnippet(clean(item.bodyPreview), null);
  }
  if (item.hasAttachments != null) values.hasAttachments = item.hasAttachments;
  if (item.isRead != null) values.seen = item.isRead;
  if (item.isDraft != null) values.draft = item.isDraft;
  if (item.flag != null) values.flagged = item.flag.flagStatus === "flagged";
  return values;
}

/** 本文の上限。これを超える分は切り捨てる (IMAP 側の上限と同じ 2 MiB 相当)。 */
const MAX_BODY_CHARS = 2 * 1024 * 1024;

/** Graph の body を、テキストと HTML のどちらかに振り分ける。 */
export function toBody(body: GraphMessage["body"]): {
  bodyText: string | null;
  bodyHtml: string | null;
} {
  const content = clean(body?.content).slice(0, MAX_BODY_CHARS);
  if (!content) return { bodyText: null, bodyHtml: null };
  return body?.contentType?.toLowerCase() === "html"
    ? { bodyText: null, bodyHtml: content }
    : { bodyText: content, bodyHtml: null };
}

/** Microsoft Graph の attachment。実体 (contentBytes) は一覧では受け取らない。 */
export type GraphAttachment = {
  "@odata.type"?: string | null;
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  contentId?: string | null;
};

/**
 * 添付ファイルの一覧で要求する項目。contentId は fileAttachment にしか無いので、
 * 型を指定して要求する。
 */
export const ATTACHMENT_SELECT =
  "id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId";

/**
 * Graph の添付ファイルを attachments テーブルの値に変換する。partId には Graph の ID を入れる。
 * OneDrive などへのリンク (referenceAttachment) は実体を持たないので除く。
 */
export function toAttachmentInfos(items: GraphAttachment[]): AttachmentInfo[] {
  const result: AttachmentInfo[] = [];
  for (const item of items) {
    const kind = item["@odata.type"]?.toLowerCase() ?? "";
    if (!item.id || kind.endsWith("referenceattachment")) continue;
    const isItem = kind.endsWith("itemattachment");
    const name = item.name ? clean(item.name) : null;
    result.push({
      partId: item.id,
      // 添付されたメール (itemAttachment) は、.eml として保存できるようにする。
      filename: isItem && name && !/\.eml$/i.test(name) ? `${name}.eml` : name,
      contentType: isItem
        ? "message/rfc822"
        : clean(item.contentType).toLowerCase() || "application/octet-stream",
      size: item.size ?? 0,
      contentId: item.contentId ? clean(item.contentId) : null,
      inline: item.isInline === true,
    });
  }
  return result;
}
