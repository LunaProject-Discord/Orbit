import {
  attachmentExists,
  attachmentPath,
  attachmentsDir,
  type OutgoingMessage,
} from "@mail/core";
import MailComposer from "nodemailer/lib/mail-composer";

/**
 * 書式付きの本文を、1 つの HTML 文書にする。
 * 文字コードと既定の書体を決めておくと、相手のメールソフトによる見た目の差が小さくなる。
 */
export function htmlDocument(body: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    `<body style="font-family:sans-serif;font-size:14px;line-height:1.6">${body}</body></html>`
  );
}

/**
 * 送信するメールを RFC 5322 の形式に組み立てる。
 * keepBcc が true なら Bcc ヘッダーを残す (送信済みフォルダへの保存と、
 * Bcc の宛先をヘッダーから読む Microsoft Graph 用)。SMTP で送る分には残さない。
 * 書式付きの本文があれば、テキストと HTML の両方を入れる (multipart/alternative)。
 * HTML を表示しないメールソフトでは、テキストのほうが表示される。
 */
export function buildMime(
  message: OutgoingMessage,
  options: { keepBcc: boolean },
): Promise<Buffer> {
  const dir = attachmentsDir();
  const node = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: htmlDocument(message.html) } : {}),
    attachments: (message.attachments ?? []).map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      path: attachmentPath(dir, file.storageKey),
    })),
    messageId: message.messageId,
    date: new Date(message.date),
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references.length > 0
      ? { references: message.references }
      : {}),
  }).compile();
  node.keepBcc = options.keepBcc;
  return node.build();
}

/** SMTP の封筒 (実際の配送先)。Bcc もここに含める。 */
export function envelopeOf(message: OutgoingMessage): {
  from: string;
  to: string[];
} {
  return {
    from: message.from.address,
    to: [
      ...new Set(
        [...message.to, ...message.cc, ...message.bcc].map(
          (entry) => entry.address,
        ),
      ),
    ],
  };
}

/** 置き場から無くなっている添付ファイルの名前。送信や保存の前に確かめる。 */
export async function missingAttachments(
  message: OutgoingMessage,
): Promise<string[]> {
  const dir = attachmentsDir();
  const missing: string[] = [];
  for (const file of message.attachments ?? []) {
    if (!(await attachmentExists(dir, file.storageKey))) {
      missing.push(file.filename);
    }
  }
  return missing;
}
