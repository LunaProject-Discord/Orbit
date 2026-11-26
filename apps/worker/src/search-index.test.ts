/**
 * 検索用の文字列と検索の索引を裏で作る処理 (search-index.ts) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDb,
  type Database,
  mailAccounts,
  messageSearch,
  messages,
  users,
} from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSearchIndex } from "./search-index.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("検索の索引を裏で作る", () => {
  const dbName = `mail_search_index_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;

  const indexState = async () => {
    const result = await pool.query<{ valid: boolean }>(
      "select indisvalid as valid from pg_index where indexrelid = to_regclass('message_search_grams_idx')",
    );
    return result.rows[0]?.valid ?? null;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    ({ db, pool } = createDb(url.toString()));
    await db.execute(sql`do $$ begin
      if to_regproc('uuidv7') is null then
        create function uuidv7() returns uuid language sql volatile
          as 'select gen_random_uuid()';
      end if;
    end $$`);
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/db/drizzle", import.meta.url),
      ),
    });
    const [user] = await db
      .insert(users)
      .values({ email: "search@example.com", name: "search" })
      .returning({ id: users.id });
    const [account] = await db
      .insert(mailAccounts)
      .values({
        userId: user?.id as string,
        email: "me@example.com",
        provider: "generic",
        authType: "password",
        username: "me",
        credentialsEncrypted: "x",
        status: "disabled",
      })
      .returning({ id: mailAccounts.id });
    await db.insert(messages).values(
      Array.from({ length: 25 }, (_, index) => ({
        accountId: account?.id as string,
        threadKey: `t${index}`,
        subject: `件名 ${index}`,
        receivedAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
        bodyHtml: `<p>本文&#12354;${index}</p>`,
      })),
    );
  });

  afterAll(async () => {
    await pool?.end();
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await admin?.query(`drop database if exists ${dbName}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await admin?.end();
  });

  it("行の無いメールの分を作り、索引を作る", async () => {
    // マイグレーションより前に取り込んだメール (トリガーが作っていない) のつもりで、行を消しておく。
    await db.delete(messageSearch);
    expect(await indexState()).toBeNull();
    const logs: string[] = [];
    await buildSearchIndex(pool, {
      log: (message) => logs.push(message),
      batchSize: 10,
      pauseMs: 0,
    });
    const rows = await db.select().from(messageSearch);
    expect(rows).toHaveLength(25);
    expect(
      rows.every((row) =>
        row.doc.endsWith(`本文あ${row.doc.match(/件名(\d+)/)?.[1]}`),
      ),
    ).toBe(true);
    expect(await indexState()).toBe(true);
    expect(logs.at(-1)).toMatch(/検索の索引を作りました/);
  });

  it("そろっていれば、確かめるだけで終わる", async () => {
    const logs: string[] = [];
    await buildSearchIndex(pool, { log: (message) => logs.push(message) });
    expect(logs).toEqual([]);
  });

  it("作っている途中で止まった (使えない) 索引は、作り直す", async () => {
    await pool.query(
      "update pg_index set indisvalid = false where indexrelid = to_regclass('message_search_grams_idx')",
    );
    expect(await indexState()).toBe(false);
    await buildSearchIndex(pool, { log: () => {} });
    expect(await indexState()).toBe(true);
  });
});
