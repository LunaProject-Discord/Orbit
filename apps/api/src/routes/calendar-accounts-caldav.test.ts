/**
 * CalDAV のアカウントの追加 (/accounts/caldav) を、実際の PostgreSQL と、fetch を差し替えた
 * 小さな CalDAV サーバーで確かめる。DATABASE_URL が無い環境では DB のテストを実行しない。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_ACCOUNTS,
  decryptCredentials,
  encryptCredentials,
} from "@orbit/core";
import { accounts, createDb, type Database, users } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import {
  caldavAccountRoutes,
  normalizeCaldavUrl,
} from "./calendar-accounts-caldav.js";

/**
 * テスト用のパスワード。暗号化した値に含まれないことを確かめるので、短い文字列にしない
 * (2 文字の "pw" は、ランダムな暗号文の base64 にたまたま含まれて落ちることがあった)。
 */
const PASSWORD = "caldav-test-password-7f3e9a";

const adminUrl = process.env.DATABASE_URL;
type Json = Record<string, unknown>;

describe("normalizeCaldavUrl", () => {
  it.each([
    ["dav.example.com/cal", false, "https://dav.example.com/cal"],
    ["https://dav.example.com/", false, "https://dav.example.com/"],
    ["http://dav.example.com/", false, null],
    ["http://localhost:5232/", true, "http://localhost:5232/"],
    ["https://u:p@dav.example.com/", false, null],
    ["ftp://dav.example.com/", false, null],
  ] as const)("%s (http: %s) → %s", (input, allowHttp, expected) => {
    expect(normalizeCaldavUrl(input, allowHttp)).toBe(expected);
  });
});

