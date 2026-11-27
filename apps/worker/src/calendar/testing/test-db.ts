import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { accounts, calendars, createDb, type Database, users } from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * テスト用の一時データベース。DATABASE_URL のサーバーに使い捨てのデータベースを作り、
 * マイグレーションを当てる。テストの中だけで使う (本番のコードからは import しない)。
 */
export type TestDatabase = {
  db: Database;
  pool: pg.Pool;
  /** 一時データベースへの接続文字列 (LISTEN を使うテスト向け)。 */
  url: string;
  drop(): Promise<void>;
};

export async function createTestDatabase(
  adminUrl: string,
  prefix: string,
): Promise<TestDatabase> {
  const dbName = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const { db, pool } = createDb(url.toString());
  // PostgreSQL 16 には uuidv7 が無いので、代わりの関数を作る。
  await db.execute(sql`do $$ begin
    if to_regproc('uuidv7') is null then
      create function uuidv7() returns uuid language sql volatile
        as 'select gen_random_uuid()';
    end if;
  end $$`);
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../../../../packages/db/drizzle", import.meta.url),
    ),
  });
  return {
    db,
    pool,
    url: url.toString(),
    async drop() {
      await pool.end().catch(() => {});
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    },
  };
}

/** 利用者を 1 人作る。 */
export async function insertUser(db: Database, email: string) {
  const [user] = await db
    .insert(users)
    .values({ email, name: email })
    .returning({ id: users.id });
  if (!user) throw new Error("利用者を作れませんでした。");
  return user.id;
}

/** アカウントを 1 件作る。指定しない列は Gmail (OAuth2) の既定。 */
export async function insertAccount(
  db: Database,
  userId: string,
  overrides: Partial<typeof accounts.$inferInsert> = {},
) {
  const email = overrides.email ?? `${randomUUID().slice(0, 8)}@example.com`;
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      email,
      provider: "gmail",
      authType: "oauth2",
      username: email,
      credentialsEncrypted: "x",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("アカウントを作れませんでした。");
  return row;
}

/** アカウントのカレンダーを 1 つ作る。 */
export async function insertCalendar(
  db: Database,
  userId: string,
  accountId: string,
  overrides: Partial<typeof calendars.$inferInsert> = {},
) {
  const [row] = await db
    .insert(calendars)
    .values({
      userId,
      accountId,
      source: "google",
      remoteId: `cal-${randomUUID().slice(0, 8)}`,
      name: "カレンダー",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("カレンダーを作れませんでした。");
  return row;
}
