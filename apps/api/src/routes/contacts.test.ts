/**
 * 宛先の候補 (GET /v1/contacts) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDb,
  type Database,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  users,
} from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { type ContactRow, contactRoutes } from "./contacts.js";

const adminUrl = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!adminUrl)("宛先の候補", () => {
  const dbName = `mail_contacts_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: Hono<AppEnv>;

  const list = async (query = ""): Promise<ContactRow[]> => {
    const response = await app.request(`/contacts${query}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { contacts: ContactRow[] }).contacts;
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

    const addAccount = async (userId: string, email: string) => {
      const [account] = await db
        .insert(mailAccounts)
        .values({
          userId,
          email,
          displayName: email,
          provider: "generic",
          authType: "password",
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          username: email,
          credentialsEncrypted: "x",
          status: "disabled",
        })
        .returning({ id: mailAccounts.id });
      if (!account) throw new Error("アカウントを作れませんでした。");
      const boxes = await db
        .insert(mailboxes)
        .values(
          (["inbox", "sent", "junk"] as const).map((role) => ({
            accountId: account.id,
            path: role,
            name: role,
            specialUse: role,
            detectedSpecialUse: role,
          })),
        )
        .returning({ id: mailboxes.id, role: mailboxes.specialUse });
      const box = (role: string) =>
        boxes.find((entry) => entry.role === role)?.id as string;
      return { id: account.id, box };
    };
    const mine = await addAccount(user.id, "Me@Example.com");
    const theirs = await addAccount(other.id, "them@example.com");

    let uid = 0n;
    const add = async (
      account: { id: string; box: (role: string) => string },
      role: string,
      fields: Partial<typeof messages.$inferInsert>,
    ) => {
      const [row] = await db
        .insert(messages)
        .values({
          accountId: account.id,
          threadKey: randomUUID(),
          receivedAt: new Date(),
          ...fields,
        })
        .returning({ id: messages.id });
      if (!row) throw new Error("メールを作れませんでした。");
      uid += 1n;
      await db
        .insert(messageMailboxes)
        .values({ mailboxId: account.box(role), messageId: row.id, uid });
    };
    const now = Date.now();
    const me = { name: "自分", address: "me@example.com" };

    // よく送る相手 (送信済みフォルダ・差出人が自分)。
    for (let i = 0; i < 3; i++) {
      await add(mine, "sent", {
        from: [me],
        to: [{ name: "Alice 旧姓", address: "Alice@Example.com" }],
        receivedAt: new Date(now - (10 + i) * DAY),
      });
    }
    await add(mine, "sent", {
      from: [me],
      to: [{ name: "Alice 新姓", address: "alice@example.com" }],
      cc: [{ address: "carol@example.com" }],
      bcc: [{ address: "me@example.com" }],
      receivedAt: new Date(now - 2 * DAY),
    });
    // 受け取っただけの相手。
    await add(mine, "inbox", {
      from: [{ name: "Bob", address: "bob@example.com" }],
      to: [me],
      receivedAt: new Date(now - DAY),
    });
    // 差出人が別名でも、送信済みフォルダにあれば送ったメール。
    await add(mine, "sent", {
      from: [{ address: "alias@example.net" }],
      to: [{ name: "Dave", address: "dave@example.com" }],
      receivedAt: new Date(now - 400 * DAY),
    });
    // 候補にしないもの。
    await add(mine, "junk", {
      from: [{ address: "spam@example.com" }],
    });
    await add(mine, "inbox", {
      from: [{ address: "news@example.com" }],
      listId: "news.example.com",
    });
    await add(mine, "inbox", {
      from: [{ address: "no-reply@example.com" }],
    });
    await add(mine, "inbox", {
      from: [{ address: "x@example.com" }],
      draft: true,
    });
    // 他の利用者のメール。
    await add(theirs, "inbox", {
      from: [{ name: "Secret", address: "secret@example.com" }],
    });

    app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("user", { id: user.id, email: "owner@example.com", name: "owner" });
      await next();
    });
    app.route("/contacts", contactRoutes({ db }));
  }, 120_000);

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

  it("送受信の相手を、送った回数と新しさの順に返す", async () => {
    const contacts = await list("?limit=100");
    expect(contacts.map((entry) => entry.address)).toEqual([
      "alice@example.com",
      "carol@example.com",
      "bob@example.com",
      "dave@example.com",
    ]);
    const [alice] = contacts;
    expect(alice).toMatchObject({
      name: "Alice 新姓",
      sentCount: 4,
      receivedCount: 0,
    });
    expect(contacts[2]).toMatchObject({ sentCount: 0, receivedCount: 1 });
  });

  it("名前かアドレスの一部で絞り込める", async () => {
    expect((await list("?q=新姓")).map((entry) => entry.address)).toEqual([
      "alice@example.com",
    ]);
    expect((await list("?q=DAVE")).map((entry) => entry.address)).toEqual([
      "dave@example.com",
    ]);
    // LIKE の記号はそのままの文字として扱う。
    expect(await list("?q=%25")).toEqual([]);
  });

  it("件数を絞れる", async () => {
    expect(await list("?limit=1")).toHaveLength(1);
  });
});
