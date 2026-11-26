/**
 * 追加済みアカウントの接続先の変更 (PUT /v1/accounts/:id/server) と、
 * 設定の自動検出 (POST /v1/accounts/discover) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decryptCredentials, encryptCredentials } from "@orbit/core";
import {
  createDb,
  type Database,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  users,
} from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import type { ImapSettings } from "../lib/imap-verify.js";
import type { Pop3VerifySettings } from "../lib/pop3-verify.js";
import type { SmtpVerifySettings } from "../lib/smtp-verify.js";
import { accountRoutes } from "./accounts.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("アカウントの接続先の変更", () => {
  const dbName = `mail_account_server_${randomUUID().replaceAll("-", "")}`;
  const encryptionKey = randomBytes(32);
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: Hono<AppEnv>;
  let userId: string;
  let otherAccountId: string;
  let oauthAccountId: string;

  /** 確認に使った設定と、そのときに返す結果。 */
  const seen = {
    imap: [] as ImapSettings[],
    pop3: [] as Pop3VerifySettings[],
    smtp: [] as SmtpVerifySettings[],
  };
  let smtpFails = false;

  const request = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const addAccount = async (
    owner: string,
    email: string,
    overrides: Partial<typeof mailAccounts.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(mailAccounts)
      .values({
        userId: owner,
        email,
        provider: "generic",
        authType: "password",
        imapHost: "imap.old.example",
        imapPort: 143,
        imapSecure: false,
        smtpHost: "smtp.old.example",
        smtpPort: 25,
        smtpSecure: false,
        username: "old-user",
        credentialsEncrypted: encryptCredentials(
          { type: "password", password: "old-password" },
          encryptionKey,
          owner,
        ),
        status: "auth_required",
        lastError: "ログインできません",
        ...overrides,
      })
      .returning({ id: mailAccounts.id });
    if (!row) throw new Error("アカウントを作れませんでした。");
    return row.id;
  };

  const body = {
    imap: { host: "imap.new.example", port: 993, secure: true },
    smtp: { host: "smtp.new.example", port: 587, secure: false },
    username: "me@new.example",
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
    const [other] = await db
      .insert(users)
      .values({ email: "other@example.com", name: "other" })
      .returning({ id: users.id });
    if (!user || !other) throw new Error("利用者を作れませんでした。");
    userId = user.id;
    otherAccountId = await addAccount(other.id, "them@old.example");
    oauthAccountId = await addAccount(user.id, "me@gmail.com", {
      provider: "gmail",
      authType: "oauth2",
      credentialsEncrypted: encryptCredentials(
        { type: "oauth2", refreshToken: "r" },
        encryptionKey,
        user.id,
      ),
    });

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
          // 名前解決をしないで済むよう、内部ネットワークの確認を省く。
          allowPrivateMailHosts: true,
          microsoft: null,
          google: null,
        },
        {
          verifyImap: async (settings) => {
            seen.imap.push(settings);
            return { ok: true };
          },
          verifyPop3: async (settings) => {
            seen.pop3.push(settings);
            return { ok: true };
          },
          verifySmtp: async (settings) => {
            seen.smtp.push(settings);
            return smtpFails
              ? { ok: false, reason: "auth_failed", detail: "535 bad" }
              : { ok: true };
          },
          discovery: {
            fetchText: async (url) =>
              url.startsWith("https://autoconfig.shin.example/")
                ? `<clientConfig><emailProvider id="x">
                    <incomingServer type="imap"><hostname>imap.shin.example</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></incomingServer>
                    <outgoingServer type="smtp"><hostname>smtp.shin.example</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></outgoingServer>
                  </emailProvider></clientConfig>`
                : null,
            resolveMx: async () => [],
            resolveSrv: async () => [],
          },
        },
      ),
    );
  }, 120_000);

  beforeEach(() => {
    seen.imap.length = 0;
    seen.pop3.length = 0;
    seen.smtp.length = 0;
    smtpFails = false;
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

  it("設定を自動で見つける", async () => {
    const response = await request("POST", "/accounts/discover", {
      email: "comugi@shin.example",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: {
        source: "autoconfig",
        imap: { host: "imap.shin.example", port: 993, security: "ssl" },
        smtp: { host: "smtp.shin.example", port: 587, security: "starttls" },
      },
    });
  });

  it("テストは保存しない。パスワードを省くと保存済みのものを使う", async () => {
    const id = await addAccount(userId, "test@old.example");
    const response = await request("POST", `/accounts/${id}/server/test`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      imap: { ok: true },
      smtp: { ok: true },
    });
    expect(seen.imap[0]).toMatchObject({
      host: "imap.new.example",
      username: "me@new.example",
      password: "old-password",
    });
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, id));
    expect(row?.imapHost).toBe("imap.old.example");
  });

  it("POP3 で受け取るアカウントを追加できる", async () => {
    const response = await request("POST", "/accounts", {
      email: "taro@docomo.ne.jp",
      incomingProtocol: "pop3",
      imap: { host: "mail.spmode.ne.jp", port: 995, secure: true },
      smtp: { host: "mail.spmode.ne.jp", port: 465, secure: true },
      username: "taro",
      password: "secret",
      pop: { leaveOnServer: true, deleteAfterDays: 30 },
    });
    expect(response.status).toBe(201);
    expect(seen.imap).toHaveLength(0);
    expect(seen.pop3[0]).toMatchObject({
      host: "mail.spmode.ne.jp",
      port: 995,
      username: "taro",
    });
    const { account } = (await response.json()) as {
      account: Record<string, unknown>;
    };
    expect(account).toMatchObject({
      protocol: "pop3",
      provider: "generic",
      popLeaveOnServer: true,
      popDeleteAfterDays: 30,
      imapHost: "mail.spmode.ne.jp",
    });
  });

  it("同じアドレスでも、受信サーバーかユーザー名が違えば追加できる", async () => {
    await addAccount(userId, "hanako@docomo.ne.jp", {
      imapHost: "imap2.spmode.ne.jp",
      username: "hanako@docomo.ne.jp",
    });
    const pop = {
      email: "hanako@docomo.ne.jp",
      incomingProtocol: "pop3",
      imap: { host: "mail.spmode.ne.jp", port: 995, secure: true },
      smtp: { host: "mail.spmode.ne.jp", port: 465, secure: true },
      username: "hanako",
      password: "secret",
    };
    expect((await request("POST", "/accounts", pop)).status).toBe(201);
    // 受信サーバーとユーザー名まで同じなら、追加済みとして断る。
    const again = await request("POST", "/accounts", {
      ...pop,
      imap: { ...pop.imap, host: "MAIL.spmode.ne.jp" },
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "account_exists" });
  });

  it("受信方式を POP3 に変えると、取り込み済みのメールとフォルダを消す", async () => {
    const id = await addAccount(userId, "switch@old.example");
    const [box] = await db
      .insert(mailboxes)
      .values({ accountId: id, path: "INBOX", name: "INBOX" })
      .returning({ id: mailboxes.id });
    const [mail] = await db
      .insert(messages)
      .values({ accountId: id, threadKey: "t", receivedAt: new Date() })
      .returning({ id: messages.id });
    await db.insert(messageMailboxes).values({
      mailboxId: box?.id as string,
      messageId: mail?.id as string,
      uid: 1n,
    });
    const response = await request("PUT", `/accounts/${id}/server`, {
      ...body,
      incomingProtocol: "pop3",
      imap: { host: "pop.new.example", port: 995, secure: true },
      pop: { leaveOnServer: false, deleteAfterDays: 7 },
    });
    expect(response.status).toBe(200);
    expect(seen.pop3[0]).toMatchObject({ host: "pop.new.example" });
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, id));
    expect(row).toMatchObject({
      protocol: "pop3",
      popLeaveOnServer: false,
      // サーバーに残さないなら、日数は使わない。
      popDeleteAfterDays: null,
    });
    expect(
      await db.select().from(messages).where(eq(messages.accountId, id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(mailboxes).where(eq(mailboxes.accountId, id)),
    ).toHaveLength(0);
  });

  it("送信にログインできなければ保存しない", async () => {
    const id = await addAccount(userId, "fail@old.example");
    smtpFails = true;
    const response = await request("PUT", `/accounts/${id}/server`, {
      ...body,
      password: "new-password",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "verification_failed",
      imap: { ok: true },
      smtp: { ok: false, reason: "auth_failed" },
    });
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, id));
    expect(row?.smtpHost).toBe("smtp.old.example");
  });

  it("両方にログインできたら保存し、同期を再開する", async () => {
    const id = await addAccount(userId, "ok@old.example");
    const response = await request("PUT", `/accounts/${id}/server`, {
      ...body,
      password: "new-password",
    });
    expect(response.status).toBe(200);
    const { account } = (await response.json()) as {
      account: Record<string, unknown>;
    };
    expect(account).toMatchObject({
      imapHost: "imap.new.example",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.new.example",
      smtpPort: 587,
      smtpSecure: false,
      username: "me@new.example",
      status: "active",
      lastError: null,
    });
    expect(account).not.toHaveProperty("credentialsEncrypted");
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, id));
    expect(
      decryptCredentials(
        row?.credentialsEncrypted as string,
        encryptionKey,
        userId,
      ),
    ).toEqual({ type: "password", password: "new-password" });
  });

  it("ほかの利用者のアカウントは変えられず、ログインで追加した Gmail はパスワードが要る", async () => {
    const theirs = await request(
      "PUT",
      `/accounts/${otherAccountId}/server`,
      body,
    );
    expect(theirs.status).toBe(404);
    const oauth = await request(
      "PUT",
      `/accounts/${oauthAccountId}/server`,
      body,
    );
    expect(oauth.status).toBe(400);
    expect(await oauth.json()).toEqual({ error: "password_required" });
    expect(seen.imap).toHaveLength(0);
  });

  it("Google でログインした Gmail を、アプリ パスワードでの接続に切り替えられる", async () => {
    const response = await request(
      "PUT",
      `/accounts/${oauthAccountId}/server`,
      {
        imap: { host: "imap.gmail.com", port: 993, secure: true },
        smtp: { host: "smtp.gmail.com", port: 465, secure: true },
        username: "me@gmail.com",
        password: "app-password",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: { authType: "password", provider: "gmail" },
    });
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, oauthAccountId));
    expect(
      decryptCredentials(
        row?.credentialsEncrypted as string,
        encryptionKey,
        userId,
      ),
    ).toEqual({ type: "password", password: "app-password" });
  });
});
