/**
 * POP3 の受信 (取り込み、重複の回避、サーバーからの削除) と、取り込んだあとの操作を
 * 実際の PostgreSQL で確かめる。DATABASE_URL が無い環境では実行しない。
 * 接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SENDER_CHECK_VERSION } from "@orbit/core";
import {
  accounts,
  attachments,
  createDb,
  type Database,
  mailboxes,
  messageMailboxes,
  messageSources,
  messages,
  popMessages,
  users,
} from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Pop3Factory,
  popAttachmentDownloader,
  receivePop,
} from "./pop-account-sync.js";
import {
  applyPopOperation,
  ensurePopMailboxes,
  fillPopSenderChecks,
} from "./pop-store.js";

const adminUrl = process.env.DATABASE_URL;

type ServerMail = { uidl: string; raw: string };

/** テスト用の POP3 サーバーの代わり。DELE は QUIT で確定する。 */
function fakeClient(mails: ServerMail[]) {
  const deleted: string[] = [];
  const retrieved: string[] = [];
  let marked: number[] = [];
  const factory: Pop3Factory = () => ({
    connect: async () => {
      marked = [];
    },
    uidl: async () => new Map(mails.map((mail, i) => [i + 1, mail.uidl])),
    list: async () =>
      new Map(mails.map((mail, i) => [i + 1, Buffer.byteLength(mail.raw)])),
    retr: async (n: number) => {
      const mail = mails[n - 1] as ServerMail;
      retrieved.push(mail.uidl);
      return Buffer.from(mail.raw);
    },
    dele: async (n: number) => {
      marked.push(n);
    },
    quit: async () => {
      const gone = new Set(marked.map((n) => mails[n - 1]?.uidl));
      deleted.push(...[...gone].filter((uidl): uidl is string => !!uidl));
      for (let i = mails.length - 1; i >= 0; i--) {
        if (gone.has(mails[i]?.uidl)) mails.splice(i, 1);
      }
    },
    destroy: () => {
      marked = [];
    },
  });
  return { factory, deleted, retrieved };
}

function mail(n: number, extra = "") {
  return {
    uidl: `uidl-${n}`,
    raw: [
      `Message-ID: <m${n}@example.jp>`,
      "From: =?UTF-8?B?44OJ44Kz44Oi?= <sender@example.jp>",
      "To: me@example.jp",
      `Subject: =?ISO-2022-JP?B?GyRCJUYlOSVIGyhC?= ${n}`,
      `Date: Wed, 25 Nov 2026 0${n}:00:00 +0900`,
      "MIME-Version: 1.0",
      extra ||
        'Content-Type: text/plain; charset="ISO-2022-JP"\r\nContent-Transfer-Encoding: 7bit',
      "",
      extra ? "" : "\u001b$BK\\J8\u001b(B",
    ].join("\r\n"),
  };
}

const MULTIPART = [
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>本文</p>",
  "--b1",
  'Content-Type: application/pdf; name="a.pdf"',
  'Content-Disposition: attachment; filename="a.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("PDFDATA").toString("base64"),
  "--b1--",
].join("\r\n");

