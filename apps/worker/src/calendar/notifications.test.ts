/**
 * 招待・変更の検出 (invite-notices) と、予定の通知の送信 (NotificationDispatcher、CalendarPushSender) を
 * 実際の PostgreSQL で確かめる。DATABASE_URL が無い環境では実行しない。
 */
import {
  type CalendarNoticeNotification,
  type CalendarPushMessage,
  CHANNEL_CALENDAR_NOTICE,
  FcmError,
  verifyEventNotificationAction,
} from "@orbit/core";
import {
  calendars,
  type Database,
  devices,
  eventAttendees,
  eventNotices,
  eventOccurrences,
  eventReminderJobs,
  events,
  pushSubscriptions,
  userSettings,
  workerCursors,
} from "@orbit/db";
import { asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordChanges } from "../changes.js";
import {
  type CalendarFcmTransport,
  CalendarPushSender,
  type CalendarWebPushTransport,
} from "./calendar-push.js";
import { noteRemoteEvents } from "./invite-notices.js";
import {
  NotificationDispatcher,
  zonedDayStart,
} from "./notification-dispatcher.js";
import type { AccountRow, CalendarRow } from "./provider.js";
import { occurrenceWindowEnd, ReminderIndexer } from "./reminder-indexer.js";
import {
  createTestDatabase,
  insertAccount,
  insertCalendar,
  insertUser,
  type TestDatabase,
} from "./testing/test-db.js";

