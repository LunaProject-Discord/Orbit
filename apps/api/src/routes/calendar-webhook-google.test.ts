/**
 * Google カレンダーの変更通知の受け口を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type CalendarSyncNotification,
  googleCalendarChannelToken,
} from "@orbit/core";
import { accounts, calendars, createDb, type Database, users } from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { googleCalendarWebhookRoutes } from "./calendar-webhook-google.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("Google カレンダーの変更通知の受け口", () => {
  const dbName = `mail_google_webhook_${randomUUID().replaceAll("-", "")}`;
  const encryptionKey = randomBytes(32);
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let accountId: string;
  let calendarId: string;
  const channelId = randomUUID();
  const sent: CalendarSyncNotification[] = [];

  const post = (headers: Record<string, string>) =>
    googleCalendarWebhookRoutes({
      db,
      encryptionKey,
      notify: async (payload) => {
        sent.push(payload);
      },
    }).request("/", { method: "POST", headers });

  const valid = (overrides: Record<string, string> = {}) => ({
    "x-goog-channel-id": channelId,
    "x-goog-channel-token": googleCalendarChannelToken(
      encryptionKey,
      channelId,
    ),
    "x-goog-resource-id": "res-1",
    "x-goog-resource-state": "exists",
    "x-goog-message-number": "2",
    ...overrides,
  });

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
    const [user] = await db
      .insert(users)
      .values({ email: "hook@example.com", name: "hook" })
      .returning({ id: users.id });
    if (!user) throw new Error("利用者を作れませんでした。");
    const [account] = await db
      .insert(accounts)
      .values({
        userId: user.id,
        email: "hook@example.com",
        provider: "gmail",
        authType: "oauth2",
        username: "hook@example.com",
        credentialsEncrypted: "x",
        calendarEnabled: true,
      })
      .returning({ id: accounts.id });
    if (!account) throw new Error("アカウントを作れませんでした。");
    accountId = account.id;
    const [calendar] = await db
      .insert(calendars)
      .values({
        userId: user.id,
        accountId,
        source: "google",
        remoteId: "hook@example.com",
        name: "個人",
        pushChannelId: channelId,
        providerState: { pushResourceId: "res-1" },
      })
      .returning({ id: calendars.id });
    if (!calendar) throw new Error("カレンダーを作れませんでした。");
    calendarId = calendar.id;
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists ${dbName}`);
    await admin?.end();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it("チャンネルとトークンが合えば、そのカレンダーの同期を求める", async () => {
    const response = await post(valid());
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ accountId, calendarId, reason: "push" }]);
    await post(valid({ "x-goog-resource-state": "not_exists" }));
    expect(sent).toHaveLength(2);
  });

  it("チャンネルを作った合図 (sync) は伝えない", async () => {
    const response = await post(
      valid({ "x-goog-resource-state": "sync", "x-goog-message-number": "1" }),
    );
    expect(response.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("トークンが違う、知らないチャンネル、リソースが違う通知は、再送されない 200 で捨てる", async () => {
    expect(
      (await post(valid({ "x-goog-channel-token": "wrong" }))).status,
    ).toBe(200);
    const unknown = randomUUID();
    expect(
      (
        await post(
          valid({
            "x-goog-channel-id": unknown,
            "x-goog-channel-token": googleCalendarChannelToken(
              encryptionKey,
              unknown,
            ),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(valid({ "x-goog-resource-id": "res-other" }))).status,
    ).toBe(200);
    const headers = valid();
    delete (headers as Record<string, string>)["x-goog-channel-token"];
    expect((await post(headers)).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("必要なヘッダーが無い要求は 400", async () => {
    expect((await post({ "x-goog-resource-state": "exists" })).status).toBe(
      400,
    );
    expect((await post({ "x-goog-channel-id": channelId })).status).toBe(400);
    expect(sent).toEqual([]);
  });
});
