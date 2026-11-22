/**
 * Orbit 自身が利用者へ送るメール (パスワードの再設定、メールアドレスの変更の確認)。
 * 利用者のメールアカウントとは別に、運営者が用意した SMTP サーバーから送る。
 */
import { createTransport } from "nodemailer";

export type SystemMailConfig = {
  host: string;
  port: number;
  /** true なら最初から TLS (465 番など)、false なら STARTTLS。 */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** 差出人。「Orbit <no-reply@example.com>」の形でもよい。 */
  from: string;
};

/**
 * 環境変数から送信の設定を読む。SYSTEM_MAIL_HOST が空なら null (送れない)。
 * 書きかけの設定で黙って送れないままにならないよう、足りない値があれば起動時に止める。
 */
export function loadSystemMailConfig(
  env: Record<string, string | undefined>,
): SystemMailConfig | null {
  const host = env.SYSTEM_MAIL_HOST?.trim();
  if (!host) return null;
  const from = env.SYSTEM_MAIL_FROM?.trim();
  if (!from) {
    throw new Error(
      "SYSTEM_MAIL_HOST を設定したときは、SYSTEM_MAIL_FROM (差出人のメールアドレス) も設定してください。",
    );
  }
  const port = Number(env.SYSTEM_MAIL_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SYSTEM_MAIL_PORT は 1 から 65535 の数にしてください。");
  }
  const secureValue = env.SYSTEM_MAIL_SECURE?.trim();
  const user = env.SYSTEM_MAIL_USER?.trim() || null;
  const password = env.SYSTEM_MAIL_PASSWORD || null;
  if (user && !password) {
    throw new Error(
      "SYSTEM_MAIL_USER を設定したときは、SYSTEM_MAIL_PASSWORD も設定してください。",
    );
  }
  return {
    host,
    port,
    secure: secureValue ? secureValue === "true" : port === 465,
    user,
    password,
    from,
  };
}

export type SystemMail = {
  to: string;
  subject: string;
  /** 本文の段落。 */
  lines: string[];
  /** 本文の下に出すリンク。 */
  action?: { label: string; url: string };
  /** リンクの下に出す補足。 */
  footer?: string[];
};

export type SystemMailer = {
  send(mail: SystemMail): Promise<void>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** メールの本文 (テキストと HTML) を組み立てる。 */
export function renderSystemMail(mail: SystemMail): {
  text: string;
  html: string;
} {
  const footer = mail.footer ?? [];
  const text = [
    ...mail.lines,
    ...(mail.action ? ["", `${mail.action.label}:`, mail.action.url] : []),
    ...(footer.length > 0 ? ["", ...footer] : []),
    "",
    "-- ",
    "Orbit",
  ].join("\n");
  const paragraph = (line: string) =>
    `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`;
  const html = [
    '<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1f2328;max-width:560px">',
    ...mail.lines.map(paragraph),
    ...(mail.action
      ? [
          `<p style="margin:20px 0"><a href="${escapeHtml(mail.action.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(mail.action.label)}</a></p>`,
          `<p style="margin:0 0 12px;font-size:13px;color:#59636e">ボタンを押せないときは、次の URL をブラウザーで開いてください。<br><span style="word-break:break-all">${escapeHtml(mail.action.url)}</span></p>`,
        ]
      : []),
    ...footer.map(
      (line) =>
        `<p style="margin:0 0 8px;font-size:13px;color:#59636e">${escapeHtml(line)}</p>`,
    ),
    '<p style="margin:24px 0 0;font-size:13px;color:#59636e">Orbit</p>',
    "</div>",
  ].join("\n");
  return { text, html };
}

/** SMTP サーバーから送る。 */
export function createSmtpMailer(config: SystemMailConfig): SystemMailer {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // 平文のまま認証情報や再設定のリンクを流さないよう、STARTTLS を必須にする。
    requireTLS: !config.secure,
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      const { text, html } = renderSystemMail(mail);
      await transport.sendMail({
        from: config.from,
        to: mail.to,
        subject: mail.subject,
        text,
        html,
      });
    },
  };
}

/**
 * 開発用。メールを送らず、内容を API サーバーのログに出す
 * (SMTP を用意しなくても、再設定のリンクなどを試せる)。
 */
export function createConsoleMailer(
  log: (message: string) => void = console.log,
): SystemMailer {
  return {
    async send(mail) {
      const { text } = renderSystemMail(mail);
      log(
        [
          "----- メール (開発用: 送信せずにここへ出しています) -----",
          `宛先: ${mail.to}`,
          `件名: ${mail.subject}`,
          "",
          text,
          "-----",
        ].join("\n"),
      );
    },
  };
}
