/**
 * 利用者どうしのデータの分離を、実際の PostgreSQL で確かめる。
 *
 * 2 人の利用者 (A と B) にそれぞれメールアカウント・メール・下書きなどを用意し、
 * B がログインした状態で、A の ID を指定してすべての API を呼ぶ。
 * - 応答に A のデータ (ID と目印の文字列) が含まれないこと
 * - A のデータが 1 行も変わらないこと
 * を確かめる。API を足したときは、下の一覧にも足す。
 *
 * DATABASE_URL が無い環境では実行しない (CI では必ず実行する)。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTIFICATION_ACTION_PATH,
  NOTIFICATION_REPLY_PATH,
  type SendPayload,
  signNotificationAction,
} from "@orbit/core";
import {
  accounts,
  attachments,
  calendars,
  changes,
  createDb,
  type Database,
  drafts,
  eventAttendees,
  events,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
  pushSubscriptions,
  signatureRules,
  unifiedFolders,
} from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { EventsHub } from "./lib/events-hub.js";

const adminUrl = process.env.DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";
const encryptionKey = Buffer.alloc(32, 7);

type Seeded = Awaited<ReturnType<typeof seed>>;

const emptyRecipients = { list: [], text: "" };
const filters = {
  unread: false,
  flagged: false,
  hasAttachment: false,
  from: "",
  to: "",
  subject: "",
  text: "",
  withinDays: null,
};

/** 利用者 1 人分のデータを用意する。mark は、応答に漏れていないかを探す目印。 */
async function seed(db: Database, userId: string, mark: string) {
  const one = <T>(rows: T[]): T => {
    const [row] = rows;
    if (!row) throw new Error("行を作れませんでした。");
    return row;
  };
  const account = one(
    await db
      .insert(accounts)
      .values({
        userId,
        email: `${mark}@example.com`,
        displayName: `${mark}-name`,
        provider: "generic",
        authType: "password",
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        username: `${mark}@example.com`,
        credentialsEncrypted: `${mark}-credentials`,
        // 同期ワーカーは動かさない。
        status: "disabled",
        signatureHtml: `<p>${mark}-signature</p>`,
      })
      .returning({ id: accounts.id }),
  ).id;
  const [inbox, folder] = (
    await db
      .insert(mailboxes)
      .values([
        {
          accountId: account,
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          specialUse: "inbox",
          detectedSpecialUse: "inbox",
          uidValidity: 1n,
        },
        {
          accountId: account,
          path: `${mark}-folder`,
          name: `${mark}-folder`,
          delimiter: "/",
          uidValidity: 2n,
        },
      ])
      .returning({ id: mailboxes.id })
  ).map((row) => row.id) as [string, string];
  const message = one(
    await db
      .insert(messages)
      .values({
        accountId: account,
        threadKey: `${mark}-thread`,
        messageIdHeader: `<${mark}-message@example.com>`,
        subject: `${mark}-subject`,
        from: [{ name: `${mark}-sender`, address: "sender@example.com" }],
        to: [{ address: `${mark}@example.com` }],
        receivedAt: new Date(),
        snippet: `${mark}-snippet`,
        hasAttachments: true,
        bodyText: `${mark}-body shared-word`,
        bodyHtml: `<p>${mark}-body shared-word</p>`,
        bodyFetchedAt: new Date(),
      })
      .returning({ id: messages.id }),
  ).id;
  await db
    .insert(messageMailboxes)
    .values({ mailboxId: inbox, messageId: message, uid: 1n });
  const attachment = one(
    await db
      .insert(attachments)
      .values({
        messageId: message,
        filename: `${mark}-file.txt`,
        contentType: "text/plain",
        size: 3,
        partId: "2",
      })
      .returning({ id: attachments.id }),
  ).id;
  const draft = randomUUID();
  await db.insert(drafts).values({
    id: draft,
    userId,
    accountId: account,
    to: emptyRecipients,
    cc: emptyRecipients,
    bcc: emptyRecipients,
    subject: `${mark}-draft`,
    text: `${mark}-draft-body`,
  });
  const target = {
    messageId: message,
    providerMessageId: null,
    mailboxId: inbox,
    mailboxPath: "INBOX",
    uid: "1",
    uidValidity: "1",
  };
  const [outgoing, failure] = (
    await db
      .insert(outbox)
      .values([
        {
          accountId: account,
          kind: "send",
          idempotencyKey: randomUUID(),
          payload: {
            mode: "new",
            sourceMessageId: null,
            message: {
              to: [{ address: "someone@example.com" }],
              cc: [],
              bcc: [],
              subject: `${mark}-outgoing`,
              text: `${mark}-outgoing-body`,
              html: null,
              attachments: [],
            },
          },
        },
        {
          accountId: account,
          kind: "set_flags",
          idempotencyKey: randomUUID(),
          status: "failed",
          lastError: `${mark}-error`,
          payload: { targets: [target], seen: true },
        },
      ])
      .returning({ id: outbox.id })
  ).map((row) => row.id) as [string, string];
  const unified = one(
    await db
      .insert(unifiedFolders)
      .values({
        userId,
        name: `${mark}-unified`,
        scope: { all: true, roles: [], mailboxIds: [] },
        filters,
      })
      .returning({ id: unifiedFolders.id }),
  ).id;
  const signature = one(
    await db
      .insert(signatureRules)
      .values({
        userId,
        kind: "contact",
        key: `${mark}-contact@example.com`,
        signatureHtml: `<p>${mark}-rule</p>`,
      })
      .returning({ id: signatureRules.id }),
  ).id;
  const endpoint = `https://fcm.googleapis.com/fcm/send/${mark}-endpoint`;
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint, p256dh: "key", auth: "auth" });
  await db
    .insert(changes)
    .values({ userId, entity: "message", entityId: message, op: "upsert" });
  return {
    userId,
    mark,
    account,
    inbox,
    folder,
    message,
    attachment,
    draft,
    outgoing,
    failure,
    unified,
    signature,
    endpoint,
  };
}

