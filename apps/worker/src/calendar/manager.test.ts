/**
 * カレンダーの同期の起動と停止 (CalendarSyncManager) を、偽のプロバイダと実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import { accounts, calendars, type Database } from "@orbit/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CalendarSyncManager, UNSUPPORTED_CALENDAR_ERROR } from "./manager.js";
import { CalendarAuthError } from "./provider.js";
import { FakeCalendarProvider } from "./testing/fake-provider.js";
import {
  createTestDatabase,
  insertAccount,
  insertUser,
  type TestDatabase,
} from "./testing/test-db.js";

const adminUrl = process.env.DATABASE_URL;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("待ち時間を過ぎました。");
}

describe.skipIf(!adminUrl)("CalendarSyncManager", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let manager: CalendarSyncManager | null = null;
  const providers = new Map<string, FakeCalendarProvider>();

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_calmanager");
    db = test.db;
    userId = await insertUser(db, "calmanager@example.com");
  });

  afterEach(async () => {
    await manager?.stop();
    manager = null;
  });

  afterAll(async () => {
    await test?.drop();
  });

  /** アカウントごとに偽のプロバイダを返す manager。provider が null のアカウントは未対応。 */
  const createManager = (unsupported: Set<string> = new Set()) => {
    manager = new CalendarSyncManager(db, test.url, {
      encryptionKey: Buffer.alloc(32),
      google: null,
      microsoft: null,
      webhookBaseUrl: null,
      allowPrivateHosts: false,
      providerFor: (account) => {
        if (unsupported.has(account.id)) return null;
        let provider = providers.get(account.id);
        if (!provider) {
          provider = new FakeCalendarProvider();
          provider.calendars = [
            {
              remoteId: "primary",
              name: "主のカレンダー",
              description: null,
              color: "#336699",
              timeZone: "Asia/Tokyo",
              readOnly: false,
              url: null,
              defaultReminders: null,
              kind: "normal",
            },
          ];
          providers.set(account.id, provider);
        }
        return provider;
      },
      createAuth: () => ({ type: "oauth2", getAccessToken: async () => "t" }),
      log: () => {},
    });
    return manager;
  };

  const calendarCount = async (accountId: string) =>
    (
      await db
        .select({ id: calendars.id })
        .from(calendars)
        .where(eq(calendars.accountId, accountId))
    ).length;

  const accountRow = async (accountId: string) => {
    const [row] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return row;
  };

  it("calendarEnabled を切り替えると、起動と停止をする", async () => {
    const account = await insertAccount(db, userId, { calendarEnabled: true });
    const disabled = await insertAccount(db, userId, {
      calendarEnabled: false,
    });
    const target = createManager();
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(true);
    expect(target.isRunning(disabled.id)).toBe(false);
    // 一覧を取り込み、予定の同期まで進む。
    await waitFor(async () => (await calendarCount(account.id)) === 1);
    await waitFor(async () =>
      (providers.get(account.id)?.calls ?? []).some(
        (call) => call.method === "syncEvents",
      ),
    );

    await db
      .update(accounts)
      .set({ calendarEnabled: false })
      .where(eq(accounts.id, account.id));
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(false);
  });

  it("メールを使わないアカウントでも起動する", async () => {
    const account = await insertAccount(db, userId, {
      calendarEnabled: true,
      mailEnabled: false,
    });
    const target = createManager();
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(true);
    await waitFor(async () => (await calendarCount(account.id)) === 1);
  });

  it("プロバイダが無いアカウントは起動せず、calendarError に未対応と書く", async () => {
    const account = await insertAccount(db, userId, {
      calendarEnabled: true,
      provider: "generic",
      authType: "password",
    });
    const target = createManager(new Set([account.id]));
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(false);
    expect((await accountRow(account.id))?.calendarError).toBe(
      UNSUPPORTED_CALENDAR_ERROR,
    );
  });

  it("認証の失敗で止まり、メール無しなら auth_required にする。認証情報が変わるまで起動しない", async () => {
    const account = await insertAccount(db, userId, {
      calendarEnabled: true,
      mailEnabled: false,
      oauthScopes:
        "openid email https://www.googleapis.com/auth/calendar.events",
    });
    const provider = new FakeCalendarProvider();
    provider.enqueue(
      "listCalendars",
      new CalendarAuthError("スコープが足りません", { consentRequired: true }),
    );
    providers.set(account.id, provider);
    const target = createManager();
    await target.reconcile();
    await waitFor(async () => !target.isRunning(account.id));
    const row = await accountRow(account.id);
    expect(row?.calendarError).toBe("スコープが足りません");
    expect(row?.oauthScopes).toBe("openid email");
    // 同意が要るだけなので、メール無しでも auth_required にはしない。
    expect(row?.status).toBe("active");
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(false);

    // 再同意で認証情報が変わったら、起動し直す。
    await db
      .update(accounts)
      .set({ credentialsEncrypted: "y", oauthScopes: "openid email calendar" })
      .where(eq(accounts.id, account.id));
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(true);
  });

  it("メール無しのアカウントで再ログインが必要なら auth_required にする", async () => {
    const account = await insertAccount(db, userId, {
      calendarEnabled: true,
      mailEnabled: false,
    });
    const provider = new FakeCalendarProvider();
    provider.enqueue(
      "listCalendars",
      new CalendarAuthError("失効しました", { needsReauth: true }),
    );
    providers.set(account.id, provider);
    const target = createManager();
    await target.reconcile();
    await waitFor(
      async () => (await accountRow(account.id))?.status === "auth_required",
    );
    await target.reconcile();
    expect(target.isRunning(account.id)).toBe(false);
  });

  it("書き戻しの通知で、待たずに outbox を処理する", async () => {
    const account = await insertAccount(db, userId, { calendarEnabled: true });
    const target = createManager();
    await target.reconcile();
    await waitFor(async () =>
      (providers.get(account.id)?.calls ?? []).some(
        (call) => call.method === "syncEvents",
      ),
    );
    const before = providers.get(account.id)?.calls.length ?? 0;
    target.notify({ accountId: account.id, reason: "refresh" });
    await waitFor(
      async () =>
        (providers.get(account.id)?.calls.length ?? 0) > before &&
        (providers.get(account.id)?.calls ?? [])
          .slice(before)
          .some((call) => call.method === "syncEvents"),
    );
  });
});
