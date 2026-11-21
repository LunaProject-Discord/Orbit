import {
  authAccounts,
  type Database,
  sessions,
  users,
  verifications,
} from "@mail/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

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
};

export function createAuth({
  db,
  secret,
  baseURL,
  trustedOrigins,
  allowSignUp = false,
}: AuthOptions) {
  return betterAuth({
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
      },
    }),
    // 主キーは DB の uuidv7() に任せる。
    advanced: { database: { generateId: false } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: 12,
    },
    // Web / Tauri / Capacitor で同じ方式を使えるよう、セッショントークンを
    // Authorization: Bearer で受け付ける。
    plugins: [bearer()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
