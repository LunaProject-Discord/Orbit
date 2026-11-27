/**
 * 変更履歴の索引を裏で作る処理 (changes-index.ts) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, type Database } from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChangesIndex } from "./changes-index.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("変更履歴の索引を裏で作る", () => {
  const dbName = `mail_changes_index_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;

  const indexState = async () => {
    const result = await pool.query<{ valid: boolean }>(
      "select indisvalid as valid from pg_index where indexrelid = to_regclass('changes_delete_entity_idx')",
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
  }, 120_000);

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

  it("マイグレーションは索引を作らず、ワーカーが部分索引を作る", async () => {
    expect(await indexState()).toBeNull();
    const logs: string[] = [];
    await buildChangesIndex(pool, { log: (message) => logs.push(message) });
    expect(await indexState()).toBe(true);
    expect(logs.at(-1)).toMatch(/変更履歴の索引を作りました/);
    const def = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'changes_delete_entity_idx'",
    );
    expect(def.rows[0]?.indexdef).toMatch(/\(entity_id\)/);
    expect(def.rows[0]?.indexdef).toMatch(/WHERE \(op = 'delete'/);
  });

  it("そろっていれば、確かめるだけで終わる", async () => {
    const logs: string[] = [];
    await buildChangesIndex(pool, { log: (message) => logs.push(message) });
    expect(logs).toEqual([]);
  });

  it("作っている途中で止まった (使えない) 索引は、作り直す", async () => {
    await pool.query(
      "update pg_index set indisvalid = false where indexrelid = to_regclass('changes_delete_entity_idx')",
    );
    expect(await indexState()).toBe(false);
    await buildChangesIndex(pool, { log: () => {} });
    expect(await indexState()).toBe(true);
  });
});
