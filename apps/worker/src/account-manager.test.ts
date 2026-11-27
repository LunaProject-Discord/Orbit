/**
 * メールの同期の対象 (mailSyncAccounts) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import type { Database } from "@orbit/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailSyncAccounts } from "./account-manager.js";
import {
  createTestDatabase,
  insertAccount,
  insertUser,
  type TestDatabase,
} from "./calendar/testing/test-db.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("mailSyncAccounts", () => {
  let test: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_mailsync");
    db = test.db;
  });

  afterAll(async () => {
    await test?.drop();
  });

  it("メールを使うアカウント (active と error) だけを返す", async () => {
    const userId = await insertUser(db, "mailsync@example.com");
    const active = await insertAccount(db, userId);
    const failing = await insertAccount(db, userId, { status: "error" });
    const calendarOnly = await insertAccount(db, userId, {
      mailEnabled: false,
      calendarEnabled: true,
    });
    const reauth = await insertAccount(db, userId, {
      status: "auth_required",
    });
    const ids = (await mailSyncAccounts(db)).map((row) => row.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(failing.id);
    expect(ids).not.toContain(calendarOnly.id);
    expect(ids).not.toContain(reauth.id);
  });
});
