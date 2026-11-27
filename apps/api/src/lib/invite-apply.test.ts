/**
 * メールの招待の反映 (GET /v1/messages/:id/invite の action と POST /v1/messages/:id/invite/apply) を、
 * 実際の PostgreSQL で確かめる (imip-design 7・8・10.3 章)。
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
  changes,
  createDb,
  type Database,
  eventAttendees,
  events,
  messages,
  outbox,
  users,
} from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { messageInviteRoutes } from "../routes/message-invite.js";
import type { EventsHub } from "./events-hub.js";

const adminUrl = process.env.DATABASE_URL;

type Json = Record<string, unknown>;

const UID = "imip-1@example.com";
const ORGANIZER = "sato@example.com";
const ME = "owner@gmail.com";

type IcsOptions = {
  method?: string;
  uid?: string;
  sequence?: number;
  dtstamp?: string;
  summary?: string;
  organizer?: string;
  attendees?: string[];
  start?: string;
  extra?: string[];
  recurrenceId?: string;
  /** 原本のあとに足す VEVENT (例外)。 */
  more?: string[][];
};

function vevent(options: IcsOptions): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${options.uid ?? UID}`,
    `DTSTAMP:${options.dtstamp ?? "20261127T000000Z"}`,
    `DTSTART;TZID=Asia/Tokyo:${options.start ?? "20261210T100000"}`,
    "DTEND;TZID=Asia/Tokyo:20261210T110000",
    ...(options.recurrenceId
      ? [`RECURRENCE-ID;TZID=Asia/Tokyo:${options.recurrenceId}`]
      : []),
    `SEQUENCE:${options.sequence ?? 1}`,
    `SUMMARY:${options.summary ?? "設計レビュー"}`,
    "LOCATION:会議室 B",
    `ORGANIZER;CN=佐藤:mailto:${options.organizer ?? ORGANIZER}`,
    ...(
      options.attendees ?? [
        `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ME}`,
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:suzuki@example.com",
      ]
    ).map((line) => (line.startsWith("ATTENDEE") ? line : `ATTENDEE:${line}`)),
    ...(options.extra ?? []),
    "END:VEVENT",
  ];
}

function ics(options: IcsOptions = {}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${options.method ?? "REQUEST"}`,
    ...vevent(options),
    ...(options.more ?? []).flat(),
    "END:VCALENDAR",
  ].join("\r\n");
}

const verified = { verified: true, warnings: [], claimed: null, version: 2 };
const unknown = { verified: false, warnings: [], claimed: null, version: 2 };
const dmarcFail = {
  verified: false,
  warnings: ["dmarc_fail" as const],
  claimed: null,
  version: 2,
};

