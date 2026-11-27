/**
 * サーバーの管理者 (管理画面 /admin にログインするアカウント) を扱う。
 * 管理者は一般の利用者とは別のアカウントで、メールは持たない。
 *
 *   pnpm admin create <名前> <表示名>                 管理者を作る
 *   pnpm admin password <名前> [--reset-two-factor]   パスワードを付け直す (復旧用。パスキーも消す)
 *   pnpm admin list                                   管理者の一覧
 *   pnpm admin delete <名前>                          管理者を消す
 *
 * 本番 (Docker) では `docker compose run --rm api node apps/api/dist/cli/admin.js create <名前> <表示名>`。
 * パスワードは環境変数 ADMIN_PASSWORD か、標準入力の 1 行目から読む
 * (コマンド履歴に残さないため、引数では受け取らない)。
 */
import { createInterface } from "node:readline/promises";
import {
  adminAuthAccounts,
  adminPasskeys,
  adminSessions,
  adminTwoFactors,
  adminUsers,
  adminVerifications,
  createDb,
} from "@orbit/db";
import { and, asc, eq, like } from "drizzle-orm";
import { ADMIN_MIN_PASSWORD_LENGTH, createAdminAuth } from "../admin-auth.js";
import { loadEnv } from "../env.js";
import { createAdmin } from "../routes/admin.js";

const USAGE = [
  "使い方:",
  "  admin create <名前> <表示名>",
  "  admin password <名前> [--reset-two-factor]",
  "  admin list",
  "  admin delete <名前>",
].join("\n");

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const [command, ...rest] = args.filter((arg) => !arg.startsWith("--"));

async function readPassword(prompt: string): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

const CREATE_ERRORS = {
  invalid_username: `名前は 3〜32 文字の英小文字・数字・「_」「.」「-」にしてください。`,
  invalid_name: "表示名は 1〜100 文字にしてください。",
  password_too_short: `パスワードは ${ADMIN_MIN_PASSWORD_LENGTH} 文字以上にしてください。`,
  password_too_long: "パスワードは 128 文字以下にしてください。",
  username_taken: "その名前の管理者は、すでにいます。",
} as const;

const env = loadEnv();
const { db, pool } = createDb(env.databaseUrl);
const authOptions = {
  db,
  secret: env.authSecret,
  baseURL: env.publicUrl,
  trustedOrigins: env.allowedOrigins,
};

async function findAdmin(name: string | undefined) {
  if (!name) throw new Error(USAGE);
  const [admin] = await db
    .select({ id: adminUsers.id, username: adminUsers.username })
    .from(adminUsers)
    .where(eq(adminUsers.username, name.trim().toLowerCase()));
  if (!admin) throw new Error(`管理者が見つかりません: ${name}`);
  return admin;
}

async function create() {
  const [username, name] = rest;
  if (!username || !name) throw new Error(USAGE);
  const password = await readPassword(
    `パスワード (${ADMIN_MIN_PASSWORD_LENGTH} 文字以上): `,
  );
  const result = await createAdmin(
    db,
    createAdminAuth({ ...authOptions, allowSignUp: true }),
    { username, name, password },
  );
  if (!result.ok) throw new Error(CREATE_ERRORS[result.error]);
  console.log(
    `管理者を作りました: ${result.username}。Web の /admin からログインしてください。`,
  );
}

async function setPassword() {
  const admin = await findAdmin(rest[0]);
  const password = await readPassword(
    `新しいパスワード (${ADMIN_MIN_PASSWORD_LENGTH} 文字以上): `,
  );
  if (password.length < ADMIN_MIN_PASSWORD_LENGTH) {
    throw new Error(CREATE_ERRORS.password_too_short);
  }
  if (password.length > 128) throw new Error(CREATE_ERRORS.password_too_long);
  const auth = createAdminAuth(authOptions);
  const hash = await (await auth.$context).password.hash(password);
  const resetTwoFactor = flags.has("--reset-two-factor");
  const removedPasskeys = await db.transaction(async (tx) => {
    const updated = await tx
      .update(adminAuthAccounts)
      .set({ password: hash })
      .where(
        and(
          eq(adminAuthAccounts.userId, admin.id),
          eq(adminAuthAccounts.providerId, "credential"),
        ),
      )
      .returning({ id: adminAuthAccounts.id });
    if (updated.length === 0) {
      await tx.insert(adminAuthAccounts).values({
        userId: admin.id,
        accountId: admin.id,
        providerId: "credential",
        password: hash,
      });
    }
    if (resetTwoFactor) {
      await tx
        .delete(adminTwoFactors)
        .where(eq(adminTwoFactors.userId, admin.id));
      await tx
        .update(adminUsers)
        .set({ twoFactorEnabled: false })
        .where(eq(adminUsers.id, admin.id));
      await tx
        .delete(adminVerifications)
        .where(
          and(
            eq(adminVerifications.value, admin.id),
            like(adminVerifications.identifier, "trust-device-%"),
          ),
        );
    }
    await tx.delete(adminSessions).where(eq(adminSessions.userId, admin.id));
    // 乗っ取られたときの復旧で使うので、パスキーも消す (盗んだトークンで登録されたものが残らないように)。
    const passkeys = await tx
      .delete(adminPasskeys)
      .where(eq(adminPasskeys.userId, admin.id))
      .returning({ id: adminPasskeys.id });
    return passkeys.length;
  });
  console.log(
    `${admin.username} のパスワードを変更しました。すべての端末がログアウトになります。`,
  );
  if (resetTwoFactor) console.log("2 段階認証を解除しました。");
  if (removedPasskeys > 0) {
    console.log(
      `パスキーを ${removedPasskeys} 件削除しました。必要なら、ログインし直してから登録し直してください。`,
    );
  }
}

async function list() {
  const rows = await db
    .select({
      username: adminUsers.username,
      name: adminUsers.name,
      twoFactorEnabled: adminUsers.twoFactorEnabled,
      createdAt: adminUsers.createdAt,
    })
    .from(adminUsers)
    .orderBy(asc(adminUsers.createdAt));
  if (rows.length === 0) {
    console.log("管理者はまだいません。");
    return;
  }
  for (const row of rows) {
    console.log(
      `${row.username}\t${row.name}\t2 段階認証: ${row.twoFactorEnabled ? "あり" : "なし"}\t${row.createdAt.toISOString()}`,
    );
  }
}

async function remove() {
  const admin = await findAdmin(rest[0]);
  await db.delete(adminUsers).where(eq(adminUsers.id, admin.id));
  console.log(`管理者 ${admin.username} を消しました。`);
}

try {
  switch (command) {
    case "create":
      await create();
      break;
    case "password":
      await setPassword();
      break;
    case "list":
      await list();
      break;
    case "delete":
      await remove();
      break;
    default:
      throw new Error(USAGE);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
