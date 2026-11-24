import { isLegacyTlsError, legacyTlsOptions } from "@orbit/core";
import { createTransport } from "nodemailer";

export type SmtpVerifySettings = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  allowLegacyTls?: boolean;
  /** STARTTLS に対応していないサーバーへ、パスワードを平文で送ってよい (開発用)。 */
  allowInsecure?: boolean;
};

export type SmtpVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "auth_failed" | "connection_failed" | "legacy_tls_required";
      detail: string;
    };

/** 保存する前に、SMTP サーバーへ実際にログインできるかを確かめる (メールは送らない)。 */
export async function verifySmtp(
  settings: SmtpVerifySettings,
): Promise<SmtpVerifyResult> {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    // 送信時 (apps/worker の send-smtp.ts) と同じく、STARTTLS の無いサーバーには平文で送らない。
    requireTLS: !settings.secure && settings.allowInsecure !== true,
    tls: legacyTlsOptions(settings.allowLegacyTls === true),
    auth: { user: settings.username, pass: settings.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    const err = error as Error & {
      code?: string;
      response?: string;
      command?: string;
    };
    const detail = err.response || err.message;
    return {
      ok: false,
      reason:
        err.code === "EAUTH"
          ? "auth_failed"
          : !settings.allowLegacyTls && isLegacyTlsError(detail)
            ? "legacy_tls_required"
            : "connection_failed",
      detail,
    };
  } finally {
    transport.close();
  }
}
