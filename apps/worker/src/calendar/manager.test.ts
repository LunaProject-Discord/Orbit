/**
 * カレンダーの同期の起動と停止 (CalendarSyncManager) を、偽のプロバイダと実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import { accounts, calendars, type Database } from "@orbit/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CalendarSyncManager,
  calendarConnectionKey,
  calendarParkKey,
  UNSUPPORTED_CALENDAR_ERROR,
} from "./manager.js";
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

  describe("土台のレビューの指摘", () => {
    const pushed = (accountId: string) =>
      (providers.get(accountId)?.calls ?? []).filter(
        (call) => call.method === "stopPush",
      );

    it("指摘 8: Microsoft はリフレッシュトークンが入れ替わっても同期を作り直さない", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
        provider: "microsoft",
        protocol: "graph",
      });
      expect(
        calendarConnectionKey({ ...account, credentialsEncrypted: "z" }),
      ).toBe(calendarConnectionKey(account));
      // 止めた同期を起動し直すかの判断には、認証情報も含める (ログインし直しで起動する)。
      expect(
        calendarParkKey({ ...account, credentialsEncrypted: "z" }),
      ).not.toBe(calendarParkKey(account));
      const target = createManager();
      await target.reconcile();
      const before = target.syncFor(account.id);
      expect(before).toBeDefined();
      // メールの同期がリフレッシュトークンを入れ替えた。
      await db
        .update(accounts)
        .set({ credentialsEncrypted: "rotated" })
        .where(eq(accounts.id, account.id));
      await target.reconcile();
      expect(target.syncFor(account.id)).toBe(before);
    });

    it("指摘 8: Google は認証情報が変われば作り直す (これまでどおり)", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
      });
      const target = createManager();
      await target.reconcile();
      const before = target.syncFor(account.id);
      await db
        .update(accounts)
        .set({ credentialsEncrypted: "rotated" })
        .where(eq(accounts.id, account.id));
      await target.reconcile();
      expect(target.syncFor(account.id)).not.toBe(before);
    });

    it("指摘 10: calendarEnabled を切って同期を止めるとき、変更通知を止める", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
      });
      const target = createManager();
      await target.reconcile();
      await waitFor(async () => (await calendarCount(account.id)) === 1);
      await db
        .update(calendars)
        .set({ pushChannelId: "channel-1" })
        .where(eq(calendars.accountId, account.id));
      await db
        .update(accounts)
        .set({ calendarEnabled: false })
        .where(eq(accounts.id, account.id));
      await target.reconcile();
      expect(target.isRunning(account.id)).toBe(false);
      expect(pushed(account.id).map((call) => call.calendarRemoteId)).toEqual([
        "primary",
      ]);
    });

    it("指摘 10: アカウントが消えても、最後に読んだカレンダーの変更通知を止める", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
      });
      const target = createManager();
      await target.reconcile();
      await waitFor(async () => (await calendarCount(account.id)) === 1);
      await db
        .update(calendars)
        .set({ pushChannelId: "channel-1" })
        .where(eq(calendars.accountId, account.id));
      // 周回でカレンダーの行を読み直させる。
      target.notify({ accountId: account.id, reason: "refresh" });
      await waitFor(
        async () =>
          (providers.get(account.id)?.calls ?? []).filter(
            (call) => call.method === "listCalendars",
          ).length >= 2,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await db.delete(accounts).where(eq(accounts.id, account.id));
      await target.reconcile();
      expect(pushed(account.id)).toHaveLength(1);
    });

    it("指摘 10: カレンダーが一覧から消えたら、行を消す前に変更通知を止める", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
      });
      const target = createManager();
      await target.reconcile();
      await waitFor(async () => (await calendarCount(account.id)) === 1);
      await db
        .update(calendars)
        .set({ pushChannelId: "channel-1" })
        .where(eq(calendars.accountId, account.id));
      const provider = providers.get(account.id);
      if (!provider) throw new Error("プロバイダがありません。");
      provider.calendars = [];
      target.notify({ accountId: account.id, reason: "refresh" });
      await waitFor(async () => (await calendarCount(account.id)) === 0);
      expect(pushed(account.id).map((call) => call.calendarRemoteId)).toEqual([
        "primary",
      ]);
    });

    it("指摘 9: 同期が失敗しても lastSyncedAt は進めず、syncAttemptedAt を進める", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
      });
      const provider = new FakeCalendarProvider();
      provider.calendars = [
        {
          remoteId: "primary",
          name: "主のカレンダー",
          description: null,
          color: null,
          timeZone: "Asia/Tokyo",
          readOnly: false,
          url: null,
          defaultReminders: null,
          kind: "normal",
        },
      ];
      provider.enqueue("syncEvents", new Error("503 Service Unavailable"));
      providers.set(account.id, provider);
      const target = createManager();
      await target.reconcile();
      const calendarRow = async () => {
        const [row] = await db
          .select()
          .from(calendars)
          .where(eq(calendars.accountId, account.id));
        return row;
      };
      await waitFor(async () => (await calendarRow())?.lastError != null);
      const row = await calendarRow();
      expect(row?.lastSyncedAt).toBeNull();
      expect(row?.syncAttemptedAt).not.toBeNull();
    });

    it("指摘 12: 一時的な失敗では calendarError を書かない (止まった状態だけを表す)", async () => {
      const account = await insertAccount(db, userId, {
        calendarEnabled: true,
      });
      const provider = new FakeCalendarProvider();
      provider.enqueue("listCalendars", new Error("回線が切れました"));
      providers.set(account.id, provider);
      const messages: string[] = [];
      manager = new CalendarSyncManager(db, test.url, {
        encryptionKey: Buffer.alloc(32),
        google: null,
        microsoft: null,
        webhookBaseUrl: null,
        allowPrivateHosts: false,
        // ほかのテストのアカウントも起動するので、このアカウントにだけ失敗を返す。
        providerFor: (row) =>
          row.id === account.id ? provider : new FakeCalendarProvider(),
        createAuth: () => ({ type: "oauth2", getAccessToken: async () => "t" }),
        log: (message) => messages.push(message),
      });
      await manager.reconcile();
      await waitFor(async () =>
        messages.some(
          (message) =>
            message.includes(account.email) &&
            message.includes("回線が切れました"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await accountRow(account.id))?.calendarError).toBeNull();
    });
  });
});
