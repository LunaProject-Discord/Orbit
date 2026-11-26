import { isLegacyTlsError, Pop3Client, Pop3Error } from "@orbit/core";

export type Pop3VerifySettings = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  /** 安全な再ネゴシエーションに対応していない古いサーバーへの接続を許す。 */
  allowLegacyTls?: boolean;
  /** STLS に対応していないサーバーへ、パスワードを平文で送ってよい (開発用)。 */
  allowInsecure?: boolean;
};

export type Pop3VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "auth_failed" | "connection_failed" | "legacy_tls_required";
      detail: string;
    };

/** 保存する前に、POP3 サーバーへ実際にログインできるかを確かめる (メールは受け取らない)。 */
export async function verifyPop3(
  settings: Pop3VerifySettings,
): Promise<Pop3VerifyResult> {
  const client = new Pop3Client({
    ...settings,
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    await client.connect();
    await client.quit().catch(() => {});
    return { ok: true };
  } catch (error) {
    const detail =
      error instanceof Pop3Error
        ? (error.responseText ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      reason:
        error instanceof Pop3Error && error.kind === "auth"
          ? "auth_failed"
          : !settings.allowLegacyTls && isLegacyTlsError(detail)
            ? "legacy_tls_required"
            : "connection_failed",
      detail,
    };
  }
}
