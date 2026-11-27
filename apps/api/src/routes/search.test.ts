/**
 * 検索の確かめ (実際の PostgreSQL を使う)。
 *
 * 日本語のメールでよくある書き方 (全角と半角、本文の途中の改行、HTML の文字参照、名前の空白) でも
 * 見つかること、語が離れて現れるだけのメールは見つからないこと、索引を作る前 (同期ワーカーが作っている
 * 途中) と作った後で結果が同じことを確かめる。
 *
 * DATABASE_URL が無い環境では実行しない (CI では必ず実行する)。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  accounts,
  createDb,
  type Database,
  mailboxes,
  messageMailboxes,
  messageSearch,
  messages,
  users,
} from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { checkSearchIndex, searchIndex } from "../lib/search-index.js";
import { searchRoutes } from "./search.js";

const adminUrl = process.env.DATABASE_URL;

type Seed = {
  key: string;
  subject?: string;
  from?: { name?: string; address: string }[];
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string;
};

/** 確かめに使うメール。key は結果を見分ける目印 (件名の頭に付ける)。 */
const SEEDS: Seed[] = [
  { key: "invoice", subject: "請求書の送付", bodyText: "お世話になります。" },
  {
    key: "wrapped",
    subject: "ご連絡",
    // 古いメールソフトは、日本語の文の途中でも改行する。
    bodyText: "今月分のご請求\r\n書をお送りします。",
  },
  {
    key: "entities",
    subject: "お知らせ",
    bodyText: null,
    bodyHtml:
      "<html><head><style>p{color:red}</style></head><body><p>&#35531;&#27714;&#x66F8; ｱﾏｿﾞﾝ</p></body></html>",
  },
  {
    key: "sender",
    subject: "打ち合わせ",
    from: [{ name: "佐藤 美咲", address: "misaki@example.jp" }],
    bodyText: "よろしくお願いします。",
  },
  { key: "fullwidth", subject: "ＡＢＣ商事より", bodyText: "本文" },
  {
    key: "single",
    subject: "ご挨拶",
    from: [{ name: "林 葵", address: "aoi@example.jp" }],
    bodyText: "本文",
  },
  {
    key: "apart",
    subject: "ご依頼",
    // 「請求」と「求書」はあるが、「請求書」は無い。
    bodyText: "請求します。要求書もご確認ください。",
  },
  { key: "percent", subject: "50%オフ", bodyText: "セール" },
];

