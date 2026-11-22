/**
 * 利用者のパスワードを付け直す (ログインできなくなったときの復旧用)。
 * メールを送れないサーバーや、認証アプリを失ったときに、サーバー上で実行する。
 *
 *   pnpm user:password <メールアドレス> [--reset-two-factor]
 *
 * パスワードは環境変数 USER_PASSWORD か、標準入力の 1 行目から読む
 * (コマンド履歴に残さないため、引数では受け取らない)。
 * --reset-two-factor を付けると、2 段階認証も解除する。
 * どちらの場合も、その利用者のすべての端末をログアウトさせる。
 */
import { createInterface } from "node:readline/promises";
import {
  authAccounts,
  createDb,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@mail/db";
import { and, eq, like } from "drizzle-orm";
import { createAuth } from "../auth.js";
import { loadEnv } from "../env.js";

const MIN_PASSWORD_LENGTH = 12;

const args = process.argv.slice(2);
const resetTwoFactor = args.includes("--reset-two-factor");
const [email] = args.filter((arg) => !arg.startsWith("--"));
if (!email) {
  console.error(
    "使い方: pnpm user:password <メールアドレス> [--reset-two-factor]",
  );
  process.exit(1);
}

async function readPassword(): Promise<string> {
  if (process.env.USER_PASSWORD) return process.env.USER_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(
      `新しいパスワード (${MIN_PASSWORD_LENGTH} 文字以上): `,
    );
  } finally {
    rl.close();
  }
}

const env = loadEnv();
const { db, pool } = createDb(env.databaseUrl);
const auth = createAuth({
  db,
  secret: env.authSecret,
  baseURL: env.publicUrl,
  trustedOrigins: env.allowedOrigins,
});

try {
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!user) {
    throw new Error(`利用者が見つかりません: ${email}`);
  }
  const password = await readPassword();
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`,
    );
  }
  const hash = await (await auth.$context).password.hash(password);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(authAccounts)
      .set({ password: hash })
      .where(
        and(
          eq(authAccounts.userId, user.id),
          eq(authAccounts.providerId, "credential"),
        ),
      )
      .returning({ id: authAccounts.id });
    if (updated.length === 0) {
      await tx.insert(authAccounts).values({
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: hash,
      });
    }
    if (resetTwoFactor) {
      await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
      await tx
        .update(users)
        .set({ twoFactorEnabled: false })
        .where(eq(users.id, user.id));
      // 「この端末では 30 日間コードを尋ねない」の印も無効にする。
      await tx
        .delete(verifications)
        .where(
          and(
            eq(verifications.value, user.id),
            like(verifications.identifier, "trust-device-%"),
          ),
        );
    }
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
  });
  console.log(
    `${user.email} のパスワードを変更しました。すべての端末がログアウトになります。`,
  );
  if (resetTwoFactor) console.log("2 段階認証を解除しました。");
} catch (error) {
  console.error(
    "パスワードを変更できませんでした:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
