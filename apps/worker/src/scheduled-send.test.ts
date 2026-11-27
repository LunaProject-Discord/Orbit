/**
 * 予約送信を実際の PostgreSQL で確かめる。DATABASE_URL が無い環境では実行しない。
 * 接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { OutgoingMessage, SendPayload } from "@orbit/core";
import { accounts, createDb, type Database, outbox, users } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountsWithPendingOutbox } from "./outbox.js";
import { processSends } from "./send.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("予約送信", () => {
  const dbName = `mail_schedule_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let account: typeof accounts.$inferSelect;

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
      .values({ email: "schedule@example.com", name: "schedule" })
      .returning({ id: users.id });
    const [created] = await db
      .insert(accounts)
      .values({
        userId: user?.id as string,
        email: "me@example.com",
        provider: "gmail",
        authType: "password",
        protocol: "imap",
        imapSecure: true,
        smtpHost: "smtp.example.com",
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

  it("予約の日時までは送らず、日時になったら送信時刻を付け直して送る", async () => {
    const message: OutgoingMessage = {
      from: { address: "me@example.com" },
      to: [{ address: "you@example.com" }],
      cc: [],
      bcc: [],
      subject: "予約",
      text: "本文",
      messageId: "<scheduled@example.com>",
      date: "2026-01-01T00:00:00.000Z",
      inReplyTo: null,
      references: [],
    };
    const payload: SendPayload = {
      message,
      sourceMessageId: null,
      mode: "new",
    };
    const at = new Date(Date.now() + 60 * 60_000);
    const [row] = await db
      .insert(outbox)
      .values({
        accountId: account.id,
        kind: "send",
        payload,
        idempotencyKey: randomUUID(),
        scheduledAt: at,
        runAfter: at,
      })
      .returning({ id: outbox.id });

    const sent: OutgoingMessage[] = [];
    const send = async (outgoing: OutgoingMessage) => {
      sent.push(outgoing);
      return { status: "sent" as const };
    };
    const first = await processSends(db, account, send, () => {});
    expect(first.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(first.nextRunAt?.getTime()).toBe(at.getTime());
    // 時刻になっていない予約では、定期的な確認でアカウントを起こさない。
    expect(await accountsWithPendingOutbox(db)).not.toContain(account.id);

    // 「今すぐ送信」と同じ変更。
    await db
      .update(outbox)
      .set({ runAfter: new Date(Date.now() - 1_000) })
      .where(eq(outbox.id, row?.id as string));
    expect(await accountsWithPendingOutbox(db)).toContain(account.id);
    const second = await processSends(db, account, send, () => {});
    expect(second.sent).toBe(1);
    expect(second.nextRunAt).toBeNull();
    expect(sent[0]?.messageId).toBe(message.messageId);
    expect(sent[0]?.date).not.toBe(message.date);
    expect(Date.now() - Date.parse(sent[0]?.date ?? "")).toBeLessThan(60_000);
    const [done] = await db
      .select({ status: outbox.status })
      .from(outbox)
      .where(eq(outbox.id, row?.id as string));
    expect(done?.status).toBe("done");
  });
});