/** その利用者に属する行を、すべての表から集める (変わっていないことの比較用)。 */
async function snapshot(db: Database, userId: string) {
  const own = sql`select id from accounts where user_id = ${userId}`;
  const queries = {
    accounts: sql`select * from accounts where user_id = ${userId}`,
    mailboxes: sql`select * from mailboxes where account_id in (${own})`,
    messages: sql`select * from messages where account_id in (${own})`,
    message_mailboxes: sql`select mm.* from message_mailboxes mm join mailboxes b on b.id = mm.mailbox_id where b.account_id in (${own})`,
    attachments: sql`select a.* from attachments a join messages m on m.id = a.message_id where m.account_id in (${own})`,
    outbox: sql`select * from outbox where account_id in (${own})`,
    drafts: sql`select * from drafts where user_id = ${userId}`,
    unified_folders: sql`select * from unified_folders where user_id = ${userId}`,
    sidebar_layouts: sql`select * from sidebar_layouts where user_id = ${userId}`,
    signature_rules: sql`select * from signature_rules where user_id = ${userId}`,
    push_subscriptions: sql`select * from push_subscriptions where user_id = ${userId}`,
    devices: sql`select * from devices where user_id = ${userId}`,
    user_settings: sql`select * from user_settings where user_id = ${userId}`,
    changes: sql`select * from changes where user_id = ${userId}`,
  };
  const result: Record<string, unknown[]> = {};
  for (const [table, query] of Object.entries(queries)) {
    const { rows } = await db.execute(
      sql`select to_jsonb(t) as row from (${query}) t order by to_jsonb(t)::text`,
    );
    result[table] = rows.map((row) => row.row);
  }
  return result;
}

// CI では必ず実行する。DATABASE_URL が届いていなければ (turbo.json の env から外れたなど)、
// 黙って飛ばさずに失敗させる。
it.runIf(process.env.CI === "true")("CI では DATABASE_URL がある", () => {
  expect(adminUrl).toBeTruthy();
});

