/**
 * 反映されなかった変更の API (/v1/calendars/conflicts) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  accounts,
  calendars,
  createDb,
  type Database,
  eventConflicts,
  events,
  outbox,
  users,
} from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { calendarConflictRoutes } from "./calendar-conflicts.js";
import { calendarRoutes } from "./calendars.js";

const adminUrl = process.env.DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!adminUrl)("反映されなかった変更の API", () => {
  const dbName = `mail_conflicts_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: Hono<AppEnv>;
  let otherApp: Hono<AppEnv>;
  let userId: string;
  let accountId: string;
  let googleCalendarId: string;

  const call = async (
    method: string,
    path: string,
    target: Hono<AppEnv> = app,
  ) => {
    const response = await target.request(`/calendars${path}`, { method });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as Json,
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
    const [other] = await db
      .insert(users)
      .values({ email: "other@example.com", name: "other" })
      .returning({ id: users.id });
    if (!user || !other) throw new Error("利用者を作れませんでした。");
    userId = user.id;
    const [account] = await db
      .insert(accounts)
      .values({
        userId,
        email: "owner@gmail.com",
        provider: "gmail",
        authType: "oauth2",
        username: "owner@gmail.com",
        credentialsEncrypted: "x",
        calendarEnabled: true,
      })
      .returning({ id: accounts.id });
    accountId = account?.id as string;
    const [calendar] = await db
      .insert(calendars)
      .values({
        userId,
        accountId,
        source: "google",
        remoteId: "primary",
        name: "Google",
      })
      .returning({ id: calendars.id });
    googleCalendarId = calendar?.id as string;

    const build = (id: string, email: string) => {
      const target = new Hono<AppEnv>();
      target.use(async (c, next) => {
        c.set("user", { id, email, name: email });
        await next();
      });
      // app.ts と同じ順に付ける。
      target.route("/calendars/conflicts", calendarConflictRoutes({ db }));
      target.route("/calendars", calendarRoutes({ db }));
      return target;
    };
    app = build(userId, "owner@example.com");
    otherApp = build(other.id, "other@example.com");
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

  beforeEach(async () => {
    await db.delete(eventConflicts);
    await db.delete(outbox);
  });

  const insertConflict = async (
    values: Partial<typeof eventConflicts.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(eventConflicts)
      .values({
        userId,
        calendarId: googleCalendarId,
        eventId: randomUUID(),
        kind: "field_lost",
        fields: ["summary"],
        lost: { summary: "自分の題" },
        title: "定例",
        reason: "相手側で後から変更された内容になりました。",
        ...values,
      })
      .returning();
    if (!row) throw new Error("記録を作れませんでした。");
    return row;
  };

  it("未解決の記録を新しい順に返し、閉じたものとほかの利用者には出さない", async () => {
    const older = await insertConflict({
      createdAt: new Date("2026-11-01T00:00:00Z"),
    });
    const newer = await insertConflict({
      kind: "remote_deleted",
      snapshot: { summary: "消えた予定", parentId: null, recurrenceId: null },
      createdAt: new Date("2026-11-02T00:00:00Z"),
    });
    await insertConflict({ resolvedAt: new Date() });
    const list = await call("GET", "/conflicts");
    expect(list.status).toBe(200);
    expect(list.body.conflicts).toEqual([
      {
        id: newer.id,
        calendarId: googleCalendarId,
        eventId: newer.eventId,
        kind: "remote_deleted",
        fields: ["summary"],
        lost: { summary: "自分の題" },
        snapshot: { summary: "消えた予定", parentId: null, recurrenceId: null },
        title: "定例",
        reason: "相手側で後から変更された内容になりました。",
        resendable: false,
        createdAt: "2026-11-02T00:00:00.000Z",
      },
      expect.objectContaining({ id: older.id }),
    ]);
    expect((await call("GET", "/conflicts", otherApp)).body.conflicts).toEqual(
      [],
    );
  });

  it("閉じると一覧と /sync の件数から消える。ほかの利用者は閉じられない", async () => {
    const row = await insertConflict();
    expect((await call("GET", "/sync")).body.openConflicts).toBe(1);
    expect(
      (await call("DELETE", `/conflicts/${row.id}`, otherApp)).status,
    ).toBe(404);
    const before = (await call("GET", "/sync")).body.latestSeq as string;
    expect((await call("DELETE", `/conflicts/${row.id}`)).status).toBe(204);
    // 閉じ済みでも 204。
    expect((await call("DELETE", `/conflicts/${row.id}`)).status).toBe(204);
    expect((await call("GET", "/conflicts")).body.conflicts).toEqual([]);
    const after = await call("GET", `/sync?since=${before}`);
    expect(after.body).toMatchObject({ openConflicts: 0, conflictsAt: null });
    // ほかの端末が件数を取り直せるよう、カレンダーの変更が載る。
    expect(
      (after.body.calendars as Json[]).map((calendar) => calendar.id),
    ).toEqual([googleCalendarId]);
    expect((await call("DELETE", `/conflicts/${randomUUID()}`)).status).toBe(
      404,
    );
  });

  it("作成の失敗をやり直すと、失敗した作成の書き戻しを pending に戻して記録を閉じる", async () => {
    const eventId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      userId,
      calendarId: googleCalendarId,
      uid: `${eventId}@orbit`,
      summary: "作れなかった予定",
      allDay: true,
      startDate: "2027-01-10",
      endDate: "2027-01-11",
    });
    await db.insert(outbox).values({
      accountId,
      kind: "event_create",
      payload: { eventId, calendarId: googleCalendarId },
      idempotencyKey: `event_create:${eventId}`,
      status: "failed",
      attempts: 3,
      lastError: "拒否された",
      firstFailedAt: new Date(),
    });
    const conflict = await insertConflict({ kind: "create_failed", eventId });
    expect((await call("POST", `/conflicts/${conflict.id}/retry`)).status).toBe(
      202,
    );
    const [row] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.accountId, accountId));
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
      firstFailedAt: null,
    });
    expect((await call("GET", "/conflicts")).body.conflicts).toEqual([]);
  });

  it("create_failed 以外はやり直せない (409)。書き戻しが無ければ 410", async () => {
    const lost = await insertConflict();
    expect((await call("POST", `/conflicts/${lost.id}/retry`)).status).toBe(
      409,
    );
    const missing = await insertConflict({ kind: "create_failed" });
    expect((await call("POST", `/conflicts/${missing.id}/retry`)).status).toBe(
      410,
    );
    expect(
      (await call("POST", `/conflicts/${missing.id}/retry`, otherApp)).status,
    ).toBe(404);
  });

  const imipPayload = (method: string, reason: string) => ({
    message: {
      to: [{ address: "a@example.com" }],
      calendar: { method, content: "" },
    },
    imip: {
      method,
      reason,
      userId,
      calendarId: googleCalendarId,
      eventId: randomUUID(),
      uid: `${randomUUID()}@orbit`,
      recurrenceId: null,
      sequence: 0,
      title: "定例",
    },
  });

  it("招待メールの失敗は resend-invite で outbox の行を pending に戻す。ほかは 409、ほかの利用者は 404", async () => {
    const [failed] = await db
      .insert(outbox)
      .values({
        accountId,
        kind: "imip_send",
        // 消した予定の取り消し (予定がもう無いので、送り直してよい)。
        payload: imipPayload("CANCEL", "delete"),
        idempotencyKey: `imip:event_delete:${randomUUID()}:CANCEL:0`,
        status: "failed",
        attempts: 5,
        lastError: "550 拒否",
        firstFailedAt: new Date(),
      })
      .returning({ id: outbox.id });
    const conflict = await insertConflict({
      kind: "invite_failed",
      fields: [],
      lost: { outboxId: failed?.id, method: "REQUEST", to: ["a@example.com"] },
      reason: "招待メールを送れませんでした: 550 拒否",
    });
    const listed = (await call("GET", "/conflicts")).body.conflicts as Json[];
    expect(listed[0]).toMatchObject({
      kind: "invite_failed",
      resendable: true,
    });
    // invite_failed は作成のやり直し (retry) の対象ではない。
    expect((await call("POST", `/conflicts/${conflict.id}/retry`)).status).toBe(
      409,
    );
    expect(
      (await call("POST", `/conflicts/${conflict.id}/resend-invite`, otherApp))
        .status,
    ).toBe(404);
    expect(
      (await call("POST", `/conflicts/${conflict.id}/resend-invite`)).status,
    ).toBe(202);
    const [row] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, failed?.id as string));
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
      firstFailedAt: null,
    });
    expect((await call("GET", "/conflicts")).body.conflicts).toEqual([]);
    // 2 回目は行が失敗のままでないので 409。
    expect(
      (await call("POST", `/conflicts/${conflict.id}/resend-invite`)).body,
    ).toEqual({ error: "not_resendable" });

    // 積んでいない (送信元が無かった) 失敗と、ほかの種類は送り直せない。
    const unsent = await insertConflict({
      kind: "invite_failed",
      fields: [],
      lost: { outboxId: null, method: "CANCEL", to: ["a@example.com"] },
    });
    expect(
      ((await call("GET", "/conflicts")).body.conflicts as Json[])[0],
    ).toMatchObject({ id: unsent.id, resendable: false });
    expect(
      (await call("POST", `/conflicts/${unsent.id}/resend-invite`)).status,
    ).toBe(409);
    const lost = await insertConflict();
    expect(
      (await call("POST", `/conflicts/${lost.id}/resend-invite`)).status,
    ).toBe(409);
    // 予定が消えた後の招待 (REQUEST) は送り直さない (L4)。
    const [staleRequest] = await db
      .insert(outbox)
      .values({
        accountId,
        kind: "imip_send",
        payload: imipPayload("REQUEST", "create"),
        idempotencyKey: `imip:event_create:${randomUUID()}:REQUEST:0`,
        status: "failed",
      })
      .returning({ id: outbox.id });
    const stale = await insertConflict({
      kind: "invite_failed",
      fields: [],
      lost: {
        outboxId: staleRequest?.id,
        method: "REQUEST",
        to: ["a@example.com"],
      },
    });
    expect(
      (await call("POST", `/conflicts/${stale.id}/resend-invite`)).body,
    ).toEqual({ error: "not_resendable" });
    expect(
      (await call("POST", `/conflicts/${randomUUID()}/resend-invite`)).status,
    ).toBe(404);
  });

  it("カレンダーがプロバイダのものでないときは、記録を閉じてから 410", async () => {
    const [local] = await db
      .insert(calendars)
      .values({ userId, source: "local", name: "ローカル" })
      .returning({ id: calendars.id });
    const conflict = await insertConflict({
      kind: "create_failed",
      calendarId: local?.id as string,
    });
    expect((await call("GET", "/conflicts")).body.conflicts).toHaveLength(1);
    expect((await call("POST", `/conflicts/${conflict.id}/retry`)).status).toBe(
      410,
    );
    expect((await call("GET", "/conflicts")).body.conflicts).toEqual([]);
    const [row] = await db
      .select({ resolvedAt: eventConflicts.resolvedAt })
      .from(eventConflicts)
      .where(eq(eventConflicts.id, conflict.id));
    expect(row?.resolvedAt).not.toBeNull();
  });
});
