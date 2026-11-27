/**
 * アカウントのカレンダーの設定 (calendarEnabled / mailEnabled の切り替え、OAuth の権限の記録) を、
 * 実際の PostgreSQL で確かめる。DATABASE_URL が無い環境では実行しない。
 * 接続先に確認用の DB を作り、終わったら消す。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_ACCOUNTS,
  encryptCredentials,
  GMAIL_SCOPE,
  GOOGLE_CALENDAR_SCOPES,
  MICROSOFT_CALENDAR_SCOPES,
  MICROSOFT_SCOPES,
} from "@orbit/core";
import { accounts, createDb, type Database, users } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { accountRoutes, calendarConsentOf } from "./accounts.js";

const adminUrl = process.env.DATABASE_URL;

type Json = Record<string, unknown>;

describe("calendarConsentOf", () => {
  const google = GOOGLE_CALENDAR_SCOPES.join(" ");
  const microsoft = MICROSOFT_CALENDAR_SCOPES.join(" ");
  it.each([
    ["gmail", "oauth2", "imap", `${GMAIL_SCOPE} ${google}`, "granted"],
    ["gmail", "oauth2", "imap", GMAIL_SCOPE, "required"],
    ["gmail", "oauth2", "imap", null, "required"],
    // アプリ パスワードの Gmail は、Google でのログインへの切り替えが要る。
    ["gmail", "password", "imap", null, "required"],
    ["microsoft", "oauth2", "graph", microsoft, "granted"],
    ["microsoft", "oauth2", "graph", MICROSOFT_SCOPES.join(" "), "required"],
    ["icloud", "password", "imap", null, "not_applicable"],
    ["generic", "password", "pop3", null, "not_applicable"],
  ] as const)("%s / %s / %s / %s → %s", (provider, authType, protocol, oauthScopes, expected) => {
    expect(
      calendarConsentOf({ provider, authType, protocol, oauthScopes }),
    ).toBe(expected);
  });
});

describe.skipIf(!adminUrl)("アカウントのカレンダーの設定", () => {
  const dbName = `mail_account_calendar_${randomUUID().replaceAll("-", "")}`;
  const encryptionKey = randomBytes(32);
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: Hono<AppEnv>;
  let userId: string;
  let listener: pg.Client;
  const notified: string[] = [];

  /** トークンの引き換えで返す scope と、プロフィールのメールアドレス。 */
  let tokenScope = "";
  let profileEmail = "";

  const request = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };

  const addAccount = async (
    overrides: Partial<typeof accounts.$inferInsert>,
  ) => {
    const [row] = await db
      .insert(accounts)
      .values({
        userId,
        email: `${randomUUID()}@example.com`,
        provider: "generic",
        authType: "password",
        imapHost: "imap.example.com",
        imapPort: 993,
        username: "user",
        credentialsEncrypted: encryptCredentials(
          { type: "password", password: "p" },
          encryptionKey,
          userId,
        ),
        ...overrides,
      })
      .returning({ id: accounts.id });
    if (!row) throw new Error("アカウントを作れませんでした。");
    return row.id;
  };

  /** LISTEN の通知が届くのを待つ (NOTIFY はコミット後に非同期で届く)。 */
  const waitNotified = async (id: string) => {
    for (let i = 0; i < 50 && !notified.includes(id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return notified.includes(id);
  };

  /** authorize が返したログイン画面の URL から、state と scope を取り出す。 */
  const authorize = async (provider: "google" | "microsoft", body: Json) => {
    const result = await request(
      "POST",
      `/accounts/${provider}/authorize`,
      body,
    );
    expect(result.status).toBe(200);
    const url = new URL(result.body.url as string);
    return {
      state: url.searchParams.get("state") as string,
      scope: url.searchParams.get("scope") as string,
    };
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
        new URL("../../../../packages/db/drizzle", import.meta.url),
      ),
    });
    const [user] = await db
      .insert(users)
      .values({ email: "owner@example.com", name: "owner" })
      .returning({ id: users.id });
    if (!user) throw new Error("利用者を作れませんでした。");
    userId = user.id;

    listener = new pg.Client({ connectionString: url.toString() });
    await listener.connect();
    listener.on("notification", (message) => {
      if (message.channel === CHANNEL_ACCOUNTS && message.payload) {
        notified.push(message.payload);
      }
    });
    await listener.query(`listen ${CHANNEL_ACCOUNTS}`);

    // トークンの引き換えとプロフィールの取得を、ネットワークに出さずに返す。
    const fetchImpl = (async (input: string | URL | Request) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.includes("/token")) {
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: tokenScope,
        });
      }
      if (target.includes("graph.microsoft.com/v1.0/me")) {
        return Response.json({ mail: profileEmail, displayName: "Me" });
      }
      if (target.includes("openidconnect.googleapis.com")) {
        return Response.json({ email: profileEmail });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("user", { id: userId, email: "owner@example.com", name: "owner" });
      await next();
    });
    app.route(
      "/accounts",
      accountRoutes(
        {
          db,
          encryptionKey,
          allowPrivateMailHosts: true,
          microsoft: {
            config: {
              clientId: "id",
              clientSecret: "secret",
              tenant: "common",
            },
            redirectUri: "https://web.example/oauth/microsoft",
          },
          google: {
            config: { clientId: "id", clientSecret: "secret" },
            redirectUri: "https://web.example/oauth/google",
          },
        },
        {
          fetchImpl,
          verifyImap: async () => ({ ok: true }),
          verifyPop3: async () => ({ ok: true }),
          verifySmtp: async () => ({ ok: true }),
        },
      ),
    );
  }, 120_000);

  beforeEach(() => {
    notified.length = 0;
  });

  afterAll(async () => {
    await listener?.end();
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

  it("一覧に、メールとカレンダーの設定と同意の状態を返す (権限そのものは返さない)", async () => {
    const id = await addAccount({ provider: "icloud" });
    const list = await request("GET", "/accounts");
    const row = (list.body.accounts as Json[]).find((value) => value.id === id);
    expect(row).toMatchObject({
      mailEnabled: true,
      calendarEnabled: false,
      calendarError: null,
      calendarConsent: "not_applicable",
    });
    expect(row).not.toHaveProperty("oauthScopes");
    expect(row).not.toHaveProperty("credentialsEncrypted");
  });

  it("カレンダーの権限が無い Gmail と Microsoft は、カレンダーをオンにできない (409)", async () => {
    const gmail = await addAccount({
      provider: "gmail",
      authType: "oauth2",
      oauthScopes: GMAIL_SCOPE,
    });
    const graph = await addAccount({
      provider: "microsoft",
      authType: "oauth2",
      protocol: "graph",
      imapHost: null,
      oauthScopes: null,
    });
    const appPassword = await addAccount({ provider: "gmail" });
    for (const id of [gmail, graph, appPassword]) {
      const result = await request("PATCH", `/accounts/${id}`, {
        calendarEnabled: true,
      });
      expect(result).toEqual({
        status: 409,
        body: { error: "consent_required" },
      });
    }
    const [row] = await db
      .select({ calendarEnabled: accounts.calendarEnabled })
      .from(accounts)
      .where(eq(accounts.id, gmail));
    expect(row?.calendarEnabled).toBe(false);
    expect(notified).toEqual([]);
    // オフにするのは、権限が無くてもできる。
    expect(
      (await request("PATCH", `/accounts/${gmail}`, { calendarEnabled: false }))
        .status,
    ).toBe(200);
  });

  it("切り替えると同期ワーカーへ知らせる。値が変わらなければ知らせない", async () => {
    const id = await addAccount({
      provider: "gmail",
      authType: "oauth2",
      oauthScopes: `${GMAIL_SCOPE} ${GOOGLE_CALENDAR_SCOPES.join(" ")}`,
      calendarError: "前の失敗",
    });
    const on = await request("PATCH", `/accounts/${id}`, {
      calendarEnabled: true,
      mailEnabled: false,
    });
    expect(on.status).toBe(200);
    expect(on.body.account).toMatchObject({
      mailEnabled: false,
      calendarEnabled: true,
      calendarConsent: "granted",
      calendarError: "前の失敗",
    });
    expect(await waitNotified(id)).toBe(true);

    notified.length = 0;
    const same = await request("PATCH", `/accounts/${id}`, {
      calendarEnabled: true,
    });
    expect(same.status).toBe(200);
    // 変わらない切り替えでは知らせない (先に届く別の通知が無いことを、少し待って確かめる)。
    expect(await waitNotified(id)).toBe(false);

    const off = await request("PATCH", `/accounts/${id}`, {
      calendarEnabled: false,
    });
    expect(off.body.account).toMatchObject({
      calendarEnabled: false,
      calendarError: null,
    });
    expect(await waitNotified(id)).toBe(true);
  });

  it("メールの接続先が無いアカウントでは、メールをオンにできない", async () => {
    const id = await addAccount({
      provider: "generic",
      imapHost: null,
      mailEnabled: false,
    });
    const result = await request("PATCH", `/accounts/${id}`, {
      mailEnabled: true,
    });
    expect(result).toEqual({
      status: 409,
      body: { error: "mail_unavailable" },
    });
    expect(
      (
        await request("PATCH", `/accounts/${randomUUID()}`, {
          mailEnabled: true,
        })
      ).status,
    ).toBe(404);
  });

  it("Microsoft: カレンダーの権限を求めてログインすると、権限を保存してカレンダーをオンにする", async () => {
    const { state, scope } = await authorize("microsoft", { calendar: true });
    expect(scope.split(" ")).toEqual(
      expect.arrayContaining(MICROSOFT_CALENDAR_SCOPES),
    );
    profileEmail = "me@outlook.example";
    tokenScope = [...MICROSOFT_SCOPES, ...MICROSOFT_CALENDAR_SCOPES].join(" ");
    const result = await request("POST", "/accounts/microsoft/complete", {
      code: "code",
      state,
    });
    expect(result.status).toBe(201);
    expect(result.body.calendarGranted).toBe(true);
    expect(result.body.account).toMatchObject({
      calendarEnabled: true,
      calendarConsent: "granted",
    });
    const id = (result.body.account as Json).id as string;
    const [row] = await db
      .select({ oauthScopes: accounts.oauthScopes })
      .from(accounts)
      .where(eq(accounts.id, id));
    expect(row?.oauthScopes).toBe(tokenScope);
    expect(await waitNotified(id)).toBe(true);

    // カレンダーを使っているアカウントの再ログインは、指定が無くてもカレンダーの権限を求める。
    const again = await authorize("microsoft", { accountId: id });
    expect(again.scope.split(" ")).toEqual(
      expect.arrayContaining(MICROSOFT_CALENDAR_SCOPES),
    );
  });

  it("Google: カレンダーの権限を外されたら、メールだけで追加して calendarGranted: false を返す", async () => {
    const { state, scope } = await authorize("google", { calendar: true });
    expect(scope.split(" ")).toEqual(
      expect.arrayContaining(GOOGLE_CALENDAR_SCOPES),
    );
    profileEmail = "me@gmail.example";
    tokenScope = `openid email ${GMAIL_SCOPE}`;
    const result = await request("POST", "/accounts/google/complete", {
      code: "code",
      state,
    });
    expect(result.status).toBe(201);
    expect(result.body.calendarGranted).toBe(false);
    expect(result.body.account).toMatchObject({
      calendarEnabled: false,
      calendarConsent: "required",
    });
    const id = (result.body.account as Json).id as string;

    // 同意し直すと、同じアカウントの権限を入れ替えてカレンダーをオンにする。
    const retry = await authorize("google", { accountId: id, calendar: true });
    tokenScope = `openid email ${GMAIL_SCOPE} ${GOOGLE_CALENDAR_SCOPES.join(" ")}`;
    const relogin = await request("POST", "/accounts/google/complete", {
      code: "code",
      state: retry.state,
    });
    expect(relogin.status).toBe(200);
    expect(relogin.body.calendarGranted).toBe(true);
    expect(relogin.body.account).toMatchObject({
      id,
      calendarEnabled: true,
      calendarConsent: "granted",
    });
    const [row] = await db
      .select({ oauthScopes: accounts.oauthScopes })
      .from(accounts)
      .where(eq(accounts.id, id));
    expect(row?.oauthScopes).toBe(tokenScope);
  });

  it("カレンダーを求めずにログインしたときは、calendarEnabled を変えない", async () => {
    const { state, scope } = await authorize("google", {});
    expect(scope.split(" ")).not.toEqual(
      expect.arrayContaining(GOOGLE_CALENDAR_SCOPES),
    );
    profileEmail = "plain@gmail.example";
    tokenScope = `openid email ${GMAIL_SCOPE}`;
    const result = await request("POST", "/accounts/google/complete", {
      code: "code",
      state,
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      calendarGranted: false,
      calendarRequested: false,
      calendarDisabled: false,
      account: { calendarEnabled: false, mailEnabled: true },
    });
  });

  it("一覧の hasCalendarSource は、CalDAV の起点があるかを返す (URL そのものは返さない)", async () => {
    const withSource = await addAccount({
      provider: "generic",
      imapHost: null,
      mailEnabled: false,
      calendarEnabled: true,
      caldavUrl: "https://dav.example.com/",
    });
    const mailOnly = await addAccount({ provider: "generic" });
    const list = await request("GET", "/accounts");
    const rows = list.body.accounts as Json[];
    const source = rows.find((value) => value.id === withSource);
    expect(source).toMatchObject({ hasCalendarSource: true });
    expect(source).not.toHaveProperty("caldavUrl");
    expect(rows.find((value) => value.id === mailOnly)).toMatchObject({
      hasCalendarSource: false,
    });
  });

  for (const provider of ["google", "microsoft"] as const) {
    it(`${provider}: 再ログインでカレンダーの権限を外すと、カレンダーをオフにして calendarDisabled を返す`, async () => {
      const mailScopes =
        provider === "google"
          ? `openid email ${GMAIL_SCOPE}`
          : MICROSOFT_SCOPES.join(" ");
      const calendarScopes =
        provider === "google"
          ? GOOGLE_CALENDAR_SCOPES
          : MICROSOFT_CALENDAR_SCOPES;
      profileEmail = `relogin-${provider}@example.net`;

      const first = await authorize(provider, { calendar: true });
      tokenScope = `${mailScopes} ${calendarScopes.join(" ")}`;
      const added = await request("POST", `/accounts/${provider}/complete`, {
        code: "code",
        state: first.state,
      });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({
        calendarGranted: true,
        calendarRequested: true,
        calendarDisabled: false,
        account: { calendarEnabled: true, hasCalendarSource: false },
      });
      const id = (added.body.account as Json).id as string;

      // カレンダーを使っているので、再ログインでもカレンダーの権限を求める。同意画面で外された。
      const again = await authorize(provider, { accountId: id });
      tokenScope = mailScopes;
      const relogin = await request("POST", `/accounts/${provider}/complete`, {
        code: "code",
        state: again.state,
      });
      expect(relogin.status).toBe(200);
      expect(relogin.body).toMatchObject({
        calendarGranted: false,
        calendarRequested: true,
        calendarDisabled: true,
        account: { id, calendarEnabled: false, calendarConsent: "required" },
      });
      const [row] = await db
        .select({ calendarEnabled: accounts.calendarEnabled })
        .from(accounts)
        .where(eq(accounts.id, id));
      expect(row?.calendarEnabled).toBe(false);

      // もともとオフなら、権限が無くても calendarDisabled にはしない。
      const third = await authorize(provider, { accountId: id });
      const plain = await request("POST", `/accounts/${provider}/complete`, {
        code: "code",
        state: third.state,
      });
      expect(plain.body).toMatchObject({
        calendarGranted: false,
        calendarRequested: false,
        calendarDisabled: false,
        account: { calendarEnabled: false },
      });
    });
  }
});
