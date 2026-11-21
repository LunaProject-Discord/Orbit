import { ImapFlow } from "imapflow";

export type ImapSettings = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
} & ({ password: string } | { accessToken: string });

export type ImapVerifyResult =
  | { ok: true }
  | { ok: false; reason: "auth_failed" | "connection_failed"; detail: string };

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
    return {
      ok: false,
      reason: err.authenticationFailed ? "auth_failed" : "connection_failed",
      detail: err.responseText || err.message,
    };
  }
}
