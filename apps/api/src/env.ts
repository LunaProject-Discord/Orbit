import { hostname, networkInterfaces } from "node:os";
import {
  loadEncryptionKey,
  loadFcmConfig,
  loadGoogleOAuthConfig,
  loadMicrosoftOAuthConfig,
  loadWebPushConfig,
} from "@mail/core";
import { lanOrigins } from "./lib/lan-origins.js";
import { loadSystemMailConfig } from "./lib/system-mail.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} が設定されていません。リポジトリのルートで \`pnpm env:init\` を実行して .env を用意してください。`,
    );
  }
  return value;
}

/**
 * 同梱アプリの画面のオリジン。
 * - スマホ版 (Capacitor): Android は https://localhost、iOS は capacitor://localhost。
 * - デスクトップ版 (Tauri): Windows は http://tauri.localhost、macOS / Linux は tauri://localhost。
 */
const APP_ORIGINS = [
  "https://localhost",
  "capacitor://localhost",
  "http://tauri.localhost",
  "tauri://localhost",
];

/** 環境変数を読み込む。不足があれば起動時に止める。 */
export function loadEnv() {
  const authSecret = required("BETTER_AUTH_SECRET");
  if (authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET は 32 文字以上にしてください。");
  }
  const configuredOrigins = (
    process.env.ALLOWED_ORIGINS ?? "http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  // 開発中は、同じ LAN のスマホなどから http://<この PC の IP アドレス>:3000 で開いても使えるようにする。
  // 本番 (NODE_ENV=production) では足さない。ALLOW_LAN_ORIGINS=false でも止められる。
  const allowLan =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_LAN_ORIGINS !== "false";
  // 同梱アプリの画面のオリジンは固定なので、設定しなくても通す。
  // 認証は Authorization ヘッダーのトークンで行い Cookie を使わないため、オリジンを足しても
  // 他のサイトから利用者の権限で呼ばれることはない。
  const allowedOrigins = [
    ...new Set([
      ...configuredOrigins,
      ...(allowLan
        ? lanOrigins(configuredOrigins, hostname(), networkInterfaces())
        : []),
      ...APP_ORIGINS,
    ]),
  ];
  const microsoftConfig = loadMicrosoftOAuthConfig(process.env);
  const googleConfig = loadGoogleOAuthConfig(process.env);
  const webOrigin = configuredOrigins[0] ?? "http://localhost:3000";
  const production = process.env.NODE_ENV === "production";
  const systemMail = loadSystemMailConfig(process.env);
  return {
    /** Web の URL。メールに書くリンクの先になる。 */
    webOrigin,
    /**
     * Orbit 自身が利用者へ送るメール (パスワードの再設定、メールアドレスの変更の確認)。
     * - smtp: SYSTEM_MAIL_* の SMTP サーバーから送る。
     * - console: 開発用。送らずに API サーバーのログへ出す (SMTP が未設定で、本番ではないとき)。
     * - null: 送れない (本番で SMTP が未設定)。再設定とメールアドレスの変更は使えない。
     */
    systemMail: systemMail
      ? ({ kind: "smtp", config: systemMail } as const)
      : production
        ? null
        : ({ kind: "console" } as const),
    /**
     * パスキーの設定。パスキーは Web のドメイン (rpId) に結び付くので、ドメインを変えると
     * 登録済みのパスキーは使えなくなる。既定は Web の URL のホスト名。
     */
    passkey: {
      rpId: process.env.PASSKEY_RP_ID?.trim() || new URL(webOrigin).hostname,
      origins: configuredOrigins,
    },
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
    /** スマホアプリへの通知 (FCM)。送るのは同期ワーカーで、API は送れるかどうかだけを端末に伝える。 */
    fcmEnabled: loadFcmConfig(process.env) !== null,
    microsoft: microsoftConfig && {
      config: microsoftConfig,
      /** ログイン後に戻る Web の URL。Entra のアプリ登録のリダイレクト URI と一致させる。 */
      redirectUri:
        process.env.MICROSOFT_REDIRECT_URI ?? `${webOrigin}/oauth/microsoft`,
    },
    /** Gmail アカウントの追加 (Google でログイン)。未設定なら null で無効。 */
    google: googleConfig && {
      config: googleConfig,
      /** ログイン後に戻る Web の URL。Google Cloud の「承認済みのリダイレクト URI」と一致させる。 */
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ?? `${webOrigin}/oauth/google`,
    },
  };
}

export type Env = ReturnType<typeof loadEnv>;
