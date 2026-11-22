import { isLegacyTlsError, legacyTlsOptions } from "@mail/core";
import { ImapFlow } from "imapflow";

export type ImapSettings = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** 安全な再ネゴシエーションに対応していない古いサーバーへの接続を許す。 */
  allowLegacyTls?: boolean;
} & ({ password: string } | { accessToken: string });

export type ImapVerifyResult =
  | { ok: true }
  | {
      ok: false;
      /** legacy_tls_required は、古い TLS のサーバーなので許可が要る場合。 */
      reason: "auth_failed" | "connection_failed" | "legacy_tls_required";
      detail: string;
    };

/** 保存する前に、IMAP サーバーへ実際にログインできるかを確かめる。 */
export async function verifyImap(
  settings: ImapSettings,
): Promise<ImapVerifyResult> {
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth:
      "accessToken" in settings
        ? { user: settings.username, accessToken: settings.accessToken }
        : { user: settings.username, pass: settings.password },
    tls: legacyTlsOptions(settings.allowLegacyTls === true),
    logger: false,
    verifyOnly: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  // 接続後のエラーは error イベントで届く。未処理だとプロセスが落ちるので受けておく。
  client.on("error", () => {});
  try {
    await client.connect();
    return { ok: true };
  } catch (error) {
    const err = error as Error & {
      authenticationFailed?: boolean;
      responseText?: string;
    };
    const detail = err.responseText || err.message;
    return {
      ok: false,
      reason: err.authenticationFailed
        ? "auth_failed"
        : !settings.allowLegacyTls && isLegacyTlsError(detail)
          ? "legacy_tls_required"
          : "connection_failed",
      detail,
    };
  }
}