/** 探索に答えるだけの CalDAV サーバー。passwords は「ユーザー名 → 通るパスワード」。 */
function fakeCaldav(passwords: Record<string, string>) {
  const requests: string[] = [];
  const multistatus = (body: string) =>
    new Response(
      `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`,
      { status: 207 },
    );
  const ok = (href: string, props: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push(url.toString());
    if (url.pathname === "/.well-known/caldav") {
      return new Response(null, {
        status: 301,
        headers: { location: "/dav/" },
      });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const [user, password] = Buffer.from(auth.replace(/^Basic /, ""), "base64")
      .toString("utf8")
      .split(":");
    if (!user || passwords[user] !== password) {
      return new Response(null, { status: 401 });
    }
    if (url.pathname === "/dav/") {
      return multistatus(
        ok(
          "/dav/",
          "<d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>",
        ),
      );
    }
    if (url.pathname === "/p/") {
      return multistatus(
        ok(
          "/p/",
          "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>",
        ),
      );
    }
    if (url.pathname === "/home/") {
      return multistatus(
        ok(
          "/home/cal/",
          "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Home</d:displayname>",
        ),
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe.skipIf(!adminUrl)("CalDAV のアカウントの追加", () => {
  const dbName = `mail_caldav_accounts_${randomUUID().replaceAll("-", "")}`;
  const encryptionKey = randomBytes(32);
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let userId: string;
  let listener: pg.Client;
  const notified: string[] = [];
  const server = fakeCaldav({
    "me@icloud.com": "app-pass",
    alice: PASSWORD,
  });

  const makeApp = (
    isPrivateHost: (host: string) => Promise<boolean> = async () => false,
  ) => {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("user", { id: userId, email: "owner@example.com", name: "owner" });
      await next();
    });
    app.route(
      "/accounts/caldav",
      caldavAccountRoutes(
        { db, encryptionKey, allowPrivateMailHosts: false },
        { fetchImpl: server.fetchImpl, isPrivateHost },
      ),
    );
    return app;
  };

  const request = async (path: string, body?: unknown, app = makeApp()) => {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };

  const waitNotified = async (id: string) => {
    for (let i = 0; i < 50 && !notified.includes(id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return notified.includes(id);
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

  it("一般の CalDAV: 接続を確かめてから、メール無し・カレンダーありの行を作る", async () => {
    const result = await request("/accounts/caldav", {
      provider: "generic",
      url: "dav.example.com",
      username: "alice",
      password: PASSWORD,
    });
    expect(result.status).toBe(201);
    const account = result.body.account as Json;
    expect(account).toMatchObject({
      email: "alice@dav.example.com",
      provider: "generic",
      mailEnabled: false,
      calendarEnabled: true,
      imapHost: null,
      calendarConsent: "not_applicable",
    });
    expect(account).not.toHaveProperty("credentialsEncrypted");
    const [row] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, account.id as string));
    expect(row?.caldavUrl).toBe("https://dav.example.com/");
    expect(row?.credentialsEncrypted).not.toContain(PASSWORD);
    expect(
      decryptCredentials(
        row?.credentialsEncrypted as string,
        encryptionKey,
        userId,
      ),
    ).toEqual({
      type: "password",
      password: PASSWORD,
    });
    expect(await waitNotified(account.id as string)).toBe(true);

    const again = await request("/accounts/caldav", {
      provider: "generic",
      url: "https://dav.example.com/",
      username: "alice",
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
  });

  it("パスワードの誤り、内部ネットワーク、http の URL は行を作らずに断る", async () => {
    const wrong = await request("/accounts/caldav", {
      provider: "generic",
      url: "https://dav.example.com/",
      username: "bob",
      password: "nope",
    });
    expect(wrong).toMatchObject({
      status: 422,
      body: { error: "auth_failed" },
    });
    expect(String(wrong.body.message)).not.toContain("nope");

    const before = server.requests.length;
    const internal = await request(
      "/accounts/caldav",
      {
        provider: "generic",
        url: "https://intranet.example.com/",
        username: "alice",
        password: PASSWORD,
      },
      makeApp(async (host) => host === "intranet.example.com"),
    );
    expect(internal).toMatchObject({
      status: 422,
      body: { error: "host_not_allowed" },
    });
    expect(server.requests.length).toBe(before);

    const http = await request("/accounts/caldav", {
      provider: "generic",
      url: "http://dav.example.com/",
      username: "alice",
      password: PASSWORD,
    });
    expect(http).toMatchObject({ status: 422, body: { error: "invalid_url" } });
    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.username, "bob"));
    expect(rows).toHaveLength(0);
  });

  it("iCloud: 同じ Apple ID のメールのアカウントがあり、保存済みのアプリ用パスワードが通れば、そのアカウントでカレンダーをオンにする", async () => {
    const [mail] = await db
      .insert(accounts)
      .values({
        userId,
        email: "me@icloud.com",
        provider: "icloud",
        authType: "password",
        imapHost: "imap.mail.me.com",
        imapPort: 993,
        username: "me@icloud.com",
        credentialsEncrypted: encryptCredentials(
          { type: "password", password: "app-pass" },
          encryptionKey,
          userId,
        ),
      })
      .returning({ id: accounts.id });
    if (!mail) throw new Error("作れませんでした");
    const result = await request("/accounts/caldav", {
      provider: "icloud",
      appleId: "me@icloud.com",
      password: "whatever",
    });
    expect(result.status).toBe(200);
    expect(result.body.merged).toBe(true);
    expect(result.body.account).toMatchObject({
      id: mail.id,
      mailEnabled: true,
      calendarEnabled: true,
    });
    expect(
      server.requests.some((url) =>
        url.startsWith("https://caldav.icloud.com/"),
      ),
    ).toBe(true);

    const twice = await request("/accounts/caldav", {
      provider: "icloud",
      appleId: "me@icloud.com",
      password: "app-pass",
    });
    expect(twice.status).toBe(409);
  });

  it("既存の iCloud のメールのアカウントで、カレンダーをオンにする (保存済みのパスワードが通らなければ 422)", async () => {
    const insert = async (password: string) => {
      const [row] = await db
        .insert(accounts)
        .values({
          userId,
          email: `${randomUUID()}@icloud.com`,
          provider: "icloud",
          authType: "password",
          imapHost: "imap.mail.me.com",
          imapPort: 993,
          username: "me@icloud.com",
          credentialsEncrypted: encryptCredentials(
            { type: "password", password },
            encryptionKey,
            userId,
          ),
        })
        .returning({ id: accounts.id });
      if (!row) throw new Error("作れませんでした");
      return row.id;
    };
    const good = await insert("app-pass");
    const enabled = await request(`/accounts/caldav/${good}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.body.account).toMatchObject({ calendarEnabled: true });
    const [row] = await db.select().from(accounts).where(eq(accounts.id, good));
    expect(row?.caldavUrl).toBe("https://caldav.icloud.com/");

    const bad = await insert("old");
    const refused = await request(`/accounts/caldav/${bad}/enable`);
    expect(refused).toMatchObject({
      status: 422,
      body: { error: "auth_failed" },
    });
  });
});
