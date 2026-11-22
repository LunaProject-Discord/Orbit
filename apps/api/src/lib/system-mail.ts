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

// ---------------------------------------------------------------------------
// Microsoft 365 (Microsoft Graph) から送る
// ---------------------------------------------------------------------------

export type GraphMailConfig = {
  /** Entra のテナント (ディレクトリ) の ID かドメイン。アプリ専用の認証では common は使えない。 */
  tenant: string;
  clientId: string;
  clientSecret: string;
  /** 送信に使うメールボックスのアドレス (このメールボックスが差出人になる)。 */
  sender: string;
};

/**
 * 環境変数から Microsoft Graph での送信の設定を読む。SYSTEM_MAIL_GRAPH_SENDER が空なら null。
 * クライアント ID とシークレットは、メールアカウントの追加に使っているアプリ登録
 * (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET) を既定で使う。
 */
export function loadGraphMailConfig(
  env: Record<string, string | undefined>,
): GraphMailConfig | null {
  const sender = env.SYSTEM_MAIL_GRAPH_SENDER?.trim();
  if (!sender) return null;
  if (!/^[^\s@]+@[^\s@]+$/.test(sender)) {
    throw new Error(
      "SYSTEM_MAIL_GRAPH_SENDER は、送信に使うメールボックスのメールアドレスにしてください。",
    );
  }
  const tenant =
    env.SYSTEM_MAIL_GRAPH_TENANT?.trim() || env.MICROSOFT_TENANT?.trim() || "";
  if (!tenant || ["common", "organizations", "consumers"].includes(tenant)) {
    throw new Error(
      "SYSTEM_MAIL_GRAPH_SENDER を設定したときは、SYSTEM_MAIL_GRAPH_TENANT にテナント (ディレクトリ) の ID かドメインを設定してください (common などは使えません)。",
    );
  }
  const clientId =
    env.SYSTEM_MAIL_GRAPH_CLIENT_ID?.trim() || env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret =
    env.SYSTEM_MAIL_GRAPH_CLIENT_SECRET?.trim() ||
    env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "SYSTEM_MAIL_GRAPH_SENDER を設定したときは、SYSTEM_MAIL_GRAPH_CLIENT_ID と SYSTEM_MAIL_GRAPH_CLIENT_SECRET (または MICROSOFT_CLIENT_ID と MICROSOFT_CLIENT_SECRET) も設定してください。",
    );
  }
  return { tenant, clientId, clientSecret, sender };
}

/**
 * 利用者へ送るメールの設定をまとめて読む。
 * Microsoft Graph (SYSTEM_MAIL_GRAPH_SENDER) と SMTP (SYSTEM_MAIL_HOST) のどちらか一方を使う。
 */
export function loadSystemMail(
  env: Record<string, string | undefined>,
):
  | { kind: "graph"; config: GraphMailConfig }
  | { kind: "smtp"; config: SystemMailConfig }
  | null {
  const graph = loadGraphMailConfig(env);
  const smtp = loadSystemMailConfig(env);
  if (graph && smtp) {
    throw new Error(
      "SYSTEM_MAIL_GRAPH_SENDER (Microsoft Graph) と SYSTEM_MAIL_HOST (SMTP) は、どちらか一方だけを設定してください。",
    );
  }
  if (graph) return { kind: "graph", config: graph };
  if (smtp) return { kind: "smtp", config: smtp };
  return null;
}

/** Graph やトークンの応答から、ログに出す短い理由を取り出す。 */
async function graphErrorOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const data = JSON.parse(text) as {
      error?: { code?: string; message?: string } | string;
      error_description?: string;
    };
    if (typeof data.error === "string") {
      return `${data.error}: ${data.error_description ?? ""}`.slice(0, 500);
    }
    if (data.error) {
      return `${data.error.code ?? ""}: ${data.error.message ?? ""}`.slice(
        0,
        500,
      );
    }
  } catch {
    // JSON でなければ、そのまま出す。
  }
  return text.slice(0, 500);
}

/**
 * Microsoft Graph の sendMail で送る。
 * 利用者のログインを介さない、アプリ専用の認証 (client credentials) を使うので、
 * アプリ登録に Mail.Send の「アプリケーションの許可」と管理者の同意が要る。
 */
export function createGraphMailer(
  config: GraphMailConfig,
  fetchFn: typeof fetch = fetch,
): SystemMailer {
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    // 期限の 1 分前までは、前に受け取ったトークンを使う。
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const response = await fetchFn(
      `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: "https://graph.microsoft.com/.default",
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Microsoft のトークンを取得できませんでした (${response.status}): ${await graphErrorOf(response)}`,
      );
    }
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error(
        "Microsoft のトークンの応答に access_token がありません。",
      );
    }
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 300) * 1000,
    };
    return cached.token;
  }

  async function post(mail: SystemMail, token: string): Promise<Response> {
    const { html } = renderSystemMail(mail);
    return fetchFn(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.sender)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: mail.subject,
            body: { contentType: "HTML", content: html },
            toRecipients: [{ emailAddress: { address: mail.to } }],
          },
          // 再設定のリンクなどを、送信済みアイテムに残さない。
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  }

  return {
    async send(mail) {
      let response = await post(mail, await accessToken());
      if (response.status === 401) {
        // トークンが取り消されていたら、取り直して 1 度だけやり直す。
        cached = null;
        response = await post(mail, await accessToken());
      }
      if (!response.ok) {
        throw new Error(
          `Microsoft Graph で送れませんでした (${response.status}): ${await graphErrorOf(response)}`,
        );
      }
    },
  };
}
