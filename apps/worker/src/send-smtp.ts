import type { OutgoingMessage } from "@mail/core";
import nodemailer from "nodemailer";
import { buildMime, envelopeOf } from "./mime.js";
import type { SendOutcome } from "./send.js";

export type SmtpSettings = {
  host: string;
  port: number;
  /** true なら最初から TLS (465 番など)、false なら STARTTLS (587 番など)。 */
  secure: boolean;
  username: string;
  password: string;
  /** 暗号化されていない接続を許す (開発用のローカルサーバー向け)。 */
  allowInsecure: boolean;
};

type SmtpError = Error & {
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
};

/** メール本文を送り始める前の段階。ここでの失敗なら、相手には何も届いていない。 */
const SAFE_COMMANDS = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL FROM|RCPT TO)/;

/**
 * SMTP の失敗を、やり直してよいかどうかで分ける。
 * 本文を送っている途中で切れた場合は届いたかどうか分からないので、
 * 二重に送らないよう、やり直さずに失敗として利用者に知らせる。
 */
export function classifySmtpError(error: SmtpError): SendOutcome {
  const detail = error.response || error.message;
  const code = error.responseCode ?? 0;
  const authStage = error.code === "EAUTH" || /^AUTH/.test(error.command ?? "");
  if (authStage && !(code >= 400 && code < 500)) {
    return {
      status: "failed",
      reason: `SMTP サーバーにログインできませんでした: ${detail}`,
    };
  }
  if (code >= 500) {
    return {
      status: "failed",
      reason: `SMTP サーバーに拒否されました: ${detail}`,
    };
  }
  if (code >= 400) {
    return { status: "retry", reason: detail };
  }
  if (
    error.code === "EDNS" ||
    error.code === "ETLS" ||
    SAFE_COMMANDS.test(error.command ?? "")
  ) {
    return { status: "retry", reason: detail };
  }
  return {
    status: "failed",
    reason: `送信の途中で接続が切れました。相手に届いているか確認してから送り直してください: ${detail}`,
  };
}

/** SMTP でメールを 1 通送る。 */
export async function sendViaSmtp(
  settings: SmtpSettings,
  message: OutgoingMessage,
): Promise<SendOutcome> {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // STARTTLS に対応していないサーバーへ、パスワードを平文で送らない。
    requireTLS: !settings.secure && !settings.allowInsecure,
    auth: { user: settings.username, pass: settings.password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  try {
    const info = await transport.sendMail({
      envelope: envelopeOf(message),
      raw: await buildMime(message, { keepBcc: false }),
    });
    const rejected = (info.rejected ?? []).map(String);
    if (rejected.length > 0) {
      return {
        status: "sent",
        warning: `次の宛先には送信できませんでした (ほかの宛先には送信済みです): ${rejected.join(", ")}`,
      };
    }
    return { status: "sent" };
  } catch (error) {
    return classifySmtpError(error as SmtpError);
  } finally {
    transport.close();
  }
}
