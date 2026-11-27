/**
 * 差出人のアイコンのキャッシュ (sender_icons) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, type Database } from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSenderIconService,
  type FetchBytes,
  type IconDeps,
  REFRESH_MIN_AGE_MS,
} from "./sender-icons.js";

const adminUrl = process.env.DATABASE_URL;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

describe.skipIf(!adminUrl)("差出人のアイコンのキャッシュ", () => {
  const dbName = `mail_sender_icons_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client | undefined;
  let db: Database;
  let pool: pg.Pool | undefined;

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
        new URL("../../../../packages/db/drizzle", import.meta.url),
      ),
    });
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

  it("更新 (refresh) では、1 時間より古ければ期限内でも取り直す", async () => {
    let time = Date.parse("2026-11-27T00:00:00Z");
    let requests = 0;
    const fetchBytes: FetchBytes = async (url) => {
      if (!url.endsWith("/favicon.ico")) return null;
      requests++;
      return { contentType: "image/png", body: PNG, url };
    };
    const deps: IconDeps = {
      fetchBytes,
      resolveTxt: async () => [],
    };
    const service = createSenderIconService(db, deps, () => time);
    const find = (refresh: boolean) =>
      service.find("info@shop.example.com", ["favicon"], { refresh });

    expect((await find(false))?.source).toBe("favicon");
    expect(requests).toBe(1);
    // 期限内なら、通常は覚えているものを使う。
    time += REFRESH_MIN_AGE_MS + 1;
    await find(false);
    expect(requests).toBe(1);
    // 更新なら取り直す。
    await find(true);
    expect(requests).toBe(2);
    // 取り直したばかりなら、更新を続けて押されても取り直さない。
    time += 60_000;
    await find(true);
    expect(requests).toBe(2);
  });
});