const adminUrl = process.env.DATABASE_URL;
const NOW = Date.parse("2027-03-01T00:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY = Buffer.alloc(32, 7);

describe("zonedDayStart", () => {
  it("その日の 0:00 をタイムゾーンで求める", () => {
    expect(
      new Date(zonedDayStart("2027-03-03", "Asia/Tokyo")).toISOString(),
    ).toBe("2027-03-02T15:00:00.000Z");
    expect(
      new Date(zonedDayStart("2027-03-15", "America/New_York")).toISOString(),
    ).toBe("2027-03-15T04:00:00.000Z");
  });
});

describe.skipIf(!adminUrl)("予定の通知", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendar: CalendarRow;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_notif");
    db = test.db;
    userId = await insertUser(db, "me@example.com");
    account = await insertAccount(db, userId, {
      email: "me@example.com",
      calendarEnabled: true,
    });
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    await db.delete(eventNotices);
    await db.delete(events);
    await db.delete(calendars);
    await db.delete(pushSubscriptions);
    await db.delete(devices);
    await db.delete(userSettings);
    await db.delete(workerCursors);
    calendar = await insertCalendar(db, userId, account.id, {
      lastSyncedAt: new Date(NOW - DAY),
      providerState: { primary: true },
      defaultReminders: [{ method: "display", minutes: 10 }],
      expandedUntil: occurrenceWindowEnd(NOW),
    });
  });

  const insertInvite = async (
    values: Partial<typeof events.$inferInsert> = {},
    status: "needs_action" | "accepted" | "declined" = "needs_action",
    self = "me@example.com",
  ) => {
    const [row] = await db
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: crypto.randomUUID(),
        summary: "定例会議",
        location: "会議室 A",
        startAt: new Date(NOW + DAY),
        endAt: new Date(NOW + DAY + HOUR),
        startTimeZone: "Asia/Tokyo",
        organizer: { email: "boss@example.com", name: "山田 太郎" },
        ...values,
      })
      .returning();
    if (!row) throw new Error("予定を作れませんでした。");
    await db.insert(eventAttendees).values([
      { eventId: row.id, email: "boss@example.com", status: "accepted" },
      { eventId: row.id, email: self, self: true, status },
    ]);
    return row;
  };

  const note = (
    upserted: string[],
    deleted: string[] = [],
    cal: Partial<CalendarRow> = {},
  ) =>
    noteRemoteEvents(db, {
      account,
      calendar: { ...calendar, ...cal },
      upserted,
      deleted,
      now: new Date(NOW),
    });

  const notices = () =>
    db
      .select()
      .from(eventNotices)
      .orderBy(asc(eventNotices.createdAt), asc(eventNotices.kind));

  describe("invite-notices", () => {
    it("新しい招待を記録し、最初の同期・過去・自分が主催・共有カレンダーの他人は送らない", async () => {
      const invite = await insertInvite();
      await note([invite.id]);
      let rows = await notices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("invite");
      expect(rows[0]?.sentAt).toBeNull();
      expect(rows[0]?.snapshot.organizer).toBe("山田 太郎");

      await db.delete(eventNotices);
      await note([invite.id], [], { lastSyncedAt: null });
      rows = await notices();
      expect(rows[0]?.sentAt).not.toBeNull();

      await db.delete(eventNotices);
      const past = await insertInvite({
        startAt: new Date(NOW - 2 * DAY),
        endAt: new Date(NOW - 2 * DAY + HOUR),
      });
      const mine = await insertInvite({
        organizer: { email: "me@example.com", self: true },
      });
      await note([past.id, mine.id]);
      rows = await notices();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventId).toBe(past.id);
      expect(rows[0]?.sentAt).not.toBeNull();

      // 共有カレンダー (自分のものでない) で self が自分でない予定。
      await db.delete(eventNotices);
      const other = await insertInvite(
        {},
        "needs_action",
        "colleague@example.com",
      );
      await note([other.id], [], { providerState: { accessRole: "reader" } });
      expect(await notices()).toHaveLength(0);

      // 通知オフのカレンダーは基準だけ。
      await note([invite.id], [], { notify: false });
      expect((await notices())[0]?.sentAt).not.toBeNull();
    });

    it("日時・場所の変更と取り消し・削除を見つけ、題名だけの変更や不参加の予定は送らない", async () => {
      const invite = await insertInvite({}, "accepted");
      await note([invite.id]);
      expect((await notices())[0]?.sentAt).not.toBeNull(); // 承諾済み = 基準だけ

      await db
        .update(events)
        .set({ summary: "新しい題名" })
        .where(eq(events.id, invite.id));
      await note([invite.id]);
      expect(await notices()).toHaveLength(1);

      await db
        .update(events)
        .set({ location: "会議室 B" })
        .where(eq(events.id, invite.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await note([invite.id]);
      let rows = await notices();
      expect(rows.map((row) => row.kind)).toEqual(["invite", "update"]);
      expect(rows[1]?.sentAt).toBeNull();

      await db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, invite.id));
      await note([invite.id]);
      rows = await notices();
      expect(rows.at(-1)?.kind).toBe("cancel");

      const declined = await insertInvite({}, "declined");
      await note([declined.id]);
      await db
        .update(events)
        .set({
          startAt: new Date(NOW + 3 * DAY),
          endAt: new Date(NOW + 3 * DAY + HOUR),
        })
        .where(eq(events.id, declined.id));
      await note([declined.id]);
      const declinedRows = (await notices()).filter(
        (row) => row.eventId === declined.id,
      );
      expect(
        declinedRows.map((row) => [row.kind, row.sentAt !== null]),
      ).toEqual([
        ["invite", true],
        ["update", true],
      ]);

      // 相手側で消えた予定。
      const gone = await insertInvite();
      await note([gone.id]);
      await db.delete(events).where(eq(events.id, gone.id));
      await note([], [gone.id]);
      const goneRows = (await notices()).filter(
        (row) => row.eventId === gone.id,
      );
      expect(goneRows.map((row) => row.kind)).toEqual(["invite", "cancel"]);
      expect(goneRows[1]?.sentAt).toBeNull();
      expect(goneRows[1]?.snapshot.title).toBe("定例会議");
    });

    it("招待を自分で配らないカレンダー (ICS) は扱わない", async () => {
      const invite = await insertInvite();
      await note([invite.id], [], { source: "ics" });
      expect(await notices()).toHaveLength(0);
    });
  });

  describe("NotificationDispatcher", () => {
    type Sent = { to: string; message: CalendarPushMessage; ttl: number };
    const setup = (options: { webFail?: number; fcmGone?: boolean } = {}) => {
      const sent: Sent[] = [];
      const web: CalendarWebPushTransport = async (subscription, body, ttl) => {
        if (options.webFail) {
          throw Object.assign(new Error("gone"), {
            statusCode: options.webFail,
          });
        }
        sent.push({
          to: subscription.endpoint,
          message: JSON.parse(body),
          ttl,
        });
      };
      const fcm: CalendarFcmTransport = async (token, data, ttl) => {
        if (options.fcmGone) throw new FcmError(404, "UNREGISTERED", "gone");
        sent.push({
          to: token,
          message: {
            kind: data.kind,
            title: data.title,
            body: data.body,
            tag: data.tag,
            eventId: data.eventId,
          } as CalendarPushMessage,
          ttl,
        });
      };
      return {
        sent,
        push: new CalendarPushSender(db, { webPush: web, fcm }, () => {}),
      };
    };

    const subscribe = async (endpoint: string, notifyCalendar = true) =>
      db.insert(pushSubscriptions).values({
        userId,
        endpoint,
        p256dh: "k",
        auth: "a",
        notifyCalendar,
      });
    const device = async (
      token: string,
      values: Partial<typeof devices.$inferInsert> = {},
    ) =>
      db.insert(devices).values({
        userId,
        name: token,
        platform: "android",
        pushToken: token,
        notifyCalendar: true,
        ...values,
      });

    /** 予定を 1 件作り、Indexer で job を作る。返すのは job。 */
    const reminderJob = async () => {
      const indexer = new ReminderIndexer(db, null, { now: () => NOW });
      await indexer.processChanges();
      const [row] = await db
        .insert(events)
        .values({
          userId,
          calendarId: calendar.id,
          uid: crypto.randomUUID(),
          summary: "定例会議",
          startAt: new Date(NOW + HOUR),
          endAt: new Date(NOW + 2 * HOUR),
        })
        .returning();
      await db.transaction((tx) =>
        recordChanges(tx, userId, "event", "upsert", [row?.id as string]),
      );
      await indexer.processChanges();
      const [job] = await db.select().from(eventReminderJobs);
      if (!job) throw new Error("job がありません。");
      return job;
    };

    it("時刻の来たリマインダーを notifyCalendar の送り先へ 1 回だけ送り、端末が予約済みなら省く", async () => {
      const job = await reminderJob();
      const fireAt = job.fireAt.getTime();
      await subscribe("https://push.example/web");
      await subscribe("https://push.example/old", false);
      // 3.3 の判定の 4 通り。
      await device("covered", {
        reminderCoverUntil: new Date(fireAt + DAY),
        reminderCoverSeq: job.changeSeq,
        exactAlarms: true,
      });
      await device("out-of-range", {
        reminderCoverUntil: new Date(fireAt - 1),
        reminderCoverSeq: job.changeSeq,
        exactAlarms: true,
      });
      await device("stale-seq", {
        reminderCoverUntil: new Date(fireAt + DAY),
        reminderCoverSeq: job.changeSeq - 1n,
        exactAlarms: true,
      });
      await device("inexact", {
        reminderCoverUntil: new Date(fireAt + DAY),
        reminderCoverSeq: job.changeSeq,
        exactAlarms: false,
      });
      await device("mail-only", { notifyCalendar: false });

      const { sent, push } = setup();
      let now = fireAt - MIN;
      const make = () =>
        new NotificationDispatcher(db, { push, now: () => now, log: () => {} });
      expect((await make().dispatch()).reminders).toBe(0);
      now = fireAt + MIN;
      // 2 つの Dispatcher が同時に取っても 1 回だけ (SKIP LOCKED)。
      const results = await Promise.all([make().dispatch(), make().dispatch()]);
      expect(results.reduce((sum, r) => sum + r.reminders, 0)).toBe(1);
      expect(sent.map((item) => item.to).sort()).toEqual([
        "https://push.example/web",
        "inexact",
        "out-of-range",
        "stale-seq",
      ]);
      const web = sent.find((item) => item.to === "https://push.example/web");
      expect(web?.message).toMatchObject({
        kind: "event-reminder",
        title: "定例会議",
        body: "10:00〜11:00",
        tag: expect.stringMatching(/^cal-rem:.*:-:10$/),
      });
      // 予定の終了まで (1 時間 + 9 分)。
      expect(web?.ttl).toBe(Math.floor((NOW + 2 * HOUR - now) / 1000));
    });

    it("15 分より遅れたリマインダーは送らずに済ませ、無効な送り先を消す", async () => {
      const job = await reminderJob();
      await subscribe("https://push.example/web");
      const late = setup();
      await new NotificationDispatcher(db, {
        push: late.push,
        now: () => job.fireAt.getTime() + 16 * MIN,
      }).dispatch();
      expect(late.sent).toHaveLength(0);
      const [row] = await db.select().from(eventReminderJobs);
      expect(row?.sentAt).not.toBeNull();

      await db.update(eventReminderJobs).set({ sentAt: null });
      await device("gone-token");
      const failing = setup({ webFail: 410, fcmGone: true });
      await new NotificationDispatcher(db, {
        push: failing.push,
        now: () => job.fireAt.getTime(),
      }).dispatch();
      expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
      expect(await db.select().from(devices)).toHaveLength(0);
      expect(await db.select().from(eventOccurrences)).toHaveLength(1);
    });

    it("招待・変更・取り消しを送り、4 件以上の招待はまとめ、SSE には合言葉を載せない", async () => {
      await subscribe("https://push.example/web");
      const listener = new pg.Client({ connectionString: test.url });
      await listener.connect();
      const announced: CalendarNoticeNotification[] = [];
      listener.on("notification", (message) => {
        announced.push(JSON.parse(message.payload ?? "{}"));
      });
      await listener.query(`LISTEN ${CHANNEL_CALENDAR_NOTICE}`);

      const single = await insertInvite();
      await note([single.id]);
      const { sent, push } = setup();
      const dispatcher = new NotificationDispatcher(db, {
        push,
        rsvp: {
          key: KEY,
          url: "https://api.example/v1/notification-actions/event",
        },
        now: () => NOW,
      });
      expect((await dispatcher.dispatch()).notices).toBe(1);
      const invite = sent[0]?.message;
      expect(invite).toMatchObject({
        kind: "event-invite",
        title: "招待: 定例会議",
        tag: `cal-inv:${single.id}`,
        eventId: single.id,
      });
      expect(
        verifyEventNotificationAction(
          KEY,
          userId,
          single.id,
          invite?.rsvp?.token,
          NOW,
        ),
      ).toBe(true);
      expect(sent[0]?.ttl).toBe(24 * 60 * 60);

      // 変更 (前に知らせた内容と比べた文言)。
      await db
        .update(events)
        .set({ location: "会議室 B" })
        .where(eq(events.id, single.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await note([single.id]);
      await dispatcher.dispatch();
      expect(sent[1]?.message).toMatchObject({
        kind: "event-update",
        body: "場所が 会議室 B になりました",
        tag: `cal-upd:${single.id}`,
      });

      // 4 件の招待は 1 件にまとめる。
      const many = [];
      for (let i = 0; i < 4; i++) many.push((await insertInvite()).id);
      await note(many);
      await dispatcher.dispatch();
      expect(sent[2]?.message).toMatchObject({
        kind: "event-invites-batch",
        title: "新しい招待 4 件",
        body: "山田 太郎",
        eventId: null,
      });
      expect(sent).toHaveLength(3);

      await new Promise((resolve) => setTimeout(resolve, 100));
      await listener.end();
      expect(announced).toHaveLength(3);
      expect(announced[0]?.userId).toBe(userId);
      expect(announced[0]?.notifications[0]?.rsvp).toBeUndefined();
      expect(announced[0]?.notifications[0]?.kind).toBe("event-invite");
    });

    it("設定で招待をオフにしたら送らず、中身を出さない設定では伏せる", async () => {
      await subscribe("https://push.example/web");
      await db.insert(userSettings).values({
        userId,
        calendarNotifications: { invites: false, detail: "private" },
      });
      const invite = await insertInvite();
      await note([invite.id]);
      const { sent, push } = setup();
      const dispatcher = new NotificationDispatcher(db, {
        push,
        now: () => NOW,
      });
      expect((await dispatcher.dispatch()).notices).toBe(1);
      expect(sent).toHaveLength(0);

      await db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, invite.id));
      await note([invite.id]);
      await dispatcher.dispatch();
      expect(sent[0]?.message).toMatchObject({
        kind: "event-cancel",
        title: "予定の変更",
        body: "",
      });
    });
  });
});
