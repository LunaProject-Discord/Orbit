/**
 * 利用者を作成する。新規登録は API では受け付けていない (招待制) ため、
 * サーバー上でこのコマンドを実行して追加する。
 *
 *   pnpm user:create <メールアドレス> <表示名> [--admin]
 *
 * --admin を付けると管理者 (招待リンクを発行できる) にする。
 * まだ利用者が 1 人もいないときは、付けなくても管理者になる。
 *
 * パスワードは環境変数 USER_PASSWORD か、標準入力の 1 行目から読む
 * (コマンド履歴に残さないため、引数では受け取らない)。
 */
import { createInterface } from "node:readline/promises";
import { createDb, users } from "@mail/db";
import { count, eq } from "drizzle-orm";
import { createAuth } from "../auth.js";
import { loadEnv } from "../env.js";

const args = process.argv.slice(2);
const adminFlag = args.includes("--admin");
const [email, name] = args.filter((arg) => !arg.startsWith("--"));
if (!email || !name) {
  console.error("使い方: pnpm user:create <メールアドレス> <表示名> [--admin]");
  process.exit(1);
}

async function readPassword(): Promise<string> {
  if (process.env.USER_PASSWORD) return process.env.USER_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question("パスワード (12 文字以上): ");
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
  allowSignUp: true,
});

try {
  const password = await readPassword();
  const [existing] = await db.select({ total: count() }).from(users);
  const admin = adminFlag || (existing?.total ?? 0) === 0;
  const { user } = await auth.api.signUpEmail({
    body: { email, name, password },
  });
  if (admin) {
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.id));
  }
  console.log(
    `利用者を作成しました: ${user.email} (${user.id})${admin ? " [管理者]" : ""}`,
  );
} catch (error) {
  // DB に繋がらない場合などは、原因 (cause) の方に本当の理由が入っている。
  const cause = error instanceof Error ? error.cause : undefined;
  console.error(
    "利用者を作成できませんでした:",
    error instanceof Error ? error.message : error,
  );
  if (cause instanceof Error) {
    console.error(
      "原因:",
      cause.message || (cause as NodeJS.ErrnoException).code || cause.name,
    );
    console.error(
      "PostgreSQL が起動しているか (docker compose up -d)、pnpm db:migrate を実行済みかを確認してください。",
    );
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