describe.skipIf(!adminUrl)("POP3 の受信", () => {
  const dbName = `mail_pop_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let account: typeof accounts.$inferSelect;
  let inbox: string;
  const stopped = () => false;
  const log = () => {};

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
        new URL("../../../packages/db/drizzle", import.meta.url),
      ),
    });
    const [user] = await db
      .insert(users)
      .values({ email: "pop@example.com", name: "pop" })
      .returning({ id: users.id });
    const [created] = await db
      .insert(accounts)
      .values({
        userId: user?.id as string,
        email: "me@example.jp",
        provider: "generic",
        authType: "password",
        protocol: "pop3",
        imapHost: "pop.example.jp",
        imapPort: 995,
        imapSecure: true,
        smtpHost: "smtp.example.jp",
        smtpPort: 465,
        smtpSecure: true,
        username: "me",
        credentialsEncrypted: "x",
        status: "disabled",
      })
      .returning();
    account = created as typeof accounts.$inferSelect;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName}`);
    await admin?.end();
  });

  beforeEach(async () => {
    await db.delete(messages).where(eq(messages.accountId, account.id));
    await db.delete(popMessages).where(eq(popMessages.accountId, account.id));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, account.id));
    inbox = await ensurePopMailboxes(db, account);
  });

  const inboxMessages = () =>
    db
      .select({
        id: messages.id,
        subject: messages.subject,
        from: messages.from,
        bodyText: messages.bodyText,
        bodyHtml: messages.bodyHtml,
        hasAttachments: messages.hasAttachments,
      })
      .from(messages)
      .innerJoin(messageMailboxes, eq(messageMailboxes.messageId, messages.id))
      .where(eq(messageMailboxes.mailboxId, inbox));

  it("決まったフォルダを作り、2 回目は増やさない", async () => {
    await ensurePopMailboxes(db, account);
    const rows = await db
      .select({ path: mailboxes.path, role: mailboxes.specialUse })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.id));
    expect(rows.map((row) => row.role).sort()).toEqual(
      ["archive", "inbox", "junk", "sent", "trash"].sort(),
    );
  });

  it("新しいメールだけを取り込み、日本語のヘッダーと本文を読める", async () => {
    const server = [mail(1), mail(2)];
    const { factory, retrieved } = fakeClient(server);
    const first = await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    expect(first.imported).toBe(2);
    // 新しいもの (番号の大きいもの) から取り込む。
    expect(retrieved).toEqual(["uidl-2", "uidl-1"]);
    const rows = await inboxMessages();
    expect(rows.map((row) => row.subject).sort()).toEqual([
      "テスト 1",
      "テスト 2",
    ]);
    expect(rows[0]?.from).toEqual([
      { name: "ドコモ", address: "sender@example.jp" },
    ]);
    expect(rows[0]?.bodyText?.trim()).toBe("本文");

    server.push(mail(3));
    const second = await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    expect(second.imported).toBe(1);
    expect(retrieved).toEqual(["uidl-2", "uidl-1", "uidl-3"]);
    expect(await inboxMessages()).toHaveLength(3);
  });

  it("添付ファイルの一覧を作り、保存した原文から取り出せる", async () => {
    const { factory } = fakeClient([mail(1, MULTIPART)]);
    await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    const [row] = await inboxMessages();
    expect(row?.hasAttachments).toBe(true);
    expect(row?.bodyHtml).toContain("<p>本文</p>");
    const [file] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, row?.id as string));
    expect(file).toMatchObject({ filename: "a.pdf", partId: "1" });
    const [source] = await db
      .select({ id: messageSources.messageId })
      .from(messageSources)
      .where(eq(messageSources.messageId, row?.id as string));
    expect(source).toBeDefined();

    let content = "";
    const found = await popAttachmentDownloader(db)(
      {
        id: file?.id as string,
        messageId: row?.id as string,
        userId: account.userId,
        partId: "1",
        providerMessageId: null,
        locations: [],
      },
      async (body) => {
        for await (const part of body) content += Buffer.from(part).toString();
      },
    );
    expect(found).toBe(true);
    expect(content).toBe("PDFDATA");
  });

  it("サーバーに残さない設定なら、取り込んだあと消す", async () => {
    const server = [mail(1), mail(2)];
    const { factory, deleted } = fakeClient(server);
    const result = await receivePop(
      db,
      { ...account, popLeaveOnServer: false },
      inbox,
      factory({} as never),
      { stopped, log },
    );
    expect(result).toMatchObject({ imported: 2, deleted: 2 });
    expect(deleted.sort()).toEqual(["uidl-1", "uidl-2"]);
    expect(server).toHaveLength(0);
    // 消したメールの記録は残さない。メールは手元に残る。
    expect(
      await db
        .select()
        .from(popMessages)
        .where(eq(popMessages.accountId, account.id)),
    ).toHaveLength(0);
    expect(await inboxMessages()).toHaveLength(2);
  });

  it("残す日数を過ぎたメールだけを消す", async () => {
    const server = [mail(1), mail(2)];
    const { factory, deleted } = fakeClient(server);
    const settings = { ...account, popDeleteAfterDays: 7 };
    await receivePop(db, settings, inbox, factory({} as never), {
      stopped,
      log,
    });
    expect(deleted).toEqual([]);
    await db
      .update(popMessages)
      .set({ downloadedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
      .where(
        and(
          eq(popMessages.accountId, account.id),
          eq(popMessages.uidl, "uidl-1"),
        ),
      );
    const result = await receivePop(db, settings, inbox, factory({} as never), {
      stopped,
      log,
    });
    expect(result).toMatchObject({ imported: 0, deleted: 1 });
    expect(deleted).toEqual(["uidl-1"]);
  });

  it("アプリで完全に削除したメールは、サーバーからも消し、取り込み直さない", async () => {
    const server = [mail(1), mail(2)];
    const { factory, deleted, retrieved } = fakeClient(server);
    await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    const target = (await inboxMessages()).find(
      (row) => row.subject === "テスト 1",
    );
    await db.delete(messages).where(eq(messages.id, target?.id as string));
    const result = await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    expect(result).toMatchObject({ imported: 0, deleted: 1 });
    expect(deleted).toEqual(["uidl-1"]);
    expect(retrieved).toEqual(["uidl-2", "uidl-1"]);
  });

  it("途中で失敗したら QUIT せず、削除の印を取り消す", async () => {
    const server = [mail(1)];
    const { factory, deleted } = fakeClient(server);
    const client = factory({} as never);
    const failing = {
      ...client,
      quit: async () => {
        throw new Error("切れた");
      },
    };
    await expect(
      receivePop(db, { ...account, popLeaveOnServer: false }, inbox, failing, {
        stopped,
        log,
      }),
    ).rejects.toThrow("切れた");
    expect(deleted).toEqual([]);
    expect(server).toHaveLength(1);
  });

  it("移動は移動先の所在を確定させ、送信の控えは送信済みに置く", async () => {
    const { factory } = fakeClient([mail(1)]);
    await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    const [row] = await inboxMessages();
    const [archive] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, account.id),
          eq(mailboxes.specialUse, "archive"),
        ),
      );
    // API が受け付けたときの状態 (移動先に移動中として置き、移動元から外す)。
    await db.insert(messageMailboxes).values({
      mailboxId: archive?.id as string,
      messageId: row?.id as string,
      pendingSince: new Date(),
    });
    await db
      .delete(messageMailboxes)
      .where(eq(messageMailboxes.mailboxId, inbox));
    const moved = await applyPopOperation(db, account, {
      kind: "move",
      payload: {
        targets: [
          {
            messageId: row?.id as string,
            providerMessageId: null,
            mailboxId: inbox,
            mailboxPath: "INBOX",
            uid: null,
            uidValidity: null,
          },
        ],
        destination: { mailboxId: archive?.id as string, path: "Archive" },
      },
    });
    expect(moved).toEqual({ ok: true });
    const [placed] = await db
      .select({ pendingSince: messageMailboxes.pendingSince })
      .from(messageMailboxes)
      .where(eq(messageMailboxes.mailboxId, archive?.id as string));
    expect(placed?.pendingSince).toBeNull();

    const appended = await applyPopOperation(db, account, {
      kind: "append",
      payload: {
        mailboxPath: "Sent",
        targets: [],
        message: {
          from: { address: "me@example.jp" },
          to: [{ address: "you@example.jp" }],
          cc: [],
          bcc: [],
          subject: "送ったメール",
          text: "こんにちは",
          attachments: [],
          messageId: "<sent1@example.jp>",
          date: "2026-11-26T00:00:00.000Z",
          inReplyTo: null,
          references: [],
        },
      },
    });
    expect(appended).toEqual({ ok: true });
    const sent = await db
      .select({ subject: messages.subject, seen: messages.seen })
      .from(messages)
      .innerJoin(messageMailboxes, eq(messageMailboxes.messageId, messages.id))
      .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
      .where(
        and(eq(mailboxes.accountId, account.id), eq(mailboxes.path, "Sent")),
      );
    expect(sent).toEqual([{ subject: "送ったメール", seen: true }]);
  });

  it("フォルダの作成・名前の変更・削除を DB の中で行う", async () => {
    await applyPopOperation(db, account, {
      kind: "mailbox_create",
      payload: { name: "仕事", parentPath: null, path: "仕事", targets: [] },
    });
    await applyPopOperation(db, account, {
      kind: "mailbox_create",
      payload: {
        name: "A社",
        parentPath: "仕事",
        path: "仕事/A社",
        targets: [],
      },
    });
    const [work] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(eq(mailboxes.accountId, account.id), eq(mailboxes.path, "仕事")),
      );
    await applyPopOperation(db, account, {
      kind: "mailbox_rename",
      payload: {
        mailboxId: work?.id as string,
        path: "仕事",
        newPath: "業務",
        name: "業務",
        delimiter: "/",
        targets: [],
      },
    });
    const paths = async () =>
      (
        await db
          .select({ path: mailboxes.path })
          .from(mailboxes)
          .where(eq(mailboxes.accountId, account.id))
      )
        .map((row) => row.path)
        .sort();
    expect(await paths()).toContain("業務/A社");
    await applyPopOperation(db, account, {
      kind: "mailbox_delete",
      payload: {
        mailboxId: work?.id as string,
        path: "業務",
        name: "業務",
        targets: [],
      },
    });
    expect(await paths()).toEqual(
      ["Archive", "INBOX", "Junk", "Sent", "Trash"].sort(),
    );
  });

  it("送信元の確認結果が無いメールに、見られたものだけ原文から認証結果を入れる", async () => {
    const auth =
      "Authentication-Results: mx.example.jp; spf=pass smtp.mailfrom=example.jp; dmarc=pass header.from=example.jp\r\n";
    const server = [
      { uidl: "auth-1", raw: auth + mail(1).raw },
      { uidl: "auth-2", raw: auth + mail(2).raw },
    ];
    const { factory } = fakeClient(server);
    await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    // 確認結果を足す前に取り込んだメールの状態にする。
    await db
      .update(messages)
      .set({ senderCheck: null, authResults: null })
      .where(eq(messages.accountId, account.id));
    const rows = await inboxMessages();
    const [seen, unseen] = rows;
    await fillPopSenderChecks(db, account, [seen?.id as string]);
    const checks = await db
      .select({ id: messages.id, senderCheck: messages.senderCheck })
      .from(messages)
      .where(eq(messages.accountId, account.id));
    const byId = new Map(checks.map((row) => [row.id, row.senderCheck]));
    // 表示名「ドコモ」は別のドメインなので名前の注意も付くが、DMARC の合格は読めている。
    expect(byId.get(seen?.id as string)).toMatchObject({ verified: true });
    expect(byId.get(unseen?.id as string)).toBeNull();
  });

  it("古い決まりで作った確認結果 (版が無い) も、見られたときに取り直す。受信ホストと違う組織の判定は使わない", async () => {
    const forged =
      "Authentication-Results: mx.forged.example; dmarc=pass header.from=example.jp\r\n";
    const { factory } = fakeClient([
      { uidl: "old-1", raw: forged + mail(1).raw },
    ]);
    await receivePop(db, account, inbox, factory({} as never), {
      stopped,
      log,
    });
    const [row] = await inboxMessages();
    // 取り込み時点で、信頼しない名前のヘッダーは使っていない。
    const [stored] = await db
      .select({ senderCheck: messages.senderCheck })
      .from(messages)
      .where(eq(messages.id, row?.id as string));
    expect(stored?.senderCheck).toMatchObject({ verified: false });
    // 照合を入れる前に保存した結果 (版なし、偽のヘッダーで verified) の状態にする。
    await db
      .update(messages)
      .set({ senderCheck: { verified: true, warnings: [], claimed: null } })
      .where(eq(messages.id, row?.id as string));
    await fillPopSenderChecks(db, account, [row?.id as string]);
    const [after] = await db
      .select({
        senderCheck: messages.senderCheck,
        authResults: messages.authResults,
      })
      .from(messages)
      .where(eq(messages.id, row?.id as string));
    expect(after?.senderCheck).toMatchObject({
      verified: false,
      version: SENDER_CHECK_VERSION,
    });
    expect(after?.authResults).toBeNull();
  });
});