describe.skipIf(!adminUrl)("メールの招待の反映", () => {
  const dbName = `mail_invite_apply_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let dir: string;
  let app: Hono<AppEnv>;
  let otherApp: Hono<AppEnv>;
  let userId: string;
  let otherId: string;
  let accountId: string;
  let caldavAccountId: string;
  let otherAccountId: string;
  let localId: string;
  let googleId: string;
  let caldavId: string;
  let caldavAutoId: string;
  let otherLocalId: string;

  const get = async (messageId: string, target: Hono<AppEnv> = app) => {
    const response = await target.request(`/messages/${messageId}/invite`);
    const text = await response.text();
    return {
      status: response.status,
      invite: (text ? JSON.parse(text).invite : null) as Json,
    };
  };

  const apply = async (
    messageId: string,
    body: Json,
    target: Hono<AppEnv> = app,
  ) => {
    const response = await target.request(
      `/messages/${messageId}/invite/apply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
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
    dir = await mkdtemp(join(tmpdir(), "mail-invite-apply-"));
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
    const account = async (owner: string, email: string, provider: string) => {
      const [row] = await db
        .insert(accounts)
        .values({
          userId: owner,
          email,
          provider,
          authType: "oauth2",
          username: email,
          credentialsEncrypted: "x",
          calendarEnabled: true,
          // 送信できるアカウント (Orbit 内と CalDAV のカレンダーの scheduling が mail になる)。
          smtpHost: "smtp.example.com",
        })
        .returning({ id: accounts.id });
      return row?.id as string;
    };
    accountId = await account(userId, ME, "gmail");
    caldavAccountId = await account(userId, "me@dav.example", "generic");
    otherAccountId = await account(otherId, "other@gmail.com", "gmail");
    const calendar = async (
      values: Partial<typeof calendars.$inferInsert> & {
        userId: string;
        source: (typeof calendars.$inferInsert)["source"];
      },
    ) => {
      const [row] = await db
        .insert(calendars)
        .values({ name: values.source, ...values })
        .returning({ id: calendars.id });
      return row?.id as string;
    };
    googleId = await calendar({
      userId,
      accountId,
      source: "google",
      remoteId: "google",
      sortOrder: 0,
    });
    localId = await calendar({ userId, source: "local", sortOrder: 1 });
    caldavId = await calendar({
      userId,
      accountId: caldavAccountId,
      source: "caldav",
      remoteId: "/dav/cal/",
      providerState: { autoSchedule: false },
      sortOrder: 2,
    });
    caldavAutoId = await calendar({
      userId,
      accountId: caldavAccountId,
      source: "caldav",
      remoteId: "/dav/auto/",
      providerState: { autoSchedule: true },
      sortOrder: 3,
    });
    otherLocalId = await calendar({ userId: otherId, source: "local" });

    const hub = {} as EventsHub;
    const build = (id: string, email: string) => {
      const target = new Hono<AppEnv>();
      target.use(async (c, next) => {
        c.set("user", { id, email, name: email });
        await next();
      });
      target.route(
        "/messages",
        messageInviteRoutes({
          db,
          hub,
          writebackSources: ["google", "microsoft", "caldav"],
        }),
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
    await db.delete(outbox);
    await db.delete(changes);
  });

  /** 招待のメールを作り、添付の実体を置き場に書く。 */
  const insertMessage = async (
    content: string,
    options: {
      from?: string;
      senderCheck?: Record<string, unknown> | null;
      owner?: string;
      account?: string;
      receivedAt?: Date;
    } = {},
  ) => {
    const owner = options.owner ?? userId;
    const [message] = await db
      .insert(messages)
      .values({
        accountId: options.account ?? accountId,
        threadKey: randomUUID(),
        subject: "招待",
        from: [{ address: options.from ?? ORGANIZER }],
        senderCheck: (options.senderCheck === undefined
          ? verified
          : options.senderCheck) as typeof verified | null,
        sentAt: new Date("2026-11-27T00:00:00Z"),
        receivedAt: options.receivedAt ?? new Date("2026-11-27T00:00:01Z"),
        hasAttachments: true,
      })
      .returning({ id: messages.id });
    const body = Buffer.from(content, "utf8");
    const [attachment] = await db
      .insert(attachments)
      .values({
        messageId: message?.id as string,
        filename: "invite.ics",
        contentType: "text/calendar",
        size: body.byteLength,
        partId: "2",
      })
      .returning({ id: attachments.id });
    await mkdir(join(dir, owner), { recursive: true });
    await writeFile(join(dir, owner, attachment?.id as string), body);
    return message?.id as string;
  };

  const eventsOf = (calendarId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendarId))
      .orderBy(events.recurrenceId);

  const attendeesOf = (eventId: string) =>
    db
      .select()
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId))
      .orderBy(eventAttendees.email);

  /** 招待を Orbit 内のカレンダーに取り込む。 */
  const imported = async (options: IcsOptions = {}) => {
    const messageId = await insertMessage(ics(options));
    const result = await apply(messageId, {
      expect: "import",
      calendarId: localId,
    });
    expect(result.status).toBe(200);
    return result.body.eventId as string;
  };

  describe("取り込み (import)", () => {
    it("取り込める先を返し、追加すると予定と参加者 (self) ができる。2 回目は applied: false", async () => {
      const messageId = await insertMessage(ics());
      const { invite } = await get(messageId);
      expect(invite).toMatchObject({
        dtstamp: "2026-11-27T00:00:00Z",
        sender: { email: ORGANIZER, matches: true, auth: "verified" },
        action: "import",
        actionState: "ready",
        blocked: null,
        // Google と自動スケジュールの CalDAV は候補に入れない。既定は最初の Orbit 内のカレンダー。
        calendars: [
          { id: localId, default: true },
          { id: caldavId, default: false },
        ],
      });

      const first = await apply(messageId, { expect: "import" });
      expect(first).toMatchObject({ status: 200, body: { applied: true } });
      const eventId = first.body.eventId as string;
      const [row] = await eventsOf(localId);
      expect(row).toMatchObject({
        id: eventId,
        uid: UID,
        summary: "設計レビュー",
        sequence: 1,
        organizer: { email: ORGANIZER, name: "佐藤", self: false },
        startAt: new Date("2026-12-10T01:00:00Z"),
        inviteStamp: new Date("2026-11-27T00:00:00Z"),
        raw: null,
      });
      expect(
        (await attendeesOf(eventId)).map((a) => [a.email, a.status, a.self]),
      ).toEqual([
        [ME, "needs_action", true],
        ["suzuki@example.com", "accepted", false],
      ]);
      // 端末の同期に乗る。Orbit 内なので書き戻しは積まない。
      const recorded = await db
        .select()
        .from(changes)
        .where(eq(changes.entityId, eventId));
      expect(recorded).toHaveLength(1);
      expect(await db.select().from(outbox)).toEqual([]);

      expect((await get(messageId)).invite).toMatchObject({
        action: "update",
        actionState: "done",
        eventId,
      });
      expect(await apply(messageId, { expect: "import" })).toEqual({
        status: 200,
        body: { applied: false, eventId },
      });
      expect(await eventsOf(localId)).toHaveLength(1);
    });

    it("原本と例外をまとめて入れ、例外の parentId は原本", async () => {
      const content = ics({
        extra: ["RRULE:FREQ=WEEKLY;COUNT=4"],
        more: [
          vevent({
            recurrenceId: "20261217T100000",
            start: "20261217T150000",
            summary: "設計レビュー (この回だけ午後)",
          }),
        ],
      });
      const messageId = await insertMessage(content);
      const result = await apply(messageId, {
        expect: "import",
        calendarId: localId,
      });
      expect(result.status).toBe(200);
      const rows = await eventsOf(localId);
      expect(rows).toHaveLength(2);
      const master = rows.find((row) => row.recurrenceId === null);
      const exception = rows.find((row) => row.recurrenceId !== null);
      expect(master?.rrule).toBe("FREQ=WEEKLY;COUNT=4");
      expect(exception?.parentId).toBe(master?.id);
      expect(result.body.eventId).toBe(master?.id);
    });

    it("自分宛てでない招待は self なしで取り込む", async () => {
      const eventId = await imported({
        attendees: ["ATTENDEE:mailto:list@example.com"],
      });
      expect((await attendeesOf(eventId)).map((a) => a.self)).toEqual([false]);
    });

    it("CalDAV のカレンダーへ取り込むと作成の書き戻しを積む (招待メールは積まない)", async () => {
      const messageId = await insertMessage(ics());
      const result = await apply(messageId, {
        expect: "import",
        calendarId: caldavId,
      });
      expect(result.status).toBe(200);
      const rows = await db.select().from(outbox);
      expect(rows.map((row) => [row.kind, row.accountId])).toEqual([
        ["event_create", caldavAccountId],
      ]);
      expect(rows[0]?.payload).toEqual({
        eventId: result.body.eventId,
        calendarId: caldavId,
      });
    });

    it("取り込めない先 (Google、自動スケジュールの CalDAV、ほかの利用者のカレンダー) は断る", async () => {
      const messageId = await insertMessage(ics());
      expect(
        await apply(messageId, { expect: "import", calendarId: googleId }),
      ).toEqual({ status: 409, body: { error: "server_calendar" } });
      expect(
        await apply(messageId, { expect: "import", calendarId: caldavAutoId }),
      ).toEqual({ status: 409, body: { error: "server_calendar" } });
      expect(
        await apply(messageId, { expect: "import", calendarId: otherLocalId }),
      ).toEqual({ status: 404, body: { error: "not_found" } });
      expect(await db.select().from(events)).toEqual([]);
    });

    it("送信元の認証に失敗したメールは確認が要る (confirmed なしは 409)", async () => {
      const messageId = await insertMessage(ics(), { senderCheck: dmarcFail });
      expect((await get(messageId)).invite).toMatchObject({
        sender: { auth: "failed" },
        action: "import",
        actionState: "confirm",
      });
      expect(await apply(messageId, { expect: "import" })).toEqual({
        status: 409,
        body: { error: "sender_unverified" },
      });
      expect(
        (await apply(messageId, { expect: "import", confirmed: true })).status,
      ).toBe(200);
    });

    it("差出人と主催者が違っても追加できる (matches: false)", async () => {
      const messageId = await insertMessage(ics(), {
        from: "someone@example.net",
      });
      expect((await get(messageId)).invite).toMatchObject({
        sender: { email: "someone@example.net", matches: false },
        actionState: "ready",
      });
    });

    it("送信元の確認がまだのメール、自分が主催者の招待、未対応の METHOD は追加しない", async () => {
      const pending = await insertMessage(ics(), { senderCheck: null });
      expect((await get(pending)).invite).toMatchObject({
        sender: { auth: "pending" },
        actionState: "blocked",
        blocked: "sender_unverified",
      });
      const own = await insertMessage(ics({ organizer: ME }), { from: ME });
      expect((await get(own)).invite).toMatchObject({
        action: "import",
        blocked: "own_event",
      });
      expect(await apply(own, { expect: "import" })).toEqual({
        status: 409,
        body: { error: "own_event" },
      });
      const counter = await insertMessage(ics({ method: "COUNTER" }));
      expect((await get(counter)).invite).toMatchObject({
        action: "none",
        blocked: "unsupported_method",
      });
      const delegated = await insertMessage(
        ics({ extra: [] }).replace(
          "ORGANIZER;CN=佐藤:",
          'ORGANIZER;CN=佐藤;SENT-BY="mailto:secretary@example.com":',
        ),
      );
      expect((await get(delegated)).invite).toMatchObject({
        blocked: "unsupported_method",
      });
      expect(await db.select().from(events)).toEqual([]);
    });

    it("カードを出した後に状況が変わった (expect の食い違い) は 409 changed", async () => {
      const messageId = await insertMessage(ics());
      expect(await apply(messageId, { expect: "remove" })).toEqual({
        status: 409,
        body: { error: "changed" },
      });
    });

    it("Google のカレンダーに同じ予定があれば、メールからは書かない", async () => {
      await db.insert(events).values({
        userId,
        calendarId: googleId,
        uid: UID,
        startAt: new Date("2026-12-10T01:00:00Z"),
        endAt: new Date("2026-12-10T02:00:00Z"),
      });
      const messageId = await insertMessage(ics());
      expect((await get(messageId)).invite).toMatchObject({
        action: "none",
        blocked: "server_calendar",
      });
    });
  });

  describe("更新 (update)", () => {
    it("SEQUENCE が上がった招待で上書きし、自分の出欠を未返信に戻す", async () => {
      const eventId = await imported();
      await db
        .update(eventAttendees)
        .set({ status: "accepted" })
        .where(
          and(
            eq(eventAttendees.eventId, eventId),
            eq(eventAttendees.self, true),
          ),
        );
      const messageId = await insertMessage(
        ics({
          sequence: 2,
          dtstamp: "20261128T000000Z",
          summary: "設計レビュー (延期)",
          start: "20261211T100000",
        }),
      );
      expect((await get(messageId)).invite).toMatchObject({
        action: "update",
        actionState: "ready",
        eventId,
      });
      expect(await apply(messageId, { expect: "update" })).toEqual({
        status: 200,
        body: { applied: true, eventId },
      });
      const [row] = await eventsOf(localId);
      expect(row).toMatchObject({
        summary: "設計レビュー (延期)",
        sequence: 2,
        startAt: new Date("2026-12-11T01:00:00Z"),
        inviteStamp: new Date("2026-11-28T00:00:00Z"),
      });
      const me = (await attendeesOf(eventId)).find((a) => a.self);
      expect(me?.status).toBe("needs_action");
      expect((await get(messageId)).invite).toMatchObject({
        actionState: "done",
      });
    });

    it("SEQUENCE が同じで DTSTAMP が新しい招待は、出欠を残して上書きする", async () => {
      const eventId = await imported();
      await db
        .update(eventAttendees)
        .set({ status: "accepted", comment: "行きます" })
        .where(
          and(
            eq(eventAttendees.eventId, eventId),
            eq(eventAttendees.self, true),
          ),
        );
      const messageId = await insertMessage(
        ics({
          dtstamp: "20261128T000000Z",
          summary: "設計レビュー (場所変更)",
        }),
      );
      expect((await apply(messageId, { expect: "update" })).status).toBe(200);
      const me = (await attendeesOf(eventId)).find((a) => a.self);
      expect(me).toMatchObject({ status: "accepted", comment: "行きます" });
    });

    it("古い招待は stale で、反映しない", async () => {
      const eventId = await imported({
        sequence: 3,
        dtstamp: "20261128T000000Z",
      });
      const messageId = await insertMessage(ics({ sequence: 2 }));
      expect((await get(messageId)).invite).toMatchObject({
        action: "update",
        actionState: "stale",
      });
      expect(await apply(messageId, { expect: "update" })).toEqual({
        status: 200,
        body: { applied: false, eventId },
      });
      expect((await eventsOf(localId))[0]?.sequence).toBe(3);
    });

    it("なりすまし: From が主催者と違う・認証の失敗・ORGANIZER のすり替えは断る", async () => {
      await imported();
      const newer = { sequence: 2, summary: "偽の更新" };
      const cases: [string, Parameters<typeof insertMessage>[1], string][] = [
        [ics(newer), { from: "mallory@example.net" }, "sender_mismatch"],
        [ics(newer), { senderCheck: dmarcFail }, "sender_unverified"],
        [ics(newer), { senderCheck: null }, "sender_unverified"],
        // UID を合わせ、ORGANIZER と From を自分のアドレスにした偽の更新。
        [
          ics({ ...newer, organizer: "mallory@example.net" }),
          { from: "mallory@example.net" },
          "sender_mismatch",
        ],
      ];
      for (const [content, options, error] of cases) {
        const messageId = await insertMessage(content, options);
        expect((await get(messageId)).invite).toMatchObject({
          action: "update",
          actionState: "blocked",
          blocked: error,
        });
        expect(await apply(messageId, { expect: "update" })).toEqual({
          status: 409,
          body: { error },
        });
      }
      expect((await eventsOf(localId))[0]?.summary).toBe("設計レビュー");
    });

    it("自分が主催する予定は、届いた REQUEST で変えない", async () => {
      const [row] = await db
        .insert(events)
        .values({
          userId,
          calendarId: localId,
          uid: UID,
          summary: "自分の会議",
          startAt: new Date("2026-12-10T01:00:00Z"),
          endAt: new Date("2026-12-10T02:00:00Z"),
          organizer: { email: ORGANIZER, self: true },
        })
        .returning({ id: events.id });
      await db
        .insert(eventAttendees)
        .values({ eventId: row?.id as string, email: "suzuki@example.com" });
      const messageId = await insertMessage(ics({ sequence: 5 }));
      expect(await apply(messageId, { expect: "update" })).toEqual({
        status: 409,
        body: { error: "own_event" },
      });
    });

    it("CalDAV の予定の更新は書き戻しを積む", async () => {
      const first = await insertMessage(ics());
      await apply(first, { expect: "import", calendarId: caldavId });
      await db.delete(outbox);
      const messageId = await insertMessage(ics({ sequence: 2 }));
      expect((await apply(messageId, { expect: "update" })).status).toBe(200);
      const rows = await db.select().from(outbox);
      expect(rows.map((row) => row.kind)).toEqual(["event_update"]);
      expect((rows[0]?.payload as Json).fields).toEqual([
        "attendees",
        "conferenceUrl",
        "description",
        "location",
        "recurrence",
        "status",
        "summary",
        "time",
      ]);
    });

    it("例外の行が無い回の変更は対象外", async () => {
      await imported({ extra: ["RRULE:FREQ=WEEKLY;COUNT=4"] });
      const messageId = await insertMessage(
        ics({ recurrenceId: "20261217T100000", sequence: 2 }),
      );
      expect((await get(messageId)).invite).toMatchObject({
        action: "update",
        blocked: "occurrence_unsupported",
      });
    });
  });

  describe("取り消し (remove)", () => {
    it("CANCEL で予定を消す。消した後は done", async () => {
      const eventId = await imported();
      const messageId = await insertMessage(
        ics({ method: "CANCEL", sequence: 2, extra: ["STATUS:CANCELLED"] }),
      );
      expect((await get(messageId)).invite).toMatchObject({
        action: "remove",
        actionState: "ready",
        eventId,
      });
      expect(await apply(messageId, { expect: "remove" })).toEqual({
        status: 200,
        body: { applied: true, eventId },
      });
      expect(await eventsOf(localId)).toEqual([]);
      const recorded = await db
        .select({ op: changes.op })
        .from(changes)
        .where(eq(changes.entityId, eventId));
      expect(recorded.map((row) => row.op)).toContain("delete");
      expect((await get(messageId)).invite).toMatchObject({
        action: "remove",
        actionState: "done",
      });
      expect(await apply(messageId, { expect: "remove" })).toEqual({
        status: 200,
        body: { applied: false, eventId: null },
      });
    });

    it("RECURRENCE-ID 付きの CANCEL は、その回を EXDATE に足す", async () => {
      await imported({ extra: ["RRULE:FREQ=WEEKLY;COUNT=4"] });
      const messageId = await insertMessage(
        ics({ method: "CANCEL", recurrenceId: "20261217T100000" }),
      );
      expect((await apply(messageId, { expect: "remove" })).status).toBe(200);
      const [master] = await eventsOf(localId);
      expect(master?.exdates).toEqual(["2026-12-17T01:00:00Z"]);
      expect((await get(messageId)).invite).toMatchObject({
        actionState: "done",
      });
    });

    it("差出人が予定の主催者と違う CANCEL は断る", async () => {
      await imported();
      const messageId = await insertMessage(ics({ method: "CANCEL" }), {
        from: "mallory@example.net",
      });
      expect(await apply(messageId, { expect: "remove" })).toEqual({
        status: 409,
        body: { error: "sender_mismatch" },
      });
      expect(await eventsOf(localId)).toHaveLength(1);
    });

    it("CalDAV の予定を消すと、作成の書き戻し待ちを取り消す", async () => {
      const first = await insertMessage(ics());
      await apply(first, { expect: "import", calendarId: caldavId });
      const messageId = await insertMessage(ics({ method: "CANCEL" }));
      expect((await apply(messageId, { expect: "remove" })).status).toBe(200);
      // まだ相手側に作っていないので、削除も積まない。
      expect(await db.select().from(outbox)).toEqual([]);
      expect(await eventsOf(caldavId)).toEqual([]);
    });
  });

  describe("REPLY の反映 (apply_reply)", () => {
    /** 自分が主催する予定 (Orbit 内のカレンダー)。 */
    const organized = async (
      values: Partial<typeof events.$inferInsert> = {},
    ) => {
      const [row] = await db
        .insert(events)
        .values({
          userId,
          calendarId: localId,
          uid: UID,
          summary: "自分の会議",
          startAt: new Date("2026-12-10T01:00:00Z"),
          endAt: new Date("2026-12-10T02:00:00Z"),
          organizer: { email: ME, self: true },
          sequence: 1,
          ...values,
        })
        .returning({ id: events.id });
      const id = row?.id as string;
      await db.insert(eventAttendees).values([
        { eventId: id, email: "suzuki@example.com" },
        { eventId: id, email: "tanaka@example.com" },
      ]);
      return id;
    };

    const reply = (
      status = "ACCEPTED",
      options: IcsOptions & { who?: string } = {},
    ) =>
      ics({
        method: "REPLY",
        organizer: ME,
        attendees: [
          `ATTENDEE;CN=鈴木;PARTSTAT=${status}:mailto:${options.who ?? "suzuki@example.com"}`,
        ],
        extra: ["COMMENT:少し遅れます"],
        ...options,
      });

    it("検証済みの REPLY も自動では反映せず ready (ボタン)。反映すると出欠・コメント・replied_at が入り、2 回目は done", async () => {
      const eventId = await organized();
      const messageId = await insertMessage(reply(), {
        from: "suzuki@example.com",
      });
      expect((await get(messageId)).invite).toMatchObject({
        sender: {
          email: "suzuki@example.com",
          matches: true,
          auth: "verified",
        },
        action: "apply_reply",
        actionState: "ready",
        eventId,
      });
      expect(await apply(messageId, { expect: "apply_reply" })).toEqual({
        status: 200,
        body: { applied: true, eventId },
      });
      const suzuki = (await attendeesOf(eventId)).find(
        (a) => a.email === "suzuki@example.com",
      );
      expect(suzuki).toMatchObject({
        status: "accepted",
        comment: "少し遅れます",
        repliedAt: new Date("2026-11-27T00:00:00Z"),
        replySequence: 1,
      });
      expect((await get(messageId)).invite).toMatchObject({
        actionState: "done",
      });
      expect(await apply(messageId, { expect: "apply_reply" })).toEqual({
        status: 200,
        body: { applied: false, eventId },
      });
      // 古い返事 (DTSTAMP が前) は反映しない。
      const older = await insertMessage(
        reply("DECLINED", { dtstamp: "20261126T000000Z" }),
        { from: "suzuki@example.com" },
      );
      expect((await apply(older, { expect: "apply_reply" })).body).toEqual({
        applied: false,
        eventId,
      });
      expect(
        (await attendeesOf(eventId)).find(
          (a) => a.email === "suzuki@example.com",
        )?.status,
      ).toBe("accepted");
    });

    it("認証の結果が無い REPLY は ready (ボタン)", async () => {
      await organized();
      const messageId = await insertMessage(reply(), {
        from: "suzuki@example.com",
        senderCheck: unknown,
      });
      expect((await get(messageId)).invite).toMatchObject({
        sender: { auth: "unknown" },
        actionState: "ready",
      });
    });

    it("8.2 の検査: 差出人違い・認証の失敗・参加者でない・SEQUENCE 違い・例外の行が無い回・未知の PARTSTAT", async () => {
      const eventId = await organized({ rrule: "FREQ=WEEKLY;COUNT=4" });
      const cases: [string, Parameters<typeof insertMessage>[1], Json][] = [
        [
          reply(),
          { from: "mallory@example.net" },
          { actionState: "blocked", blocked: "sender_mismatch" },
        ],
        [
          reply().replace(
            "ATTENDEE;CN=鈴木;",
            'ATTENDEE;CN=鈴木;SENT-BY="mailto:secretary@example.com";',
          ),
          { from: "suzuki@example.com" },
          { blocked: "sender_mismatch" },
        ],
        [
          reply(),
          { from: "suzuki@example.com", senderCheck: dmarcFail },
          { blocked: "sender_unverified" },
        ],
        [
          reply("ACCEPTED", { who: "mallory@example.net" }),
          { from: "mallory@example.net" },
          { blocked: "not_attendee_of_event" },
        ],
        [
          reply("ACCEPTED", { sequence: 0 }),
          { from: "suzuki@example.com" },
          { actionState: "stale", blocked: null },
        ],
        [
          reply("ACCEPTED", { recurrenceId: "20261217T100000" }),
          { from: "suzuki@example.com" },
          { blocked: "occurrence_unsupported" },
        ],
        [
          reply("DELEGATED"),
          { from: "suzuki@example.com" },
          { blocked: "unsupported_method" },
        ],
      ];
      for (const [content, options, expected] of cases) {
        const messageId = await insertMessage(content, options);
        const { invite } = await get(messageId);
        expect(invite, JSON.stringify(expected)).toMatchObject({
          action: "apply_reply",
          ...expected,
        });
        const result = await apply(messageId, { expect: "apply_reply" });
        if (expected.blocked) {
          expect(result).toEqual({
            status: 409,
            body: { error: expected.blocked },
          });
        } else {
          expect(result.body.applied).toBe(false);
        }
      }
      expect(
        (await attendeesOf(eventId)).every(
          (a) => a.status === "needs_action" && a.repliedAt === null,
        ),
      ).toBe(true);
    });

    it("この回だけの REPLY は、その回の例外の行に反映する", async () => {
      const master = await organized({ rrule: "FREQ=WEEKLY;COUNT=4" });
      const exception = await organized({
        recurrenceId: "2026-12-17T01:00:00Z",
        parentId: master,
        rrule: null,
        startAt: new Date("2026-12-17T01:00:00Z"),
        endAt: new Date("2026-12-17T02:00:00Z"),
      });
      const messageId = await insertMessage(
        reply("TENTATIVE", { recurrenceId: "20261217T100000" }),
        { from: "suzuki@example.com" },
      );
      expect(await apply(messageId, { expect: "apply_reply" })).toEqual({
        status: 200,
        body: { applied: true, eventId: exception },
      });
      const statuses = async (id: string) =>
        (await attendeesOf(id)).find((a) => a.email === "suzuki@example.com")
          ?.status;
      expect(await statuses(exception)).toBe("tentative");
      expect(await statuses(master)).toBe("needs_action");
    });

    it("サービスのカレンダーの予定への REPLY は書かない。主催していない予定には操作なし", async () => {
      const [row] = await db
        .insert(events)
        .values({
          userId,
          calendarId: googleId,
          uid: UID,
          startAt: new Date("2026-12-10T01:00:00Z"),
          endAt: new Date("2026-12-10T02:00:00Z"),
          organizer: { email: ME, self: true },
        })
        .returning({ id: events.id });
      await db
        .insert(eventAttendees)
        .values({ eventId: row?.id as string, email: "suzuki@example.com" });
      const messageId = await insertMessage(reply(), {
        from: "suzuki@example.com",
      });
      expect((await get(messageId)).invite).toMatchObject({
        action: "apply_reply",
        blocked: "server_calendar",
      });
      await db.delete(events);
      expect((await get(messageId)).invite).toMatchObject({
        action: "none",
        blocked: null,
      });
    });

    it("CalDAV の予定なら、参加者の書き戻しを積む (招待メールは積まない)", async () => {
      const eventId = await organized({ calendarId: caldavId });
      const messageId = await insertMessage(reply(), {
        from: "suzuki@example.com",
      });
      expect((await apply(messageId, { expect: "apply_reply" })).status).toBe(
        200,
      );
      const rows = await db.select().from(outbox);
      expect(rows.map((row) => [row.kind, row.payload])).toEqual([
        [
          "event_update",
          { eventId, calendarId: caldavId, fields: ["attendees"] },
        ],
      ]);
    });
  });

  describe("レビュー 8b の指摘", () => {
    it("指摘 1: 照合を入れる前に保存した送信元の確認結果 (版なし) は、確認中として扱う", async () => {
      const messageId = await insertMessage(ics(), {
        senderCheck: { verified: true, warnings: [], claimed: null },
      });
      expect((await get(messageId)).invite).toMatchObject({
        sender: { auth: "pending" },
        actionState: "blocked",
        blocked: "sender_unverified",
      });
    });

    it("指摘 2: 認証の結果が無いメールの更新・取り消しは確認が要る (confirmed なしは 409)", async () => {
      const eventId = await imported();
      const update = await insertMessage(ics({ sequence: 2 }), {
        senderCheck: unknown,
      });
      expect((await get(update)).invite).toMatchObject({
        action: "update",
        actionState: "confirm",
        confirmReason: "sender_unverified",
      });
      expect(await apply(update, { expect: "update" })).toEqual({
        status: 409,
        body: { error: "sender_unverified" },
      });
      expect((await eventsOf(localId))[0]?.sequence).toBe(1);
      expect(
        (await apply(update, { expect: "update", confirmed: true })).body,
      ).toEqual({ applied: true, eventId });

      const cancel = await insertMessage(
        ics({ method: "CANCEL", sequence: 2 }),
        { senderCheck: unknown },
      );
      expect((await get(cancel)).invite).toMatchObject({
        action: "remove",
        actionState: "confirm",
        confirmReason: "sender_unverified",
      });
      expect((await apply(cancel, { expect: "remove" })).status).toBe(409);
      expect(await eventsOf(localId)).toHaveLength(1);
      expect(
        (await apply(cancel, { expect: "remove", confirmed: true })).body,
      ).toEqual({ applied: true, eventId });
      expect(await eventsOf(localId)).toEqual([]);
    });

    it("指摘 4: SEQUENCE が上限を超える招待は扱わず、大きく飛ぶ更新は確認を挟む", async () => {
      const huge = await insertMessage(ics({ sequence: 9_999_999_999 }));
      expect((await get(huge)).invite).toBeNull();
      expect(await apply(huge, { expect: "import" })).toEqual({
        status: 409,
        body: { error: "unsupported_method" },
      });
      const eventId = await imported();
      const jump = await insertMessage(ics({ sequence: 2000 }));
      expect((await get(jump)).invite).toMatchObject({
        action: "update",
        actionState: "confirm",
        confirmReason: "sequence_jump",
      });
      expect((await apply(jump, { expect: "update" })).status).toBe(409);
      // 本物の次の更新は、そのまま反映できる。
      const next = await insertMessage(ics({ sequence: 3 }));
      expect(await apply(next, { expect: "update" })).toEqual({
        status: 200,
        body: { applied: true, eventId },
      });
    });

    it("指摘 5: 長い UID・参加者 500 人超・1 秒ごとの繰り返しは扱わず、長い文字は切り詰め、形の悪いアドレスは落とす", async () => {
      expect(
        (await get(await insertMessage(ics({ uid: `${"u".repeat(300)}@x` }))))
          .invite,
      ).toBeNull();
      const many = Array.from(
        { length: 501 },
        (_, index) => `ATTENDEE:mailto:p${index}@example.com`,
      );
      expect(
        (await get(await insertMessage(ics({ attendees: many })))).invite,
      ).toBeNull();
      expect(
        (
          await get(
            await insertMessage(
              ics({ extra: ["RRULE:FREQ=SECONDLY;INTERVAL=1"] }),
            ),
          )
        ).invite,
      ).toBeNull();
      const messageId = await insertMessage(
        ics({
          summary: "a".repeat(300_000),
          attendees: [
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`,
            `ATTENDEE;CN=${"n".repeat(50_000)}:mailto:suzuki@example.com`,
            "ATTENDEE:mailto:a b@c d",
          ],
        }),
      );
      const result = await apply(messageId, { expect: "import" });
      expect(result, JSON.stringify(result.body)).toMatchObject({
        status: 200,
      });
      const [row] = await eventsOf(localId);
      expect(row?.summary).toHaveLength(1000);
      const attendees = await attendeesOf(result.body.eventId as string);
      expect(attendees.map((a) => a.email)).toEqual([ME, "suzuki@example.com"]);
      expect(attendees[1]?.name).toHaveLength(300);
    });

    it("指摘 6: 自動スケジュールか分からない CalDAV のカレンダーには取り込まない", async () => {
      const [unknownDav] = await db
        .insert(calendars)
        .values({
          userId,
          accountId: caldavAccountId,
          source: "caldav",
          name: "不明",
          remoteId: "/dav/unknown/",
          providerState: {},
        })
        .returning({ id: calendars.id });
      try {
        const messageId = await insertMessage(ics());
        const { invite } = await get(messageId);
        expect(
          (invite.calendars as { id: string }[]).map((entry) => entry.id),
        ).not.toContain(unknownDav?.id);
        expect(
          await apply(messageId, {
            expect: "import",
            calendarId: unknownDav?.id,
          }),
        ).toEqual({ status: 409, body: { error: "no_calendar" } });
      } finally {
        await db
          .delete(calendars)
          .where(eq(calendars.id, unknownDav?.id ?? ""));
      }
    });

    it("指摘 7: CalDAV へ取り込むときの self は、そのカレンダーの自分のアドレスだけ", async () => {
      // 受信したアドレス (Gmail) は CalDAV のアカウントの自分ではないので、self なしになる。
      const toGmail = await insertMessage(ics());
      expect(
        (await apply(toGmail, { expect: "import", calendarId: caldavId }))
          .status,
      ).toBe(200);
      const [first] = await eventsOf(caldavId);
      expect((await attendeesOf(first?.id as string)).some((a) => a.self)).toBe(
        false,
      );
      await db.delete(events);
      await db.delete(outbox);
      // CalDAV のアカウントのアドレスが参加者にいれば、それを self にする。
      const toDav = await insertMessage(
        ics({
          attendees: [
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`,
            "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@dav.example",
          ],
        }),
      );
      expect(
        (await apply(toDav, { expect: "import", calendarId: caldavId })).status,
      ).toBe(200);
      const [second] = await eventsOf(caldavId);
      expect(
        (await attendeesOf(second?.id as string))
          .filter((a) => a.self)
          .map((a) => a.email),
      ).toEqual(["me@dav.example"]);
    });

    it("指摘 8: 1 回だけの招待の後に原本の招待を取り込むと、親の無い例外の行を原本につなぎ直す", async () => {
      const single = await insertMessage(
        ics({ recurrenceId: "20261217T100000", start: "20261217T100000" }),
      );
      expect(
        (await apply(single, { expect: "import", calendarId: localId })).status,
      ).toBe(200);
      const [orphan] = await eventsOf(localId);
      await db
        .update(eventAttendees)
        .set({ status: "accepted" })
        .where(
          and(
            eq(eventAttendees.eventId, orphan?.id as string),
            eq(eventAttendees.self, true),
          ),
        );
      // その回を含む原本の招待。
      const series = await insertMessage(
        ics({
          extra: ["RRULE:FREQ=WEEKLY;COUNT=4"],
          more: [
            vevent({
              recurrenceId: "20261217T100000",
              start: "20261217T100000",
              summary: "設計レビュー (この回)",
            }),
          ],
        }),
      );
      expect((await get(series)).invite).toMatchObject({
        action: "import",
        actionState: "ready",
      });
      const result = await apply(series, {
        expect: "import",
        calendarId: localId,
      });
      expect(result.status).toBe(200);
      const rows = await eventsOf(localId);
      expect(rows).toHaveLength(2);
      const master = rows.find((row) => row.recurrenceId === null);
      const exception = rows.find((row) => row.recurrenceId !== null);
      expect(master?.id).toBe(result.body.eventId);
      expect(exception).toMatchObject({
        parentId: master?.id,
        summary: "設計レビュー (この回)",
      });
      expect(exception?.id).not.toBe(orphan?.id);
      // 同じ SEQUENCE なので、その回への自分の出欠を引き継ぐ。
      expect(
        (await attendeesOf(exception?.id as string)).find((a) => a.self)
          ?.status,
      ).toBe("accepted");
      const deleted = await db
        .select()
        .from(changes)
        .where(eq(changes.op, "delete"));
      expect(deleted.map((row) => row.entityId)).toContain(orphan?.id);
    });

    it("指摘 8: その回を含まない原本の招待なら、親の無い行は消して原本の繰り返しに任せる", async () => {
      await apply(
        await insertMessage(
          ics({ recurrenceId: "20261217T100000", start: "20261217T100000" }),
        ),
        { expect: "import", calendarId: localId },
      );
      await apply(
        await insertMessage(ics({ extra: ["RRULE:FREQ=WEEKLY;COUNT=4"] })),
        { expect: "import", calendarId: localId },
      );
      const rows = await eventsOf(localId);
      expect(rows.map((row) => [row.recurrenceId, row.rrule])).toEqual([
        [null, "FREQ=WEEKLY;COUNT=4"],
      ]);
    });

    it("指摘 9: 原本の無い例外が複数ある招待は、先頭の 1 回だけを取り込む (CalDAV の作成は 1 本)", async () => {
      const messageId = await insertMessage(
        ics({
          recurrenceId: "20261210T100000",
          more: [
            vevent({
              recurrenceId: "20261217T100000",
              start: "20261217T100000",
            }),
          ],
        }),
      );
      expect(
        (await apply(messageId, { expect: "import", calendarId: caldavId }))
          .status,
      ).toBe(200);
      expect(await eventsOf(caldavId)).toHaveLength(1);
      const queued = await db.select().from(outbox);
      expect(queued.map((row) => row.kind)).toEqual(["event_create"]);
    });

    it("親の無い例外の行の更新・取り消し", async () => {
      const options = {
        recurrenceId: "20261217T100000",
        start: "20261217T100000",
      };
      await apply(await insertMessage(ics(options)), {
        expect: "import",
        calendarId: localId,
      });
      const [orphan] = await eventsOf(localId);
      const update = await insertMessage(
        ics({ ...options, sequence: 2, summary: "変更後" }),
      );
      expect(await apply(update, { expect: "update" })).toEqual({
        status: 200,
        body: { applied: true, eventId: orphan?.id },
      });
      expect((await eventsOf(localId))[0]).toMatchObject({
        id: orphan?.id,
        summary: "変更後",
        sequence: 2,
      });
      const cancel = await insertMessage(
        ics({ ...options, method: "CANCEL", sequence: 2 }),
      );
      expect(await apply(cancel, { expect: "remove" })).toEqual({
        status: 200,
        body: { applied: true, eventId: orphan?.id },
      });
      expect(await eventsOf(localId)).toEqual([]);
    });

    it("指摘 14: 原本は同じで例外だけ新しい招待は、更新として反映する", async () => {
      const exception = (stamp: string, summary: string) =>
        vevent({
          recurrenceId: "20261217T100000",
          start: "20261217T100000",
          dtstamp: stamp,
          summary,
        });
      await imported({
        extra: ["RRULE:FREQ=WEEKLY;COUNT=4"],
        more: [exception("20261127T000000Z", "この回")],
      });
      const messageId = await insertMessage(
        ics({
          extra: ["RRULE:FREQ=WEEKLY;COUNT=4"],
          more: [exception("20261128T000000Z", "この回 (変更)")],
        }),
      );
      expect((await get(messageId)).invite).toMatchObject({
        action: "update",
        actionState: "ready",
      });
      expect((await apply(messageId, { expect: "update" })).status).toBe(200);
      expect(
        (await eventsOf(localId)).find((row) => row.recurrenceId !== null)
          ?.summary,
      ).toBe("この回 (変更)");
    });

    it("指摘 17: self なしで取り込んだ予定も、GET の eventId に返す", async () => {
      const eventId = await imported({
        attendees: ["ATTENDEE:mailto:suzuki@example.com"],
      });
      const messageId = await insertMessage(
        ics({ attendees: ["ATTENDEE:mailto:suzuki@example.com"] }),
      );
      expect((await get(messageId)).invite).toMatchObject({
        action: "update",
        actionState: "done",
        eventId,
      });
    });

    it("同じ UID の予定が 2 つの mail 側のカレンダーにあれば、1 つずつ取り消す", async () => {
      const [second] = await db
        .insert(calendars)
        .values({ userId, source: "local", name: "2 つ目", sortOrder: 9 })
        .returning({ id: calendars.id });
      try {
        await imported();
        // 2 つ目のカレンダーにも同じ予定 (ほかの経路で入ったもの)。
        const [copy] = await eventsOf(localId);
        await db.insert(events).values({
          ...(copy as typeof events.$inferInsert),
          id: undefined,
          calendarId: second?.id as string,
        });
        expect(
          await db.select().from(events).where(eq(events.uid, UID)),
        ).toHaveLength(2);
        const cancel = await insertMessage(
          ics({ method: "CANCEL", sequence: 1 }),
        );
        expect((await apply(cancel, { expect: "remove" })).body.applied).toBe(
          true,
        );
        expect((await get(cancel)).invite).toMatchObject({
          action: "remove",
          actionState: "ready",
        });
        expect((await apply(cancel, { expect: "remove" })).body.applied).toBe(
          true,
        );
        expect(
          await db.select().from(events).where(eq(events.uid, UID)),
        ).toEqual([]);
      } finally {
        await db.delete(calendars).where(eq(calendars.id, second?.id ?? ""));
      }
    });

    it("同時に 2 回 apply を呼んでも 1 件だけ作る (排他)", async () => {
      const messageId = await insertMessage(ics());
      const results = await Promise.all([
        apply(messageId, { expect: "import", calendarId: localId }),
        apply(messageId, { expect: "import", calendarId: localId }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results.map((r) => r.body.applied).sort()).toEqual([false, true]);
      expect(await eventsOf(localId)).toHaveLength(1);
    });
  });

  describe("レビュー 8b の指摘 (REPLY)", () => {
    const organizedBy = async (
      values: Partial<typeof events.$inferInsert> = {},
    ) => {
      const [row] = await db
        .insert(events)
        .values({
          userId,
          calendarId: localId,
          uid: UID,
          startAt: new Date("2026-12-10T01:00:00Z"),
          endAt: new Date("2026-12-10T02:00:00Z"),
          organizer: { email: ME, self: true },
          sequence: 1,
          ...values,
        })
        .returning({ id: events.id });
      const id = row?.id as string;
      await db
        .insert(eventAttendees)
        .values([{ eventId: id, email: "suzuki@example.com" }]);
      return id;
    };
    const replyIcs = (options: IcsOptions = {}) =>
      ics({
        method: "REPLY",
        organizer: ME,
        attendees: ["ATTENDEE;PARTSTAT=ACCEPTED:mailto:suzuki@example.com"],
        ...options,
      });
    const statusOf = async (eventId: string) =>
      (await attendeesOf(eventId)).find(
        (a) => a.email === "suzuki@example.com",
      );

    it("指摘 10: 未来の DTSTAMP の REPLY は受け取った時刻に丸め、その後の本物の返事を止めない", async () => {
      const eventId = await organizedBy();
      const future = await insertMessage(
        replyIcs({ dtstamp: "20261127T230000Z" }),
        { from: "suzuki@example.com", senderCheck: unknown },
      );
      expect((await apply(future, { expect: "apply_reply" })).body).toEqual({
        applied: true,
        eventId,
      });
      expect((await statusOf(eventId))?.repliedAt).toEqual(
        new Date("2026-11-27T00:00:01Z"),
      );
      const genuine = await insertMessage(
        replyIcs({
          dtstamp: "20261127T005900Z",
          attendees: ["ATTENDEE;PARTSTAT=DECLINED:mailto:suzuki@example.com"],
        }),
        {
          from: "suzuki@example.com",
          receivedAt: new Date("2026-11-27T01:00:00Z"),
        },
      );
      expect((await apply(genuine, { expect: "apply_reply" })).body).toEqual({
        applied: true,
        eventId,
      });
      expect((await statusOf(eventId))?.status).toBe("declined");
    });

    it("DTSTAMP の無い REPLY は、メールの送信日時で比べる", async () => {
      const eventId = await organizedBy();
      const messageId = await insertMessage(
        replyIcs().replace(/DTSTAMP:[^\r\n]*\r\n/, ""),
        { from: "suzuki@example.com" },
      );
      expect((await apply(messageId, { expect: "apply_reply" })).status).toBe(
        200,
      );
      expect((await statusOf(eventId))?.repliedAt).toEqual(
        new Date("2026-11-27T00:00:00Z"),
      );
    });

    it("親の無い (1 回だけの) 主催の予定への REPLY", async () => {
      const eventId = await organizedBy({
        recurrenceId: "2026-12-17T01:00:00Z",
      });
      const messageId = await insertMessage(
        replyIcs({ recurrenceId: "20261217T100000" }),
        { from: "suzuki@example.com" },
      );
      expect(await apply(messageId, { expect: "apply_reply" })).toEqual({
        status: 200,
        body: { applied: true, eventId },
      });
    });

    it("指摘 12: 送信元の無い (scheduling が mail でない) カレンダーの予定には反映しない", async () => {
      const [receiveOnly] = await db
        .insert(accounts)
        .values({
          userId,
          email: "recv@example.com",
          provider: "generic",
          authType: "password",
          username: "recv@example.com",
          credentialsEncrypted: "x",
        })
        .returning({ id: accounts.id });
      const [calendar] = await db
        .insert(calendars)
        .values({
          userId,
          source: "local",
          name: "受信専用",
          imipAccountId: receiveOnly?.id,
        })
        .returning({ id: calendars.id });
      try {
        await organizedBy({ calendarId: calendar?.id as string });
        const messageId = await insertMessage(replyIcs(), {
          from: "suzuki@example.com",
        });
        expect((await get(messageId)).invite).toMatchObject({
          action: "none",
          actionState: "blocked",
        });
      } finally {
        await db.delete(events);
        await db.delete(calendars).where(eq(calendars.id, calendar?.id ?? ""));
        await db.delete(accounts).where(eq(accounts.id, receiveOnly?.id ?? ""));
      }
    });
  });

  describe("ほかの利用者", () => {
    it("ほかの利用者のメールは 404 で、何も書かない", async () => {
      const messageId = await insertMessage(ics());
      expect((await get(messageId, otherApp)).status).toBe(404);
      expect(await apply(messageId, { expect: "import" }, otherApp)).toEqual({
        status: 404,
        body: { error: "not_found" },
      });
      expect(await db.select().from(events)).toEqual([]);
    });

    it("ほかの利用者の予定は、同じ UID でも更新・取り消し・REPLY の対象にしない", async () => {
      // 利用者 (owner) が取り込んだ予定と、主催する予定。
      const eventId = await imported();
      const otherMessage = (content: string, from = ORGANIZER) =>
        insertMessage(content, {
          owner: otherId,
          account: otherAccountId,
          from,
        });
      const update = await otherMessage(ics({ sequence: 2, summary: "x" }));
      // other には予定が無いので import (other のカレンダーへ) になる。
      expect((await get(update, otherApp)).invite).toMatchObject({
        action: "import",
        calendars: [{ id: otherLocalId, default: true }],
      });
      expect(await apply(update, { expect: "update" }, otherApp)).toEqual({
        status: 409,
        body: { error: "changed" },
      });
      expect(
        await apply(
          update,
          { expect: "import", calendarId: localId },
          otherApp,
        ),
      ).toEqual({ status: 404, body: { error: "not_found" } });
      const cancel = await otherMessage(ics({ method: "CANCEL" }));
      expect(
        (await apply(cancel, { expect: "remove" }, otherApp)).body,
      ).toEqual({ applied: false, eventId: null });
      const [row] = await eventsOf(localId);
      expect(row).toMatchObject({ id: eventId, summary: "設計レビュー" });
    });
  });
});
