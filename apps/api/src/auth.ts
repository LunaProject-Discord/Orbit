import { passkey } from "@better-auth/passkey";
import {
  authAccounts,
  type Database,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@orbit/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, twoFactor } from "better-auth/plugins";
import { ssoSignIn } from "./lib/sso-sign-in.js";
import type { SystemMailer } from "./lib/system-mail.js";

/** アプリの名前。認証アプリに出る発行者名と、パスキーの保存先に出る名前になる。 */
const APP_NAME = "Orbit";

/** 再設定のリンクの有効期限 (秒)。 */
const RESET_PASSWORD_EXPIRES_IN = 60 * 60;
/** メールアドレスの確認のリンクの有効期限 (秒)。 */
const EMAIL_VERIFICATION_EXPIRES_IN = 60 * 60;

export type AuthOptions = {
  db: Database;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  /**
   * 利用者の新規登録を受け付けるか。API サーバーでは常に false (招待制) で、
   * 利用者を作る CLI だけが true にする。
   */
  allowSignUp?: boolean;
  /** Web の URL (メールに書くリンクの先)。 */
  webOrigin?: string;
  /** 利用者へメールを送る手段。null なら、パスワードの再設定とメールアドレスの変更は使えない。 */
  mailer?: SystemMailer | null;
  /** パスキーの設定。rpId は Web のドメイン、origins は Web のオリジン。 */
  passkey?: { rpId: string; origins: string[] };
};

export function createAuth({
  db,
  secret,
  baseURL,
  trustedOrigins,
  allowSignUp = false,
  webOrigin = "http://localhost:3000",
  mailer = null,
  passkey: passkeyOptions = { rpId: "localhost", origins: [webOrigin] },
}: AuthOptions) {
  /** 送れなかったことは、呼び出し元には伝えずログに残す (宛先が登録済みかどうかを応答で漏らさない)。 */
  const send = async (mail: Parameters<SystemMailer["send"]>[0]) => {
    if (!mailer) return;
    try {
      await mailer.send(mail);
    } catch (error) {
      console.error(
        `メールを送れませんでした (${mail.subject}):`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  return betterAuth({
    appName: APP_NAME,
    secret,
    baseURL,
    basePath: "/v1/auth",
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: authAccounts,
        verification: verifications,
        twoFactor: twoFactors,
        passkey: passkeys,
      },
    }),
    // 主キーは DB の uuidv7() に任せる。
    advanced: { database: { generateId: false } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN,
      // 再設定したら、どの端末もログインし直しにする (パスワードを知られた場合に締め出すため)。
      revokeSessionsOnPasswordReset: true,
      ...(mailer
        ? {
            sendResetPassword: async ({ user, token }) => {
              await send({
                to: user.email,
                subject: "Orbit のパスワードの再設定",
                lines: [
                  `${user.name} さん`,
                  "Orbit のパスワードの再設定が申し込まれました。下のリンクを開いて、新しいパスワードを設定してください。",
                ],
                action: {
                  label: "パスワードを再設定する",
                  url: `${webOrigin}/reset-password?token=${encodeURIComponent(token)}`,
                },
                footer: [
                  "リンクの有効期限は 1 時間です。",
                  "心当たりがない場合は、このメールを破棄してください。パスワードは変わりません。",
                ],
              });
            },
          }
        : {}),
    },
    ...(mailer
      ? {
          emailVerification: {
            expiresIn: EMAIL_VERIFICATION_EXPIRES_IN,
            // メールアドレスの変更で、新しいアドレスへ送る確認のメール。
            sendVerificationEmail: async ({ user, url }) => {
              await send({
                to: user.email,
                subject: "Orbit のメールアドレスの確認",
                lines: [
                  `${user.name} さん`,
                  `Orbit のログインに使うメールアドレスを、このアドレス (${user.email}) に変更する申し込みがありました。下のリンクを開くと変更が完了します。`,
                ],
                action: { label: "メールアドレスを確認する", url },
                footer: [
                  "リンクの有効期限は 1 時間です。",
                  "心当たりがない場合は、このメールを破棄してください。メールアドレスは変わりません。",
                ],
              });
            },
          },
          user: {
            // 申し込みは /v1/security/email がパスワードを確かめてから受け付け、
            // 新しいアドレスへ届くリンクを開いた時点で変更する。
            changeEmail: { enabled: true },
          },
        }
      : {}),
    plugins: [
      // Web / Tauri / Capacitor で同じ方式を使えるよう、セッショントークンを
      // Authorization: Bearer で受け付ける。
      bearer(),
      // 2 段階認証。認証アプリ (TOTP) とバックアップコードを使う。
      twoFactor({ issuer: APP_NAME }),
      // パスキー (WebAuthn) でのログイン。
      passkey({
        rpID: passkeyOptions.rpId,
        rpName: APP_NAME,
        origin: passkeyOptions.origins,
      }),
      // IdP (SSO) でのログインの最後の段。サーバーの中からだけ呼ぶ (routes/sso.ts)。
      ssoSignIn(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
