import {
  loadEncryptionKey,
  loadMicrosoftOAuthConfig,
  loadWebPushConfig,
} from "@mail/core";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} が設定されていません。リポジトリのルートで \`pnpm env:init\` を実行して .env を用意してください。`,
    );
  }
  return value;
}

/** 環境変数を読み込む。不足があれば起動時に止める。 */
export function loadEnv() {
  const authSecret = required("BETTER_AUTH_SECRET");
  if (authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET は 32 文字以上にしてください。");
  }
  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ?? "http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const microsoftConfig = loadMicrosoftOAuthConfig(process.env);
  return {
    databaseUrl: required("DATABASE_URL"),
    port: Number(process.env.API_PORT ?? 8787),
    /** 外から見た API の URL。Better Auth がリンクや Cookie の設定に使う。 */
    publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:8787",
    allowedOrigins,
    authSecret,
    encryptionKey: loadEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY),
    /** localhost や社内 IP のメールサーバーを登録できるようにする (開発用)。 */
    allowPrivateMailHosts: process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true",
    /** Microsoft アカウント (Exchange Online、Outlook.com) の追加。未設定なら null で無効。 */
    /** Web Push の公開鍵。端末が通知の送り先を登録するときに使う。未設定なら null。 */
    webPushPublicKey: loadWebPushConfig(process.env)?.publicKey ?? null,
    microsoft: microsoftConfig && {
      config: microsoftConfig,
      /** ログイン後に戻る Web の URL。Entra のアプリ登録のリダイレクト URI と一致させる。 */
      redirectUri:
        process.env.MICROSOFT_REDIRECT_URI ??
        `${allowedOrigins[0] ?? "http://localhost:3000"}/oauth/microsoft`,
    },
  };
}

export type Env = ReturnType<typeof loadEnv>;
