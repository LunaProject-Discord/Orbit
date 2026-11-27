/**
 * ICS の購読の取得し直しを、実際の PostgreSQL で確かめる。DATABASE_URL が無い環境では実行しない。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calendars, createDb, type Database, events, users } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshDueSubscriptions } from "./calendar-subscriptions.js";

const adminUrl = process.env.DATABASE_URL;

const feed = (summary: string) =>
  [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one",
    "DTSTART;VALUE=DATE:20261201",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

describe.skipIf(!adminUrl)("ICS の購読", () => {
  const dbName = `mail_ics_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let userId: string;

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
      .values({ email: "ics@example.com", name: "ics" })
      .returning({ id: users.id });
    userId = user?.id as string;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName}`);
    await admin?.end();
  });

  it("時期が来た購読だけを取得し、失敗したら理由を残して予定は消さない", async () => {
    const now = new Date("2026-12-01T00:00:00Z");
    const [due, fresh] = await db
      .insert(calendars)
      .values([
        {
          userId,
          source: "ics",
          name: "時期が来た",
          url: "https://a.example.com/a.ics",
          lastSyncedAt: new Date(now.getTime() - 2 * 3600_000),
        },
        {
          userId,
          source: "ics",
          name: "まだ",
          url: "https://b.example.com/b.ics",
          pollIntervalSeconds: 86_400,
          lastSyncedAt: new Date(now.getTime() - 2 * 3600_000),
        },
      ])
      .returning();
    const requested: string[] = [];
    let response: () => Response = () => new Response(feed("一回目"));
    const fetchImpl = (async (url: string) => {
      requested.push(url);
      return response();
    }) as unknown as typeof fetch;

    expect(
      await refreshDueSubscriptions(db, { allowPrivate: true, now, fetchImpl }),
    ).toBe(1);
    expect(requested).toEqual(["https://a.example.com/a.ics"]);
    const rows = () =>
      db
        .select({ summary: events.summary })
        .from(events)
        .where(eq(events.calendarId, due?.id as string));
    expect(await rows()).toEqual([{ summary: "一回目" }]);

    // 1 時間たてば、また取りに行く。失敗しても予定は残す。
    response = () => new Response("", { status: 500 });
    const later = new Date(now.getTime() + 3600_000);
    await refreshDueSubscriptions(db, {
      allowPrivate: true,
      now: later,
      fetchImpl,
    });
    expect(await rows()).toEqual([{ summary: "一回目" }]);
    const [after] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, due?.id as string));
    expect(after?.lastError).toBe("取得できませんでした (HTTP 500)。");
    expect(after?.lastSyncedAt).toEqual(later);
    expect(fresh?.lastSyncedAt).toEqual(new Date(now.getTime() - 2 * 3600_000));
  });
});
