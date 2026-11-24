/**
 * 移動中として先に置いた所在 (message_mailboxes.pending_since) を、同期で結び付け直す処理を
 * 実際の PostgreSQL で確かめる。DATABASE_URL が無い環境では実行しない。
 * 接続先に確認用の DB を作り、終わったら消す。
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
  outbox,
  users,
} from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FetchMessageObject } from "imapflow";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  dropPendingPlacements,
  dropStalePending,
  STALE_PENDING_MS,
} from "./mailbox-store.js";
import { insertMessages } from "./mailbox-sync.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("移動中の所在", () => {
  const dbName = `mail_pending_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let account: { id: string; userId: string };
  let inbox: string;
  let trash: string;

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
      .values({ email: "pending@example.com", name: "pending" })
      .returning({ id: users.id });
    const [created] = await db
      .insert(mailAccounts)
      .values({
        userId: user?.id as string,
        email: "me@example.com",
        provider: "generic",
        authType: "password",
        protocol: "imap",
        imapSecure: true,
        smtpSecure: true,
        username: "me",
        credentialsEncrypted: "x",
        status: "disabled",
      })
      .returning({ id: mailAccounts.id });
    account = { id: created?.id as string, userId: user?.id as string };
    const boxes = await db
      .insert(mailboxes)
      .values([
        {
          accountId: account.id,
          path: "INBOX",
          name: "INBOX",
          specialUse: "inbox",
        },
        {
          accountId: account.id,
          path: "Trash",
          name: "Trash",
          specialUse: "trash",
        },
      ])
      .returning({ id: mailboxes.id, path: mailboxes.path });
    inbox = boxes.find((box) => box.path === "INBOX")?.id as string;
    trash = boxes.find((box) => box.path === "Trash")?.id as string;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName}`);
    await admin?.end();
  });

  beforeEach(async () => {
    await db.delete(outbox);
    await db.delete(messages);
  });

  /** 受信トレイから移動を受け付けた直後の状態 (API の placeAtDestination と同じ) を作る。 */
  async function movedToTrash(
    messageIdHeader: string | null,
    subject = "件名",
    pendingSince = new Date(),
  ) {
    const [row] = await db
      .insert(messages)
      .values({
        accountId: account.id,
        threadKey: "t",
        messageIdHeader,
        subject,
        receivedAt: new Date("2026-11-20T00:00:00Z"),
        bodyText: "本文",
        bodyFetchedAt: new Date(),
      })
      .returning({ id: messages.id });
    const id = row?.id as string;
    await db.insert(messageMailboxes).values({
      mailboxId: trash,
      messageId: id,
      pendingSince,
    });
    return id;
  }

  function fetched(
    uid: number,
    messageId: string | undefined,
    subject = "件名",
  ): FetchMessageObject {
    return {
      seq: uid,
      uid,
      flags: new Set(["\\Seen"]),
      internalDate: new Date("2026-11-20T00:00:00Z"),
      envelope: { messageId, subject },
      size: 10,
    } as unknown as FetchMessageObject;
  }

  const placementsOf = (messageId: string) =>
    db
      .select()
      .from(messageMailboxes)
      .where(eq(messageMailboxes.messageId, messageId));

  it("移動先の同期で同じメールが見つかれば、新しく取り込まずに UID を入れる", async () => {
    const id = await movedToTrash("<a@example.com>");
    await insertMessages(
      db,
      account,
      trash,
      [fetched(7, "<a@example.com>")],
      null,
    );

    const all = await db.select({ id: messages.id }).from(messages);
    expect(all.map((row) => row.id)).toEqual([id]);
    const [placed] = await placementsOf(id);
    expect(placed).toMatchObject({
      mailboxId: trash,
      uid: 7n,
      pendingSince: null,
    });
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, id));
    // 本文はそのまま使い、フラグは移動先の値にする。
    expect(message).toMatchObject({ bodyText: "本文", seen: true });
  });

  it("Message-ID の無いメールは、件名と受信日時で見分ける", async () => {
    const id = await movedToTrash(null, "見出しだけ");
    await insertMessages(
      db,
      account,
      trash,
      [fetched(8, undefined, "見出しだけ")],
      null,
    );
    const all = await db.select({ id: messages.id }).from(messages);
    expect(all.map((row) => row.id)).toEqual([id]);
    expect((await placementsOf(id))[0]?.uid).toBe(8n);
  });

  it("別のメールは結び付けずに取り込む", async () => {
    const id = await movedToTrash("<a@example.com>");
    await insertMessages(
      db,
      account,
      trash,
      [fetched(9, "<b@example.com>")],
      null,
    );
    const all = await db.select({ id: messages.id }).from(messages);
    expect(all).toHaveLength(2);
    expect((await placementsOf(id))[0]?.pendingSince).not.toBeNull();
  });

  it("時間が経っても結び付かない所在は外し、メールも消す", async () => {
    const old = await movedToTrash(
      "<old@example.com>",
      "古い",
      new Date(Date.now() - STALE_PENDING_MS - 1000),
    );
    const fresh = await movedToTrash("<new@example.com>");
    expect(await dropStalePending(db, account, trash)).toBe(1);
    const left = await db.select({ id: messages.id }).from(messages);
    expect(left.map((row) => row.id)).toEqual([fresh]);
    expect(left.map((row) => row.id)).not.toContain(old);
  });

  it("まだ反映していない移動があるあいだは片付けない", async () => {
    await movedToTrash(
      "<old@example.com>",
      "古い",
      new Date(Date.now() - STALE_PENDING_MS - 1000),
    );
    await db.insert(outbox).values({
      accountId: account.id,
      kind: "move",
      payload: { targets: [] },
      idempotencyKey: randomUUID(),
    });
    expect(await dropStalePending(db, account, trash)).toBe(0);
  });

  it("移動に失敗したら、移動先に置いた所在だけを外す", async () => {
    const id = await movedToTrash("<a@example.com>");
    // 受信トレイに戻った所在 (同期で取り込み直したもの) は残す。
    await db
      .insert(messageMailboxes)
      .values({ mailboxId: inbox, messageId: id, uid: 1n });
    await db.transaction((tx) =>
      dropPendingPlacements(tx, account, trash, [id]),
    );
    const rows = await placementsOf(id);
    expect(rows.map((row) => row.mailboxId)).toEqual([inbox]);
    const still = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, id)));
    expect(still).toHaveLength(1);
  });
});
