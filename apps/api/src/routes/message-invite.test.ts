/**
 * メールの招待の API (GET /v1/messages/:id/invite) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accounts,
  attachments,
  calendars,
  createDb,
  type Database,
  eventAttendees,
  events,
  messages,
  users,
} from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import type { EventsHub } from "../lib/events-hub.js";
import { MAX_INVITE_BYTES, messageInviteRoutes } from "./message-invite.js";

const adminUrl = process.env.DATABASE_URL;

type Json = Record<string, unknown>;

const UID = "invite-1@example.com";

function ics(method: string | null, extra: string[] = [], uid = UID): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...(method ? [`METHOD:${method}`] : []),
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTART;TZID=Asia/Tokyo:20261210T100000",
    "DTEND;TZID=Asia/Tokyo:20261210T110000",
    "SEQUENCE:1",
    "SUMMARY:設計レビュー",
    "LOCATION:会議室 B",
    "DESCRIPTION:メモは返さない",
    'ORGANIZER;CN="佐藤 花子":mailto:sato@example.com',
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@gmail.com",
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:suzuki@example.com",
    ...extra,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe.skipIf(!adminUrl)("メールの招待の API", () => {
  const dbName = `mail_invite_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let dir: string;
  let app: Hono<AppEnv>;
  let otherApp: Hono<AppEnv>;
  let userId: string;
  let otherId: string;
  let accountId: string;
  let secondAccountId: string;
  let otherAccountId: string;
  let calendarId: string;
  let secondCalendarId: string;
  let readOnlyCalendarId: string;
  let otherCalendarId: string;

  const call = async (messageId: string, target: Hono<AppEnv> = app) => {
    const response = await target.request(`/messages/${messageId}/invite`);
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
    dir = await mkdtemp(join(tmpdir(), "mail-invite-"));
    process.env.ATTACHMENTS_DIR = dir;

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
    otherId = other.id;
    const account = async (owner: string, email: string) => {
      const [row] = await db
        .insert(accounts)
        .values({
          userId: owner,
          email,
          provider: "gmail",
          authType: "oauth2",
          username: email,
          credentialsEncrypted: "x",
          calendarEnabled: true,
        })
        .returning({ id: accounts.id });
      return row?.id as string;
    };
    accountId = await account(userId, "owner@gmail.com");
    secondAccountId = await account(userId, "owner2@gmail.com");
    otherAccountId = await account(otherId, "other@gmail.com");
    const calendar = async (
      owner: string,
      account: string,
      readOnly = false,
    ) => {
      const [row] = await db
        .insert(calendars)
        .values({
          userId: owner,
          accountId: account,
          source: "google",
          remoteId: randomUUID(),
          name: "Google",
          readOnly,
        })
        .returning({ id: calendars.id });
      return row?.id as string;
    };
    calendarId = await calendar(userId, accountId);
    secondCalendarId = await calendar(userId, secondAccountId);
    readOnlyCalendarId = await calendar(userId, accountId, true);
    otherCalendarId = await calendar(otherId, otherAccountId);

    const hub = {} as EventsHub;
    const build = (id: string, email: string) => {
      const target = new Hono<AppEnv>();
      target.use(async (c, next) => {
        c.set("user", { id, email, name: email });
        await next();
      });
      target.route(
        "/messages",
        messageInviteRoutes({ db, hub, writebackSources: ["google"] }),
      );
      return target;
    };
    app = build(userId, "owner@example.com");
    otherApp = build(otherId, "other@example.com");
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
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.delete(events);
    await db.delete(messages);
  });

  /** メールと添付を作り、添付の実体を置き場に書く。 */
  const insertMessage = async (
    file: {
      content: string;
      contentType?: string;
      filename?: string | null;
      size?: number;
    },
    options: { owner?: string; account?: string } = {},
  ) => {
    const owner = options.owner ?? userId;
    const [message] = await db
      .insert(messages)
      .values({
        accountId: options.account ?? accountId,
        threadKey: randomUUID(),
        subject: "招待: 設計レビュー",
        receivedAt: new Date(),
        hasAttachments: true,
      })
      .returning({ id: messages.id });
    const body = Buffer.from(file.content, "utf8");
    const [attachment] = await db
      .insert(attachments)
      .values({
        messageId: message?.id as string,
        filename: file.filename ?? null,
        contentType: file.contentType ?? "text/calendar",
        size: file.size ?? body.byteLength,
        partId: "2",
      })
      .returning({ id: attachments.id });
    await mkdir(join(dir, owner), { recursive: true });
    await writeFile(join(dir, owner, attachment?.id as string), body);
    return message?.id as string;
  };

  const insertEvent = async (
    values: { calendarId?: string; owner?: string; sequence?: number } = {},
    self = true,
  ) => {
    const [row] = await db
      .insert(events)
      .values({
        userId: values.owner ?? userId,
        calendarId: values.calendarId ?? calendarId,
        uid: UID,
        summary: "設計レビュー (カレンダー)",
        startAt: new Date("2026-12-10T01:00:00Z"),
        endAt: new Date("2026-12-10T02:00:00Z"),
        sequence: values.sequence ?? 1,
        organizer: { email: "sato@example.com" },
      })
      .returning({ id: events.id });
    const id = row?.id as string;
    await db.insert(eventAttendees).values([
      { eventId: id, email: "owner@gmail.com", self },
      { eventId: id, email: "suzuki@example.com" },
    ]);
    return id;
  };

  it("REQUEST: 同じ UID の予定があれば、その ID と sequence を添える", async () => {
    const eventId = await insertEvent({ sequence: 3 });
    const messageId = await insertMessage({ content: ics("REQUEST") });
    const { status, body } = await call(messageId);
    expect(status).toBe(200);
    expect(body.invite).toEqual({
      method: "request",
      uid: UID,
      sequence: 1,
      recurrenceId: null,
      summary: "設計レビュー",
      location: "会議室 B",
      time: {
        allDay: false,
        startAt: "2026-12-10T01:00:00Z",
        endAt: "2026-12-10T02:00:00Z",
        startTimeZone: "Asia/Tokyo",
        endTimeZone: "Asia/Tokyo",
      },
      rrule: null,
      organizer: { email: "sato@example.com", name: "佐藤 花子" },
      attendeeCount: 2,
      reply: null,
      eventId,
      eventSequence: 3,
    });
    // メモ (DESCRIPTION) は返さない。
    expect(JSON.stringify(body)).not.toContain("メモは返さない");
  });

  it("REQUEST: 同じ UID の予定が無ければ eventId は null", async () => {
    const messageId = await insertMessage({ content: ics("REQUEST") });
    const { body } = await call(messageId);
    expect(body.invite).toMatchObject({
      method: "request",
      eventId: null,
      eventSequence: null,
    });
  });

  it("自分が参加者でない予定、読み取り専用のカレンダーの予定は拾わない", async () => {
    await insertEvent({}, false);
    await insertEvent({ calendarId: readOnlyCalendarId });
    const messageId = await insertMessage({ content: ics("REQUEST") });
    const { body } = await call(messageId);
    expect((body.invite as Json).eventId).toBeNull();
  });

  it("同じ予定が複数あれば、メールと同じアカウントのカレンダーを選ぶ", async () => {
    const secondAccount = await insertEvent({ calendarId: secondCalendarId });
    const sameAccount = await insertEvent({ calendarId });
    const messageId = await insertMessage({ content: ics("REQUEST") });
    expect(((await call(messageId)).body.invite as Json).eventId).toBe(
      sameAccount,
    );
    const fromSecond = await insertMessage(
      { content: ics("REQUEST") },
      { account: secondAccountId },
    );
    expect(((await call(fromSecond)).body.invite as Json).eventId).toBe(
      secondAccount,
    );
  });

  it("ほかの利用者の同じ UID の予定は拾わない", async () => {
    await insertEvent({ owner: otherId, calendarId: otherCalendarId });
    const messageId = await insertMessage({ content: ics("REQUEST") });
    expect(((await call(messageId)).body.invite as Json).eventId).toBeNull();
  });

  it("CANCEL と REPLY を見分け、REPLY は返事をした参加者を返す", async () => {
    const cancel = await insertMessage({
      content: ics("CANCEL", ["STATUS:CANCELLED"]),
    });
    expect(((await call(cancel)).body.invite as Json).method).toBe("cancel");

    const reply = await insertMessage({
      content: [
        "BEGIN:VCALENDAR",
        "METHOD:REPLY",
        "BEGIN:VEVENT",
        `UID:${UID}`,
        "DTSTART;VALUE=DATE:20261210",
        "ATTENDEE;CN=鈴木;PARTSTAT=DECLINED:mailto:suzuki@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      filename: "invite.ics",
      contentType: "application/octet-stream",
    });
    const { body } = await call(reply);
    expect(body.invite).toMatchObject({
      method: "reply",
      time: { allDay: true, startDate: "2026-12-10", endDate: "2026-12-11" },
      reply: { email: "suzuki@example.com", name: "鈴木", status: "declined" },
    });
  });

  it("METHOD が無ければ other", async () => {
    const messageId = await insertMessage({ content: ics(null) });
    expect(((await call(messageId)).body.invite as Json).method).toBe("other");
  });

  it("iCalendar でない添付、読めない中身は invite: null", async () => {
    const pdf = await insertMessage({
      content: "%PDF-1.4",
      contentType: "application/pdf",
      filename: "a.pdf",
    });
    expect(await call(pdf)).toEqual({ status: 200, body: { invite: null } });
    const broken = await insertMessage({ content: "BEGIN:VEVENT" });
    expect(await call(broken)).toEqual({ status: 200, body: { invite: null } });
  });

  it("1 MB を超える添付は読まない", async () => {
    const messageId = await insertMessage({
      content: ics("REQUEST"),
      size: MAX_INVITE_BYTES + 1,
    });
    expect(await call(messageId)).toEqual({
      status: 200,
      body: { invite: null },
    });
  });

  it("ほかの利用者のメールは 404", async () => {
    const messageId = await insertMessage({ content: ics("REQUEST") });
    expect((await call(messageId, otherApp)).status).toBe(404);
    expect((await call(randomUUID())).status).toBe(404);
  });
});