describe.skipIf(!adminUrl)("検索 (PostgreSQL)", () => {
  const dbName = `mail_search_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let db: Database;
  let pool: pg.Pool;
  let userId: string;
  const ids = new Map<string, string>();
  const app = new Hono<AppEnv>();

  /** q で探して、見つかったメールの目印を並べて返す。 */
  const search = async (q: string) => {
    const response = await app.request(
      `/search?q=${encodeURIComponent(q)}&limit=100`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: { subject: string; excerpt: string | null }[];
    };
    return body.messages
      .map((message) => {
        const key = message.subject.split(" ")[0] as string;
        return key;
      })
      .sort();
  };

  const expectations: [string, string[]][] = [
    ["請求書", ["entities", "invoice", "wrapped"]],
    ["請求", ["apart", "entities", "invoice", "wrapped"]],
    ["アマゾン", ["entities"]],
    ["ｱﾏｿﾞﾝ", ["entities"]],
    ["from:佐藤美咲", ["sender"]],
    ["from:佐藤 美咲", ["sender"]],
    ['from:"佐藤 美咲"', ["sender"]],
    ["to:佐藤美咲", []],
    ["abc", ["fullwidth"]],
    ["ABC商事", ["fullwidth"]],
    ["林", ["single"]],
    ["50%", ["percent"]],
    ["5_", []],
    ["subject:請求", ["invoice"]],
    ["body:請求書", ["entities", "wrapped"]],
    ["請求書 -アマゾン", ["invoice", "wrapped"]],
    ["請求 -請求書", ["apart"]],
    ["存在しない語", []],
  ];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    ({ db, pool } = createDb(url.toString()));
    // uuidv7() は PostgreSQL 18 から。古い版で確かめるときだけ、代わりの関数を置く。
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
      .values({ name: "検索", email: "search@example.com" })
      .returning({ id: users.id });
    userId = user?.id as string;
    const [account] = await db
      .insert(accounts)
      .values({
        userId,
        email: "me@example.com",
        provider: "generic",
        authType: "password",
        username: "me@example.com",
        credentialsEncrypted: "x",
        status: "disabled",
      })
      .returning({ id: accounts.id });
    const [inbox] = await db
      .insert(mailboxes)
      .values({
        accountId: account?.id as string,
        path: "INBOX",
        name: "INBOX",
        specialUse: "inbox",
      })
      .returning({ id: mailboxes.id });
    let minute = 0;
    for (const seed of SEEDS) {
      minute += 1;
      const [row] = await db
        .insert(messages)
        .values({
          accountId: account?.id as string,
          threadKey: seed.key,
          subject: `${seed.key} ${seed.subject ?? ""}`,
          from: seed.from ?? [{ address: "someone@example.com" }],
          to: [{ name: "自分", address: "me@example.com" }],
          receivedAt: new Date(Date.UTC(2026, 10, 1, 0, minute)),
          snippet: seed.snippet ?? "",
          bodyText: seed.bodyText === undefined ? null : seed.bodyText,
          bodyHtml: seed.bodyHtml ?? null,
        })
        .returning({ id: messages.id });
      ids.set(seed.key, row?.id as string);
      await db.insert(messageMailboxes).values({
        mailboxId: inbox?.id as string,
        messageId: row?.id as string,
      });
    }

    app.use(async (c, next) => {
      c.set("user", { id: userId } as AppEnv["Variables"]["user"]);
      await next();
    });
    app.route("/", searchRoutes({ db }));
  });

  afterAll(async () => {
    searchIndex.ready = false;
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

  it("メールを追加すると、トリガーが検索用の文字列を作る", async () => {
    const rows = await db.select().from(messageSearch);
    expect(rows).toHaveLength(SEEDS.length);
    const wrapped = rows.find((row) => row.messageId === ids.get("wrapped"));
    // 件名・差出人・宛先・本文を \x01 でつなぎ、空白を除いて小文字にそろえる。
    expect(wrapped?.doc).toBe(
      "wrappedご連絡\u0001someone@example.com\u0001自分me@example.com\u0001今月分のご請求書をお送りします。",
    );
  });

  it("索引ができる前でも探せる (索引を使わずに探す)", async () => {
    searchIndex.ready = false;
    expect(await checkSearchIndex(db)).toBe(false);
    for (const [q, expected] of expectations) {
      expect([q, await search(q)]).toEqual([q, expected]);
    }
  });

  it("索引ができたら索引で探し、結果は同じ", async () => {
    await db.execute(
      sql`create index concurrently message_search_grams_idx on message_search using gin (mail_search_grams(doc))`,
    );
    expect(await checkSearchIndex(db)).toBe(true);
    searchIndex.ready = true;
    for (const [q, expected] of expectations) {
      expect([q, await search(q)]).toEqual([q, expected]);
    }
  });

  it("索引で引く関数は、表を順に読む計画を選ばない", async () => {
    // よく出る文字の語で、1 通ずつ mail_search_grams を計算する計画 (10 万通で 30 秒以上) を選ばないよう、
    // mail_search_ids の中では表を順に読まない (マイグレーション 0046)。
    const result = await db.execute<{ config: string[] | null }>(
      sql`select proconfig as config from pg_proc where proname = 'mail_search_ids'`,
    );
    expect(result.rows[0]?.config).toContain("enable_seqscan=off");
    searchIndex.ready = true;
    // 1 文字の語 (どのメールにもある文字) でも、索引で引いて全件を返す。
    expect(await search("e")).toHaveLength(SEEDS.length);
  });

  it("候補を確かめながら探しても、次のページの続きが正しい", async () => {
    searchIndex.ready = true;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.request(
        `/search?q=${encodeURIComponent("請求")}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const body = (await response.json()) as {
        messages: { subject: string }[];
        nextCursor: string | null;
      };
      seen.push(...body.messages.map((m) => m.subject.split(" ")[0] as string));
      cursor = body.nextCursor;
    } while (cursor);
    // 新しい順。
    expect(seen).toEqual(["apart", "entities", "wrapped", "invoice"]);
  });

  it("本文の抜粋は、そろえた文字で当たった箇所を返す", async () => {
    searchIndex.ready = true;
    const response = await app.request(
      `/search?q=${encodeURIComponent("請求書")}`,
    );
    const body = (await response.json()) as {
      messages: { subject: string; excerpt: string | null }[];
    };
    const excerpt = (key: string) =>
      body.messages.find((m) => m.subject.startsWith(key))?.excerpt;
    // 件名に語があるときは抜粋を出さない。
    expect(excerpt("invoice")).toBeNull();
    expect(excerpt("wrapped")).toBe("今月分のご請求 書をお送りします。");
    expect(excerpt("entities")).toBe("請求書 ｱﾏｿﾞﾝ");
  });

  it("本文を書き換えると、検索用の文字列も作り直す", async () => {
    searchIndex.ready = true;
    await db
      .update(messages)
      .set({ bodyText: "見積書を添付します。" })
      .where(eq(messages.id, ids.get("invoice") as string));
    expect(await search("見積書")).toEqual(["invoice"]);
    expect(await search("お世話")).toEqual([]);
  });
});
