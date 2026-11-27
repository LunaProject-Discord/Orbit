/**
 * カレンダー用の認証 (createCalendarAuth) を確かめる。Microsoft のリフレッシュトークンの保存は
 * 実際の PostgreSQL で確かめる (DATABASE_URL が無い環境では実行しない)。
 */
import { decryptCredentials, encryptCredentials } from "@orbit/core";
import { accounts, type Database } from "@orbit/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CalendarAuthError } from "./provider.js";
import {
  createTestDatabase,
  insertAccount,
  insertUser,
  type TestDatabase,
} from "./testing/test-db.js";
import {
  createCalendarAuth,
  MICROSOFT_CALENDAR_REFRESH_SCOPES,
} from "./tokens.js";

const adminUrl = process.env.DATABASE_URL;
const key = Buffer.alloc(32, 7);
const microsoft = { clientId: "id", clientSecret: "secret", tenant: "common" };

/** トークンの更新に答える偽の fetch。送られた本文を記録する。 */
function tokenServer(
  response: Record<string, unknown>,
  status = 200,
): { fetchFn: typeof fetch; bodies: URLSearchParams[] } {
  const bodies: URLSearchParams[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

describe("createCalendarAuth (DB を使わないもの)", () => {
  it("パスワードの認証情報は、そのまま返す", () => {
    const userId = "u1";
    const auth = createCalendarAuth(
      null as unknown as Database,
      key,
      {
        userId,
        username: "me@icloud.com",
        provider: "icloud",
        protocol: "imap",
        credentialsEncrypted: encryptCredentials(
          { type: "password", password: "app-password" },
          key,
          userId,
        ),
      } as never,
      { google: null, microsoft: null },
    );
    expect(auth).toEqual({
      type: "password",
      username: "me@icloud.com",
      password: "app-password",
    });
  });

  it("Google の設定が無ければ CalendarAuthError を投げる", () => {
    const userId = "u1";
    expect(() =>
      createCalendarAuth(
        null as unknown as Database,
        key,
        {
          userId,
          provider: "gmail",
          protocol: "imap",
          credentialsEncrypted: encryptCredentials(
            { type: "oauth2", refreshToken: "rt" },
            key,
            userId,
          ),
        } as never,
        { google: null, microsoft: null },
      ),
    ).toThrow(CalendarAuthError);
  });
});

describe.skipIf(!adminUrl)("Microsoft のカレンダー用のトークン", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_caltokens");
    db = test.db;
    userId = await insertUser(db, "caltokens@example.com");
  });

  afterAll(async () => {
    await test?.drop();
  });

  const graphAccount = (mailEnabled: boolean) =>
    insertAccount(db, userId, {
      provider: "microsoft",
      protocol: "graph",
      mailEnabled,
      calendarEnabled: true,
      credentialsEncrypted: encryptCredentials(
        { type: "oauth2", refreshToken: "old-rt" },
        key,
        userId,
      ),
    });

  const storedToken = async (accountId: string) => {
    const [row] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId));
    const credentials = decryptCredentials(
      row?.credentialsEncrypted as string,
      key,
      userId,
    );
    return credentials.type === "oauth2" ? credentials.refreshToken : null;
  };

  it("カレンダーの権限で更新し、メール無しなら新しいリフレッシュトークンを保存する", async () => {
    const account = await graphAccount(false);
    const server = tokenServer({
      access_token: "at",
      refresh_token: "new-rt",
      expires_in: 3600,
    });
    const saved: string[] = [];
    const auth = createCalendarAuth(db, key, account, {
      google: null,
      microsoft,
      fetchFn: server.fetchFn,
      onCredentialsSaved: (value) => saved.push(value),
    });
    if (auth.type !== "oauth2") throw new Error("OAuth2 ではありません。");
    expect(await auth.getAccessToken()).toBe("at");
    expect(server.bodies[0]?.get("scope")).toBe(
      MICROSOFT_CALENDAR_REFRESH_SCOPES.join(" "),
    );
    expect(server.bodies[0]?.get("scope")).not.toContain("Mail.ReadWrite");
    expect(await storedToken(account.id)).toBe("new-rt");
    expect(saved).toHaveLength(1);
    // 期限内なら取り直さない。
    await auth.getAccessToken();
    expect(server.bodies).toHaveLength(1);
  });

  it("メールありなら、新しいリフレッシュトークンを保存しない", async () => {
    const account = await graphAccount(true);
    const server = tokenServer({
      access_token: "at",
      refresh_token: "new-rt",
      expires_in: 3600,
    });
    const auth = createCalendarAuth(db, key, account, {
      google: null,
      microsoft,
      fetchFn: server.fetchFn,
    });
    if (auth.type !== "oauth2") throw new Error("OAuth2 ではありません。");
    await auth.getAccessToken();
    expect(await storedToken(account.id)).toBe("old-rt");
  });

  it("同意が無ければ consentRequired の CalendarAuthError を投げる", async () => {
    const account = await graphAccount(false);
    const server = tokenServer(
      {
        error: "invalid_grant",
        error_description: "AADSTS65001: The user has not consented.",
      },
      400,
    );
    const auth = createCalendarAuth(db, key, account, {
      google: null,
      microsoft,
      fetchFn: server.fetchFn,
    });
    if (auth.type !== "oauth2") throw new Error("OAuth2 ではありません。");
    const error = await auth.getAccessToken().catch((value) => value);
    expect(error).toBeInstanceOf(CalendarAuthError);
    expect(error.consentRequired).toBe(true);
    expect(error.needsReauth).toBe(true);
  });
});
