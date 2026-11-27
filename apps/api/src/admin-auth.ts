import { passkey } from "@better-auth/passkey";
import {
  adminAuthAccounts,
  adminPasskeys,
  adminSessions,
  adminTwoFactors,
  adminUsers,
  adminVerifications,
  type Database,
} from "@orbit/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, twoFactor, username } from "better-auth/plugins";

/** 認証アプリとパスキーの保存先に出る名前 (一般の利用者のアカウントと見分けられるように)。 */
const APP_NAME = "Orbit 管理";

/** 管理者のパスワードの長さ (一般の利用者と同じ)。 */
export const ADMIN_MIN_PASSWORD_LENGTH = 12;
export const ADMIN_MAX_PASSWORD_LENGTH = 128;
/** ログインに使う名前の長さと使える文字。 */
export const ADMIN_USERNAME_MIN = 3;
export const ADMIN_USERNAME_MAX = 32;
export const ADMIN_USERNAME_PATTERN = /^[a-z0-9_.-]+$/;

/** 管理者の API の置き場。一般の利用者の /v1/auth とは別にする。 */
export const ADMIN_AUTH_BASE_PATH = "/v1/admin/auth";

/**
 * Better Auth が必須とするメールアドレスの代わり。管理者はメールを持たないので、
 * 名前から作った、どこにも届かないアドレス (.invalid は予約済みのドメイン) を入れる。
 */
export function adminPlaceholderEmail(name: string): string {
  return `${name.toLowerCase()}@admin.orbit.invalid`;
}

/**
 * 外から呼べる管理者の認証の API。Better Auth にはほかにも受け口があるが
 * (メールでのログイン、新規登録、名前やメールアドレスの変更など)、管理者には使わせない。
 */
export const ADMIN_AUTH_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/username",
  "/sign-out",
  "/get-session",
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
]);

export type AdminAuthOptions = {
  db: Database;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  /** 管理者を作れるか。API の受け口では常に false で、作成はコマンドと初回セットアップだけが行う。 */
  allowSignUp?: boolean;
  /** パスキーの設定 (一般の利用者と同じ Web のドメイン)。 */
  passkey?: { rpId: string; origins: string[] };
};

/**
 * 管理者用の Better Auth。一般の利用者 (auth.ts) とは表もセッションも別なので、
 * 利用者のトークンで管理の API は呼べず、管理者のトークンでメールの API は呼べない。
 */
export function createAdminAuth({
  db,
  secret,
  baseURL,
  trustedOrigins,
  allowSignUp = false,
  passkey: passkeyOptions = {
    rpId: "localhost",
    origins: ["http://localhost:3000"],
  },
}: AdminAuthOptions) {
  return betterAuth({
    appName: APP_NAME,
    secret,
    baseURL,
    basePath: ADMIN_AUTH_BASE_PATH,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: adminUsers,
        session: adminSessions,
        account: adminAuthAccounts,
        verification: adminVerifications,
        twoFactor: adminTwoFactors,
        passkey: adminPasskeys,
      },
    }),
    advanced: {
      database: { generateId: false },
      // 2 段階認証・パスキーの途中の値 (X-Auth-State で受け渡す) を、利用者のものと取り違えないように。
      cookiePrefix: "orbit-admin",
    },
    // 管理者のログインは、一般の利用者 (7 日) より短くする。使い続けている間は延びる。
    // パスキーの登録など、大事な操作はログインから 10 分以内に限る (トークンを盗まれても後から足されにくく)。
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60, freshAge: 60 * 10 },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: ADMIN_MIN_PASSWORD_LENGTH,
      maxPasswordLength: ADMIN_MAX_PASSWORD_LENGTH,
    },
    plugins: [
      bearer(),
      username({
        minUsernameLength: ADMIN_USERNAME_MIN,
        maxUsernameLength: ADMIN_USERNAME_MAX,
        usernameValidator: (value) => ADMIN_USERNAME_PATTERN.test(value),
        validationOrder: { username: "post-normalization" },
      }),
      twoFactor({ issuer: APP_NAME }),
      passkey({
        rpID: passkeyOptions.rpId,
        rpName: APP_NAME,
        origin: passkeyOptions.origins,
      }),
    ],
  });
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
