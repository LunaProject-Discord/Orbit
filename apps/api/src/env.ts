import { loadEncryptionKey } from "@mail/core";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が設定されていません。`);
  }
  return value;
}

/** 環境変数を読み込む。不足があれば起動時に止める。 */
export function loadEnv() {
  const authSecret = required("BETTER_AUTH_SECRET");
  if (authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET は 32 文字以上にしてください。");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    port: Number(process.env.API_PORT ?? 8787),
    /** 外から見た API の URL。Better Auth がリンクや Cookie の設定に使う。 */
    publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:8787",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    authSecret,
    encryptionKey: loadEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY),
    /** localhost や社内 IP のメールサーバーを登録できるようにする (開発用)。 */
    allowPrivateMailHosts: process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true",
  };
}

export type Env = ReturnType<typeof loadEnv>;
