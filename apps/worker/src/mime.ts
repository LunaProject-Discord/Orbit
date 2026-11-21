import type { OutgoingMessage } from "@mail/core";
import MailComposer from "nodemailer/lib/mail-composer";

/**
 * 送信するメールを RFC 5322 の形式に組み立てる。
 * keepBcc が true なら Bcc ヘッダーを残す (送信済みフォルダへの保存と、
 * Bcc の宛先をヘッダーから読む Microsoft Graph 用)。SMTP で送る分には残さない。
 */
export function buildMime(
  message: OutgoingMessage,
  options: { keepBcc: boolean },
): Promise<Buffer> {
  const node = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
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