describe.skipIf(!adminUrl)("利用者どうしのデータの分離", () => {
  const dbName = `mail_isolation_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let dir: string;
  let a: Seeded;
  let b: Seeded;
  let tokenA: string;
  let tokenB: string;

  const request = (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(`/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A のデータを指す文字列 (ID と目印)。B への応答に含まれてはいけない。 */
  const secretsOfA = () => [
    a.mark,
    a.userId,
    a.account,
    a.inbox,
    a.folder,
    a.message,
    a.attachment,
    a.draft,
    a.outgoing,
    a.failure,
    a.unified,
    a.signature,
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
        new URL("../../../packages/db/drizzle", import.meta.url),
      ),
    });

    dir = await mkdtemp(join(tmpdir(), "mail-isolation-"));
    process.env.ATTACHMENTS_DIR = dir;
    const authOptions = {
      db,
      secret: "isolation-test-secret-isolation-test-secret",
      baseURL: "http://localhost:8787",
      trustedOrigins: [ORIGIN],
    };
    const auth = createAuth(authOptions);
    const signUp = createAuth({ ...authOptions, allowSignUp: true });
    app = createApp({
      db,
      auth,
      signUpAuth: signUp,
      hub: new EventsHub(url.toString()),
      allowedOrigins: [ORIGIN],
      encryptionKey,
      allowPrivateMailHosts: false,
      microsoft: null,
      google: null,
      webPushPublicKey: "test-public-key",
      fcmEnabled: true,
      webOrigin: ORIGIN,
      mailer: null,
      build: { version: "0.0.0-test", commit: null },
      updatePolicy: {
        channel: "stable",
        pinnedVersion: null,
        serverAutoUpdate: false,
        appUpdate: "auto",
      },
      appReleasesDir: null,
      publicUrl: "http://localhost:8787",
    });

    const login = async (mark: string) => {
      const email = `${mark}-login@example.com`;
      const { user } = await signUp.api.signUpEmail({
        body: { email, name: mark, password: PASSWORD },
      });
      const response = await app.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      const token = response.headers.get("set-auth-token");
      if (!token) throw new Error(`ログインできませんでした (${mark})。`);
      return { userId: user.id, token };
    };
    const alice = await login("alice-private");
    const bob = await login("bob-private");
    tokenA = alice.token;
    tokenB = bob.token;
    // A を管理者にする (招待リンクを発行できる)。B は管理者ではない。
    await db.execute(
      sql`update users set is_admin = true where id = ${alice.userId}`,
    );
    a = await seed(db, alice.userId, "alice-private");
    b = await seed(db, bob.userId, "bob-private");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    // 接続が閉じ終わるまで少しかかることがあるので、消せるまで繰り返す。
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await admin?.query(`drop database if exists ${dbName}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("新規登録は API から受け付けない", async () => {
    const response = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: "mallory@example.com",
        name: "mallory",
        password: PASSWORD,
      }),
    });
    expect(response.ok).toBe(false);
    const { rows } = await db.execute(
      sql`select 1 from users where email = 'mallory@example.com'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("ログインしていなければ、どの API も使えない", async () => {
    for (const path of ["/accounts", "/messages", "/drafts", "/sync", "/me"]) {
      const response = await app.request(`/v1${path}`);
      expect(response.status, path).toBe(401);
    }
  });

  it("自分のデータは見える (確かめ方が空振りしていないこと)", async () => {
    for (const [token, own] of [
      [tokenA, a],
      [tokenB, b],
    ] as const) {
      const list = await (await request(token, "GET", "/messages")).text();
      expect(list).toContain(own.message);
      const detail = await request(token, "GET", `/messages/${own.message}`);
      expect(detail.status).toBe(200);
      expect(await detail.text()).toContain(`${own.mark}-body`);
      const search = await request(
        token,
        "GET",
        "/messages/search?q=shared-word",
      );
      expect(await search.text()).toContain(own.message);
      const unified = await request(
        token,
        "GET",
        `/unified/${own.unified}/messages`,
      );
      expect(await unified.text()).toContain(own.message);
      const contacts = await request(token, "GET", "/contacts?q=sender");
      expect(await contacts.text()).toContain(`${own.mark}-sender`);
    }
  });

  it("一覧の行には、会話のうち未読のメールが入る", async () => {
    type Row = {
      id: string;
      seen: boolean;
      threadMessageIds: string[];
      unseenIds: string[];
    };
    const lists = [
      await request(tokenA, "GET", "/messages"),
      await request(tokenA, "GET", `/unified/${a.unified}/messages`),
    ];
    for (const response of lists) {
      const { messages } = (await response.json()) as { messages: Row[] };
      const row = messages.find((item) => item.id === a.message);
      expect(row).toBeDefined();
      expect(row?.unseenIds).toEqual(row?.seen ? [] : row?.threadMessageIds);
    }
  });

  it("一覧や検索の応答に、他の利用者のデータが混ざらない", async () => {
    // B が、A のフォルダを集める統合フォルダを作ってみる。
    const created = await request(tokenB, "POST", "/unified", {
      name: "collect",
      scope: { all: false, roles: [], mailboxIds: [a.inbox, a.folder] },
      filters,
    });
    expect(created.status).toBe(201);
    const collected = (
      (await created.json()) as {
        folder: { id: string; scope: { mailboxIds: string[] } };
      }
    ).folder;
    // 他の利用者のフォルダは、保存の時点で除かれる。
    expect(collected.scope.mailboxIds).toEqual([]);
    const collect = collected.id;
    const updated = await request(tokenB, "PATCH", `/unified/${collect}`, {
      scope: { all: false, roles: [], mailboxIds: [a.inbox, b.inbox] },
    });
    expect(
      (
        (await updated.json()) as {
          folder: { scope: { mailboxIds: string[] } };
        }
      ).folder.scope.mailboxIds,
    ).toEqual([b.inbox]);

    const paths = [
      "/me",
      "/accounts",
      `/accounts/${a.account}/mailboxes`,
      "/mailboxes",
      "/messages",
      `/messages?accountId=${a.account}`,
      `/messages?mailboxId=${a.inbox}`,
      `/messages?accountId=${b.account}&mailboxId=${a.inbox}`,
      "/messages?sort=subject&order=asc",
      "/messages?sort=from&order=desc",
      "/messages/search?q=shared-word",
      "/messages/search?q=shared-word&sort=to&order=asc",
      "/messages/search?q=snippet",
      `/messages/search?q=shared-word&accountId=${a.account}`,
      `/messages/search?q=shared-word&scope=folder&mailboxId=${a.inbox}`,
      `/messages/search?q=shared-word&scope=folder&unifiedId=${collect}`,
      "/messages/outgoing",
      "/messages/failures",
      "/drafts",
      "/unified",
      `/unified/${collect}/messages`,
      `/unified/${collect}/messages?sort=subject&order=desc`,
      "/signatures",
      "/contacts?limit=5000",
      "/contacts?q=sender",
      "/settings",
      "/security",
      "/sync?since=0",
      "/push/config",
    ];
    for (const path of paths) {
      const response = await request(tokenB, "GET", path);
      expect(response.status, path).toBe(200);
      const text = await response.text();
      for (const secret of secretsOfA()) {
        expect(text, `${path} に ${secret} が含まれている`).not.toContain(
          secret,
        );
      }
    }
    await request(tokenB, "DELETE", `/unified/${collect}`);
  });

  it("他の利用者の ID を指定した操作は、見つからない扱いになり、何も変えない", async () => {
    const before = await snapshot(db, a.userId);
    const id = () => randomUUID();
    const draftBody = (accountId: string) => ({
      accountId,
      to: emptyRecipients,
      cc: emptyRecipients,
      bcc: emptyRecipients,
      subject: "overwritten",
      baseRevision: 1,
    });
    const action = (extra: Record<string, unknown>) => ({
      idempotencyKey: id(),
      messageIds: [a.message],
      ...extra,
    });
    const overrides = { role: null, displayName: "x", icon: null, color: null };

    /** [メソッド, パス, 本文, 期待する状態コード] */
    const calls: [string, string, unknown, number][] = [
      // メールアカウント
      ["PATCH", `/accounts/${a.account}`, { displayName: "x" }, 404],
      ["PATCH", `/accounts/${a.account}`, { signatureHtml: "<p>x</p>" }, 404],
      ["DELETE", `/accounts/${a.account}`, undefined, 404],
      ["POST", `/accounts/${a.account}/sync`, undefined, 404],
      ["PUT", "/accounts/order", { accountIds: [a.account] }, 404],
      ["PUT", "/accounts/order", { accountIds: [b.account, a.account] }, 404],
      // フォルダ
      [
        "POST",
        "/mailboxes",
        { accountId: a.account, parentId: null, name: "x" },
        404,
      ],
      [
        "POST",
        "/mailboxes",
        { accountId: b.account, parentId: a.folder, name: "x" },
        404,
      ],
      ["PATCH", `/mailboxes/${a.folder}`, { name: "x" }, 404],
      ["DELETE", `/mailboxes/${a.folder}`, undefined, 404],
      ["PUT", `/mailboxes/${a.folder}/overrides`, overrides, 404],
      ["PUT", "/mailboxes/order", { mailboxIds: [a.inbox, a.folder] }, 404],
      ["PUT", "/mailboxes/order", { mailboxIds: [b.inbox, a.inbox] }, 404],
      ["POST", "/mailboxes/order/reset", { mailboxIds: [a.inbox] }, 204],
      ["POST", `/mailboxes/${a.inbox}/read`, undefined, 404],
      // メール
      ["GET", `/messages/${a.message}`, undefined, 404],
      ["GET", `/messages/${a.message}/thread`, undefined, 404],
      [
        "GET",
        `/messages/${a.message}/attachments/${a.attachment}`,
        undefined,
        404,
      ],
      [
        "GET",
        `/messages/${b.message}/attachments/${a.attachment}`,
        undefined,
        404,
      ],
      // メールの招待 (8a のカード、8b の反映)
      ["GET", `/messages/${a.message}/invite`, undefined, 404],
      [
        "POST",
        `/messages/${a.message}/invite/apply`,
        { expect: "import" },
        404,
      ],
      [
        "POST",
        "/messages/actions",
        action({ action: "set_flags", seen: true }),
        200,
      ],
      [
        "POST",
        "/messages/actions",
        action({ action: "set_flags", flagged: true }),
        200,
      ],
      [
        "POST",
        "/messages/actions",
        action({ action: "move", destination: "trash" }),
        200,
      ],
      [
        "POST",
        "/messages/actions",
        action({ action: "move", mailboxId: a.folder }),
        200,
      ],
      ["POST", "/messages/actions", action({ action: "delete" }), 200],
      [
        "POST",
        "/messages/prefetch",
        { ids: [a.message], reason: "hover" },
        204,
      ],
      // 自分のメールを、他の利用者のフォルダへは移せない。
      [
        "POST",
        "/messages/actions",
        {
          idempotencyKey: id(),
          messageIds: [b.message],
          action: "move",
          mailboxId: a.folder,
        },
        400,
      ],
      // 添付ファイル
      [
        "POST",
        "/attachments/forward",
        { messageId: a.message, attachmentIds: [a.attachment] },
        404,
      ],
      // 送信
      [
        "POST",
        "/messages/send",
        {
          idempotencyKey: id(),
          accountId: a.account,
          to: [{ address: "someone@example.com" }],
          text: "x",
        },
        404,
      ],
      ["DELETE", `/messages/outgoing/${a.outgoing}`, undefined, 404],
      // 反映に失敗した操作
      ["POST", `/messages/failures/${a.failure}/retry`, undefined, 404],
      ["DELETE", `/messages/failures/${a.failure}`, undefined, 404],
      // 下書き
      ["PUT", `/drafts/${a.draft}`, draftBody(b.account), 404],
      ["PUT", `/drafts/${a.draft}`, draftBody(a.account), 404],
      [
        "PUT",
        `/drafts/${id()}`,
        { ...draftBody(a.account), baseRevision: null },
        404,
      ],
      ["DELETE", `/drafts/${a.draft}`, undefined, 204],
      // 統合フォルダ
      ["GET", `/unified/${a.unified}/messages`, undefined, 404],
      ["PATCH", `/unified/${a.unified}`, { name: "x" }, 404],
      ["DELETE", `/unified/${a.unified}`, undefined, 404],
      [
        "GET",
        `/messages/search?q=shared-word&scope=folder&unifiedId=${a.unified}`,
        undefined,
        404,
      ],
      // 署名
      [
        "PUT",
        "/signatures/thread",
        {
          accountId: a.account,
          threadKey: "alice-private-thread",
          signatureHtml: "x",
        },
        404,
      ],
      ["DELETE", `/signatures/${a.signature}`, undefined, 404],
      // 通知の送り先、表示中のフォルダ
      ["DELETE", "/push/subscriptions", { endpoint: a.endpoint }, 204],
      ["POST", "/focus", { accountId: a.account, mailboxId: a.inbox }, 204],
    ];
    for (const [method, path, body, status] of calls) {
      const response = await request(tokenB, method, path, body);
      const text = await response.text();
      const label = `${method} ${path} ${JSON.stringify(body ?? null)}`;
      expect(response.status, `${label}: ${text}`).toBe(status);
      for (const secret of [a.mark, a.userId]) {
        expect(text, label).not.toContain(secret);
      }
      if (path === "/messages/actions" && status === 200) {
        expect(JSON.parse(text), label).toEqual({ messageIds: [] });
      }
    }
    expect(await snapshot(db, a.userId)).toEqual(before);
  });

  it("他の利用者の予定には、出欠の返事も参加者の変更もできない", async () => {
    await db
      .update(accounts)
      .set({ calendarEnabled: true })
      .where(sql`${accounts.id} = ${a.account}`);
    const [calendar] = await db
      .insert(calendars)
      .values({
        userId: a.userId,
        accountId: a.account,
        source: "google",
        remoteId: "alice-private-calendar",
        name: "alice-private-calendar",
      })
      .returning({ id: calendars.id });
    const [event] = await db
      .insert(events)
      .values({
        userId: a.userId,
        calendarId: calendar?.id as string,
        uid: "alice-private-invite@remote",
        remoteId: "alice-private-invite",
        summary: "alice-private-invite",
        startAt: new Date("2027-03-01T01:00:00Z"),
        endAt: new Date("2027-03-01T02:00:00Z"),
        organizer: { email: "boss@example.com", self: false },
      })
      .returning({ id: events.id });
    const eventId = event?.id as string;
    await db.insert(eventAttendees).values([
      { eventId, email: "boss@example.com", status: "accepted" },
      // self の行はアカウントのアドレス (primary でないカレンダーでは、ここが違うと返事できない)。
      { eventId, email: "alice-private@example.com", self: true },
    ]);
    const attendeesBefore = await db
      .select()
      .from(eventAttendees)
      .where(sql`${eventAttendees.eventId} = ${eventId}`);
    const now = new Date().toISOString();
    const calls: [string, string, unknown][] = [
      [
        "POST",
        `/calendars/events/${eventId}/respond`,
        { status: "declined", respondedAt: now },
      ],
      [
        "PATCH",
        `/calendars/events/${eventId}`,
        { changes: { attendees: [{ email: "mallory@example.com" }] } },
      ],
      [
        "PATCH",
        `/calendars/events/${eventId}/occurrences/2027-03-01T01:00:00Z`,
        { changes: { busy: false } },
      ],
    ];
    for (const [method, path, body] of calls) {
      const response = await request(tokenB, method, path, body);
      const text = await response.text();
      expect(response.status, `${method} ${path}: ${text}`).toBe(404);
      expect(text).not.toContain("alice-private");
    }
    expect(
      await db
        .select()
        .from(eventAttendees)
        .where(sql`${eventAttendees.eventId} = ${eventId}`),
    ).toEqual(attendeesBefore);
    expect(
      await db
        .select()
        .from(outbox)
        .where(sql`${outbox.payload}->>'eventId' = ${eventId}`),
    ).toEqual([]);
    // 本人は返事できる (確かめ方が空振りしていないこと)。
    const own = await request(
      tokenA,
      "POST",
      `/calendars/events/${eventId}/respond`,
      { status: "declined", respondedAt: now },
    );
    expect(own.status).toBe(200);
  });

  it("メールの招待の反映は、他の利用者のカレンダーにも予定にも届かない", async () => {
    const [calendar] = await db
      .insert(calendars)
      .values({
        userId: a.userId,
        source: "local",
        name: "alice-private-local",
      })
      .returning({ id: calendars.id });
    const calendarId = calendar?.id as string;
    // B にも取り込み先がある (A のカレンダーを指定したときに、取り込み先が無い扱いで済ませない)。
    await db
      .insert(calendars)
      .values({ userId: b.userId, source: "local", name: "bob-local" });
    // A が主催する予定と、A が取り込んだ予定 (B のメールと同じ UID)。
    const [organized, imported] = await db
      .insert(events)
      .values([
        {
          userId: a.userId,
          calendarId,
          uid: "alice-private-organized@orbit",
          summary: "alice-private-organized",
          startAt: new Date("2027-03-01T01:00:00Z"),
          endAt: new Date("2027-03-01T02:00:00Z"),
          organizer: { email: "alice-private@example.com", self: true },
        },
        {
          userId: a.userId,
          calendarId,
          uid: "alice-private-imported@remote",
          summary: "alice-private-imported",
          startAt: new Date("2027-03-02T01:00:00Z"),
          endAt: new Date("2027-03-02T02:00:00Z"),
          organizer: { email: "boss@example.com", self: false },
        },
      ])
      .returning({ id: events.id });
    await db.insert(eventAttendees).values([
      { eventId: organized?.id as string, email: "sender@example.com" },
      {
        eventId: imported?.id as string,
        email: "alice-private@example.com",
        self: true,
      },
    ]);
    const eventsOfA = async () =>
      (
        await db.execute(
          sql`select to_jsonb(e) as row from events e where user_id = ${a.userId} order by id`,
        )
      ).rows;
    const attendeesOfA = async () =>
      (
        await db.execute(
          sql`select to_jsonb(t) as row from event_attendees t join events e on e.id = t.event_id where e.user_id = ${a.userId} order by t.id`,
        )
      ).rows;
    const before = await eventsOfA();
    const attendeesBefore = await attendeesOfA();
    /** B のメール (差出人は sender@example.com、認証済み) に招待を付ける。 */
    const inviteOfB = async (method: string, uid: string, extra: string[]) => {
      const [message] = await db
        .insert(messages)
        .values({
          accountId: b.account,
          threadKey: randomUUID(),
          from: [
            {
              address:
                method === "REPLY" ? "sender@example.com" : "boss@example.com",
            },
          ],
          senderCheck: { verified: true, warnings: [], claimed: null },
          receivedAt: new Date(),
          hasAttachments: true,
        })
        .returning({ id: messages.id });
      const content = [
        "BEGIN:VCALENDAR",
        `METHOD:${method}`,
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20270101T000000Z",
        "DTSTART:20270301T010000Z",
        "SEQUENCE:5",
        ...extra,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const [attachment] = await db
        .insert(attachments)
        .values({
          messageId: message?.id as string,
          filename: "invite.ics",
          contentType: "text/calendar",
          size: Buffer.byteLength(content),
          partId: "2",
        })
        .returning({ id: attachments.id });
      await mkdir(join(dir, b.userId), { recursive: true });
      await writeFile(join(dir, b.userId, attachment?.id as string), content);
      return message?.id as string;
    };
    const reply = await inviteOfB("REPLY", "alice-private-organized@orbit", [
      "ORGANIZER:mailto:alice-private@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:sender@example.com",
    ]);
    const update = await inviteOfB("REQUEST", "alice-private-imported@remote", [
      "ORGANIZER:mailto:boss@example.com",
      "SUMMARY:overwritten",
    ]);
    const cancel = await inviteOfB("CANCEL", "alice-private-imported@remote", [
      "ORGANIZER:mailto:boss@example.com",
    ]);
    const calls: [string, unknown, number][] = [
      [reply, { expect: "apply_reply" }, 409],
      [update, { expect: "update" }, 409],
      [update, { expect: "import", calendarId }, 404],
      [cancel, { expect: "remove" }, 200],
    ];
    for (const [messageId, body, status] of calls) {
      const shown = await (
        await request(tokenB, "GET", `/messages/${messageId}/invite`)
      ).text();
      for (const secret of [
        a.userId,
        calendarId,
        organized?.id,
        imported?.id,
      ]) {
        expect(shown).not.toContain(secret as string);
      }
      const response = await request(
        tokenB,
        "POST",
        `/messages/${messageId}/invite/apply`,
        body,
      );
      const text = await response.text();
      expect(response.status, `${JSON.stringify(body)}: ${text}`).toBe(status);
      for (const secret of [
        a.userId,
        calendarId,
        organized?.id,
        imported?.id,
      ]) {
        expect(text).not.toContain(secret as string);
      }
    }
    expect(await eventsOfA()).toEqual(before);
    expect(await attendeesOfA()).toEqual(attendeesBefore);
  });

  it("返信元に他の利用者のメールを指定しても、その内容は使われない", async () => {
    const key = randomUUID();
    const response = await request(tokenB, "POST", "/messages/send", {
      idempotencyKey: key,
      accountId: b.account,
      to: [{ address: "someone@example.com" }],
      text: "x",
      mode: "reply",
      sourceMessageId: a.message,
    });
    expect(response.status).toBe(202);
    const { rows } = await db.execute(
      sql`select payload::text as payload from outbox where idempotency_key = ${key}`,
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.payload)).not.toContain(a.mark);
    await db.execute(sql`delete from outbox where idempotency_key = ${key}`);
  });

  it("他の利用者が置いた添付ファイルは、送信にも下書きにも使えない", async () => {
    const before = await snapshot(db, a.userId);
    const uploaded = await app.request("/v1/attachments", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        origin: ORIGIN,
        "content-type": "text/plain",
        "x-filename": "alice-private.txt",
      },
      body: "alice-private-file",
    });
    expect(uploaded.status).toBe(201);
    const fileId = ((await uploaded.json()) as { attachment: { id: string } })
      .attachment.id;

    const send = await request(tokenB, "POST", "/messages/send", {
      idempotencyKey: randomUUID(),
      accountId: b.account,
      to: [{ address: "someone@example.com" }],
      text: "x",
      attachmentIds: [fileId],
    });
    expect(send.status).toBe(400);
    const draft = await request(tokenB, "PUT", `/drafts/${randomUUID()}`, {
      accountId: b.account,
      to: emptyRecipients,
      cc: emptyRecipients,
      bcc: emptyRecipients,
      attachmentIds: [fileId],
      baseRevision: null,
    });
    expect(draft.status).toBe(400);
    // B が消そうとしても、A のファイルは残る。
    expect(
      (await request(tokenB, "DELETE", `/attachments/${fileId}`)).status,
    ).toBe(204);
    const own = await request(tokenA, "PUT", `/drafts/${randomUUID()}`, {
      accountId: a.account,
      to: emptyRecipients,
      cc: emptyRecipients,
      bcc: emptyRecipients,
      attachmentIds: [fileId],
      baseRevision: null,
    });
    expect(own.status).toBe(201);
    const ownDraft = ((await own.json()) as { draft: { id: string } }).draft.id;
    expect(
      (await request(tokenA, "DELETE", `/drafts/${ownDraft}`)).status,
    ).toBe(204);
    await db.execute(
      sql`delete from changes where user_id = ${a.userId} and entity = 'account'`,
    );
    expect(await snapshot(db, a.userId)).toEqual(before);
  });

  it("通知のボタンの合言葉は、他の利用者のメールには通用しない", async () => {
    const before = await snapshot(db, a.userId);
    const response = await app.request(`/v1${NOTIFICATION_ACTION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: a.message,
        action: "delete",
        token: signNotificationAction(encryptionKey, b.userId, a.message),
      }),
    });
    expect(response.status).toBe(403);
    expect(await snapshot(db, a.userId)).toEqual(before);
  });

  it("通知の返信欄の合言葉は、他の利用者のメールには通用しない", async () => {
    const before = await snapshot(db, a.userId);
    const response = await app.request(`/v1${NOTIFICATION_REPLY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: a.message,
        token: signNotificationAction(encryptionKey, b.userId, a.message),
        text: "なりすまし",
      }),
    });
    expect(response.status).toBe(403);
    expect(await snapshot(db, a.userId)).toEqual(before);
  });

  it("通知の返信欄からの返信は、自分のアカウントから元の差出人へ積まれる", async () => {
    const before = await snapshot(db, a.userId);
    const idempotencyKey = randomUUID();
    const send = () =>
      app.request(`/v1${NOTIFICATION_REPLY_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageId: b.message,
          token: signNotificationAction(encryptionKey, b.userId, b.message),
          text: "了解です",
          idempotencyKey,
        }),
      });
    const response = await send();
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    // 同じ返信をもう一度送っても、二重には積まない。
    expect(((await (await send()).json()) as { id: string }).id).toBe(id);
    const rows = await db
      .select({ accountId: outbox.accountId, payload: outbox.payload })
      .from(outbox)
      .where(sql`${outbox.id} = ${id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(b.account);
    const payload = rows[0]?.payload as unknown as SendPayload;
    expect(payload.mode).toBe("reply");
    expect(payload.sourceMessageId).toBe(b.message);
    expect(payload.message.to).toEqual([
      { name: `${b.mark}-sender`, address: "sender@example.com" },
    ]);
    expect(payload.message.subject).toBe(`Re: ${b.mark}-subject`);
    expect(payload.message.inReplyTo).toBe(`<${b.mark}-message@example.com>`);
    expect(payload.message.text).toContain("了解です");
    expect(payload.message.text).toContain(`> ${b.mark}-body shared-word`);
    await db.execute(
      sql`delete from outbox where account_id = ${b.account} and idempotency_key = ${idempotencyKey}`,
    );
    expect(await snapshot(db, a.userId)).toEqual(before);
  });

  it("名前の変更は、自分の名前だけを変える", async () => {
    const nameOf = async (userId: string) =>
      (await db.execute(sql`select name from users where id = ${userId}`))
        .rows[0]?.name;
    const before = await nameOf(a.userId);
    const saved = await request(tokenB, "PUT", "/security/name", {
      name: "  新しい名前  ",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ name: "新しい名前" });
    expect(await nameOf(b.userId)).toBe("新しい名前");
    expect(await nameOf(a.userId)).toBe(before);
    const me = (await (await request(tokenB, "GET", "/me")).json()) as {
      user: { name: string };
    };
    expect(me.user.name).toBe("新しい名前");
    for (const name of ["", "   ", "x".repeat(101), "a\nb"]) {
      const response = await request(tokenB, "PUT", "/security/name", { name });
      expect(response.status, JSON.stringify(name)).toBe(400);
    }
    expect(await nameOf(b.userId)).toBe("新しい名前");
  });

  it("設定や並び順の保存は、自分の分だけに反映される", async () => {
    const before = await snapshot(db, a.userId);
    const calls: [string, string, unknown][] = [
      ["PUT", "/unified/layout", { order: [a.unified, "inbox"], hidden: [] }],
      [
        "PUT",
        "/unified/builtins/inbox",
        { name: "x", icon: null, color: null },
      ],
      [
        "PUT",
        "/signatures/contact",
        { address: "alice-private-contact@example.com", signatureHtml: "x" },
      ],
      [
        "POST",
        "/push/subscriptions",
        {
          endpoint: "https://fcm.googleapis.com/fcm/send/bob-second",
          keys: { p256dh: "key", auth: "auth" },
        },
      ],
      ["POST", `/mailboxes/${b.inbox}/read`, undefined],
    ];
    for (const [method, path, body] of calls) {
      const response = await request(tokenB, method, path, body);
      expect(response.ok, `${method} ${path}: ${await response.text()}`).toBe(
        true,
      );
    }
    expect(await snapshot(db, a.userId)).toEqual(before);
  });

  describe("招待リンク", () => {
    const publicPost = (path: string, body: unknown) =>
      app.request(`/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      });
    const lookup = (value: string) =>
      app.request(`/v1/invitations/lookup?token=${encodeURIComponent(value)}`);
    const issue = async (body: unknown = {}) => {
      const response = await request(tokenA, "POST", "/invitations", body);
      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        invitation: { id: string };
        url: string;
      };
      const value = new URL(data.url).searchParams.get("token") ?? "";
      return { id: data.invitation.id, url: data.url, token: value };
    };
    const person = (mark: string) => ({
      name: mark,
      email: `${mark}@example.com`,
      password: PASSWORD,
    });

    it("管理者でなければ、発行も一覧も取り消しもできない", async () => {
      const { id } = await issue();
      for (const [method, path, body] of [
        ["GET", "/invitations", undefined],
        ["POST", "/invitations", {}],
        ["DELETE", `/invitations/${id}`, undefined],
      ] as const) {
        const response = await request(tokenB, method, path, body);
        expect(response.status, `${method} ${path}`).toBe(403);
      }
      const me = async (token: string) =>
        (
          (await (await request(token, "GET", "/me")).json()) as {
            user: { isAdmin: boolean };
          }
        ).user.isAdmin;
      expect(await me(tokenA)).toBe(true);
      expect(await me(tokenB)).toBe(false);
      expect(
        (await request(tokenA, "DELETE", `/invitations/${id}`)).status,
      ).toBe(204);
    });

    it("招待リンクから利用者を作ってログインでき、同じリンクは 2 度使えない", async () => {
      const invite = await issue({ label: "友人" });
      expect(invite.url).toBe(`${ORIGIN}/invite?token=${invite.token}`);
      // 合言葉そのものは保存しない。
      const stored = await db.execute(
        sql`select token_hash from invitations where id = ${invite.id}`,
      );
      expect(String(stored.rows[0]?.token_hash)).not.toContain(invite.token);

      expect((await lookup(invite.token)).status).toBe(200);
      const accepted = await publicPost("/invitations/accept", {
        token: invite.token,
        ...person("carol"),
      });
      expect(accepted.status).toBe(201);

      const signedIn = await publicPost("/auth/sign-in/email", {
        email: "carol@example.com",
        password: PASSWORD,
      });
      const carol = signedIn.headers.get("set-auth-token") ?? "";
      expect(carol).not.toBe("");
      // 新しい利用者は管理者ではなく、ほかの利用者のデータも見えない。
      expect((await request(carol, "GET", "/invitations")).status).toBe(403);
      const accountList = await request(carol, "GET", "/accounts");
      expect(await accountList.json()).toEqual({ accounts: [] });

      expect((await lookup(invite.token)).status).toBe(404);
      const again = await publicPost("/invitations/accept", {
        token: invite.token,
        ...person("dave"),
      });
      expect(again.status).toBe(404);

      const list = (await (
        await request(tokenA, "GET", "/invitations")
      ).json()) as {
        invitations: { id: string; usedByEmail: string | null }[];
        users: { email: string }[];
      };
      expect(
        list.invitations.find((row) => row.id === invite.id)?.usedByEmail,
      ).toBe("carol@example.com");
      expect(list.users.map((user) => user.email)).toContain(
        "carol@example.com",
      );
      expect(JSON.stringify(list)).not.toContain(invite.token);
    });

    it("使えない招待 (でたらめ、期限切れ、取り消し済み) では作れない", async () => {
      const expired = await issue();
      await db.execute(
        sql`update invitations set expires_at = now() - interval '1 minute' where id = ${expired.id}`,
      );
      const revoked = await issue();
      await request(tokenA, "DELETE", `/invitations/${revoked.id}`);
      for (const value of [expired.token, revoked.token, "x".repeat(43), ""]) {
        expect((await lookup(value)).status, value).toBe(404);
      }
      for (const value of [expired.token, revoked.token, "x".repeat(43)]) {
        const response = await publicPost("/invitations/accept", {
          token: value,
          ...person("erin"),
        });
        expect(response.status, value).toBe(404);
      }
      const { rows } = await db.execute(
        sql`select 1 from users where email = 'erin@example.com'`,
      );
      expect(rows).toHaveLength(0);
    });

    it("登録できなかったときは、招待がそのまま残る", async () => {
      const invite = await issue({ email: "Frank@Example.com" });
      const cases: [Record<string, string>, number, string][] = [
        [person("grace"), 400, "email_mismatch"],
        [{ ...person("frank"), password: "short" }, 400, "password_too_short"],
      ];
      for (const [body, status, error] of cases) {
        const response = await publicPost("/invitations/accept", {
          token: invite.token,
          ...body,
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error });
      }
      // すでにいる利用者のメールアドレスでは作れない。
      const open = await issue();
      const taken = await publicPost("/invitations/accept", {
        token: open.token,
        ...person("alice-private-login"),
      });
      expect(taken.status).toBe(409);
      expect((await lookup(open.token)).status).toBe(200);

      const ok = await publicPost("/invitations/accept", {
        token: invite.token,
        ...person("frank"),
      });
      expect(ok.status).toBe(201);
    });

    it("同じ招待を同時に使っても、作れるのは 1 人だけ", async () => {
      const invite = await issue();
      const results = await Promise.all(
        ["heidi", "ivan", "judy"].map((mark) =>
          publicPost("/invitations/accept", {
            token: invite.token,
            ...person(mark),
          }),
        ),
      );
      expect(
        results.filter((response) => response.status === 201),
      ).toHaveLength(1);
      const { rows } = await db.execute(
        sql`select 1 from users where email in ('heidi@example.com', 'ivan@example.com', 'judy@example.com')`,
      );
      expect(rows).toHaveLength(1);
    });
  });
});
