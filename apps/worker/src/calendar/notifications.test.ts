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
import { asc, eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordChanges } from "../changes.js";
import {
  type CalendarFcmTransport,
  CalendarPushSender,
  type CalendarWebPushTransport,
} from "./calendar-push.js";
import {
  noteRemoteEvents,
  pruneEventNotices,
  seedEventNoticeBaselines,
} from "./invite-notices.js";
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

  /** 取り込みの代わり。created を省くと、upserted に初めて渡す行を新しく作った行とみなす。 */
  const seen = new Set<string>();
  const note = (
    upserted: string[],
    deleted: string[] = [],
    cal: Partial<CalendarRow> = {},
    created: string[] = upserted.filter((id) => !seen.has(id)),
    now = NOW,
  ) => {
    for (const id of upserted) seen.add(id);
    return noteRemoteEvents(db, {
      account,
      calendar: { ...calendar, ...cal },
      upserted,
      created,
      deleted,
      now: new Date(now),
    });
  };

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
      // Google の cancelled は自分の削除と見分けられないので記録だけ (M9)。
      expect(rows.at(-1)?.sentAt).not.toBeNull();

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
      // 相手側で消えた予定は、自分が消した場合と見分けられないので送らない (M9)。
      expect(goneRows[1]?.sentAt).not.toBeNull();
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

      await db
        .update(eventReminderJobs)
        .set({ sentAt: null, claimedAt: null, attempts: 0 });
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
      // 主催者の取り消しと分かるカレンダー (Microsoft の isCancelled)。
      await note([invite.id], [], { source: "microsoft" });
      await dispatcher.dispatch();
      expect(sent[0]?.message).toMatchObject({
        kind: "event-cancel",
        title: "予定の変更",
        body: "",
      });
    });
    // -----------------------------------------------------------------------
    // レビューの指摘 (H1、M3〜M6、M9、L2、L3、L5) と、テストの抜け
    // -----------------------------------------------------------------------

    type RawSent = { to: string; data: Record<string, string> };
    /** FCM の data をそのまま残す送り先 (expiresAt を見る)。 */
    const rawFcm = () => {
      const sent: RawSent[] = [];
      const fcm: CalendarFcmTransport = async (token, data) => {
        sent.push({ to: token, data });
      };
      return {
        sent,
        push: new CalendarPushSender(
          db,
          { fcm },
          () => {},
          () => NOW,
          [0, 0],
        ),
      };
    };

    it("繰り返す予定の招待・変更は次の回の日時と期限で送り、終わった繰り返しは送らない (H1)", async () => {
      await device("phone");
      // 30 日前 (2027-01-30 土曜) に始まった毎週の会議に、今日招待された。
      const series = await insertInvite({
        startAt: new Date(NOW - 30 * DAY),
        endAt: new Date(NOW - 30 * DAY + HOUR),
        rrule: "FREQ=WEEKLY",
      });
      await note([series.id]);
      const { sent, push } = rawFcm();
      const dispatcher = new NotificationDispatcher(db, {
        push,
        now: () => NOW,
      });
      await dispatcher.dispatch();
      expect(sent).toHaveLength(1);
      const invite = sent[0]?.data;
      // 次の回は 3/6 (土) 9:00 (東京)。期限は今より後。
      expect(Number(invite?.expiresAt)).toBe(NOW + 5 * DAY + HOUR);
      expect(invite?.body).toBe("山田 太郎 さんから · 3月6日(土) 09:00〜10:00");

      // 場所の変更も、次の回の日時と期限。
      await db
        .update(events)
        .set({ location: "会議室 B" })
        .where(eq(events.id, series.id));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await note([series.id]);
      await dispatcher.dispatch();
      expect(sent[1]?.data).toMatchObject({
        kind: "event-update",
        body: "場所が 会議室 B になりました",
        expiresAt: String(NOW + 5 * DAY + HOUR),
      });

      // 記録してから送るまでの間に、繰り返しが終わっていた (次の回が無い) なら送らない。
      const ended = await insertInvite({
        startAt: new Date(NOW - 30 * DAY),
        endAt: new Date(NOW - 30 * DAY + HOUR),
        rrule: "FREQ=WEEKLY",
      });
      await note([ended.id]);
      await db
        .update(eventNotices)
        .set({
          snapshot: sql`jsonb_set(${eventNotices.snapshot}, '{rrule}', '"FREQ=WEEKLY;COUNT=2"')`,
        })
        .where(eq(eventNotices.eventId, ended.id));
      await dispatcher.dispatch();
      expect(sent).toHaveLength(2);
      const [row] = await db
        .select()
        .from(eventNotices)
        .where(eq(eventNotices.eventId, ended.id));
      expect(row?.sentAt).not.toBeNull();
    });

    it("知らせ済みの繰り返しの 1 回だけの変更・取り消しを送り、同じ内容の例外は送らない (M4)", async () => {
      await subscribe("https://push.example/web");
      const series = await insertInvite({
        startAt: new Date("2027-03-02T01:00:00Z"),
        endAt: new Date("2027-03-02T02:00:00Z"),
        rrule: "FREQ=WEEKLY",
      });
      await note([series.id], [], { source: "microsoft" });
      const { sent, push } = setup();
      const dispatcher = new NotificationDispatcher(db, {
        push,
        now: () => NOW,
      });
      await dispatcher.dispatch();
      expect(sent.map((item) => item.message.kind)).toEqual(["event-invite"]);
      const exception = async (
        recurrenceId: string,
        values: Partial<typeof events.$inferInsert>,
      ) => {
        const row = await insertInvite({
          uid: series.uid,
          parentId: series.id,
          recurrenceId,
          rrule: null,
          ...values,
        });
        return row;
      };
      const moved = await exception("2027-03-09T01:00:00Z", {
        startAt: new Date("2027-03-09T06:00:00Z"),
        endAt: new Date("2027-03-09T07:00:00Z"),
      });
      const same = await exception("2027-03-16T01:00:00Z", {
        startAt: new Date("2027-03-16T01:00:00Z"),
        endAt: new Date("2027-03-16T02:00:00Z"),
        summary: "定例会議 (資料あり)",
      });
      const [cancelled] = await db
        .insert(events)
        .values({
          userId,
          calendarId: calendar.id,
          uid: series.uid,
          parentId: series.id,
          recurrenceId: "2027-03-23T01:00:00Z",
          startAt: new Date("2027-03-23T01:00:00Z"),
          endAt: new Date("2027-03-23T02:00:00Z"),
          status: "cancelled",
        })
        .returning();
      await note([moved.id, same.id, cancelled?.id as string], [], {
        source: "microsoft",
      });
      await dispatcher.dispatch();
      const messages = sent
        .slice(1)
        .map((item) => item.message)
        .sort((a, b) => b.kind.localeCompare(a.kind));
      expect(
        messages.map((message) => [message.kind, message.eventId]),
      ).toEqual([
        ["event-update", moved.id],
        ["event-cancel", cancelled?.id],
      ]);
      expect(messages[0]?.body).toBe(
        "日時が 3月9日(火) 15:00〜16:00 になりました",
      );
      expect(messages[1]?.body).toBe(
        "3月23日(火) 10:00〜11:00 の予定は取り消されました",
      );
    });

    it("基準の無い既存の招待は、変わっても新しい招待にせず、その後の取り消しは送る (M3)", async () => {
      await subscribe("https://push.example/web");
      const old = await insertInvite();
      // 導入前からある行 (今回作った行ではない) が相手側で触られた。
      await note([old.id], [], { source: "microsoft" }, []);
      let rows = await notices();
      expect(rows.map((row) => [row.kind, row.sentAt !== null])).toEqual([
        ["invite", true],
      ]);
      await db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, old.id));
      await note([old.id], [], { source: "microsoft" });
      rows = await notices();
      expect(rows.at(-1)).toMatchObject({ kind: "cancel", sentAt: null });
    });

    it("最初の起動で、導入前からある招待に送信済みの基準を入れる (M3)", async () => {
      const old = await insertInvite();
      const past = await insertInvite({
        startAt: new Date(NOW - 3 * DAY),
        endAt: new Date(NOW - 3 * DAY + HOUR),
      });
      expect(await seedEventNoticeBaselines(db, { now: () => NOW })).toBe(1);
      const rows = await notices();
      expect(
        rows.map((row) => [row.eventId, row.kind, row.sentAt !== null]),
      ).toEqual([[old.id, "invite", true]]);
      expect(rows.some((row) => row.eventId === past.id)).toBe(false);
      // 2 回目は何もしない。
      expect(await seedEventNoticeBaselines(db, { now: () => NOW })).toBe(0);
    });

    it("不参加にした予定と Google の取り消しは送らない (M9、L2)", async () => {
      const invite = await insertInvite({}, "declined");
      await note([invite.id], [], { source: "microsoft" });
      await db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, invite.id));
      await note([invite.id], [], { source: "microsoft" });
      const rows = await notices();
      expect(rows.map((row) => [row.kind, row.sentAt !== null])).toEqual([
        ["invite", true],
        ["cancel", true],
      ]);
      expect(rows[0]?.snapshot.selfStatus).toBe("declined");
    });

    it("1 分に 30 件を超えた分は「予定の通知 N 件」にまとめ、tag は毎回同じ (L3)", async () => {
      await subscribe("https://push.example/web");
      const ids: string[] = [];
      for (let i = 0; i < 35; i++) {
        ids.push((await insertInvite({}, "accepted")).id);
      }
      await note(ids);
      await db
        .update(events)
        .set({ location: "会議室 Z" })
        .where(inArray(events.id, ids));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await note(ids);
      const { sent, push } = setup();
      let now = NOW;
      const dispatcher = new NotificationDispatcher(db, {
        push,
        now: () => now,
      });
      await dispatcher.dispatch();
      expect(sent).toHaveLength(30);
      expect(sent.at(-1)?.message).toMatchObject({
        kind: "event-invites-batch",
        title: "予定の通知 6 件",
        tag: "cal-inv-batch:all",
        eventId: null,
      });
      // 同じ 1 分のうちは、まとめの 1 件だけ (別の Dispatcher = 再起動・別の worker でも同じ)。
      await db
        .update(events)
        .set({ location: "会議室 Y" })
        .where(eq(events.id, ids[0] as string));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await note([ids[0] as string]);
      now = NOW + 10_000;
      await new NotificationDispatcher(db, {
        push,
        now: () => now,
      }).dispatch();
      expect(sent).toHaveLength(31);
      expect(sent.at(-1)?.message).toMatchObject({
        title: "予定の通知 1 件",
        tag: "cal-inv-batch:all",
      });
      // 1 分たてば、また 1 件ずつ。
      await db
        .update(events)
        .set({ location: "会議室 X" })
        .where(eq(events.id, ids[1] as string));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await note([ids[1] as string]);
      now = NOW + 2 * MIN;
      await dispatcher.dispatch();
      expect(sent.at(-1)?.message.kind).toBe("event-update");
    });

    it("一時的な失敗 (5xx・時間切れ) は送り直し、ほかの失敗は送り直さずに次の通知へ進む (M5、M6)", async () => {
      await subscribe("https://push.example/web");
      await device("phone");
      const calls: string[] = [];
      let webFailures = [503, null];
      const web: CalendarWebPushTransport = async (_subscription, body) => {
        const title = JSON.parse(body).title as string;
        calls.push(`web:${title}`);
        const status = webFailures.shift();
        if (status === null) throw new Error("timeout");
        if (status) throw Object.assign(new Error("x"), { statusCode: status });
      };
      let fcmFailures = [400];
      const fcm: CalendarFcmTransport = async (_token, data) => {
        calls.push(`fcm:${data.title}`);
        const status = fcmFailures.shift();
        if (status)
          throw new FcmError(status, "QUOTA_EXCEEDED_FOR_TEST", "bad");
      };
      const push = new CalendarPushSender(
        db,
        { webPush: web, fcm },
        () => {},
        () => NOW,
        [0, 0],
      );
      const message = (title: string): CalendarPushMessage => ({
        kind: "event-invite",
        title,
        body: "",
        tag: `cal-inv:${title}`,
        eventId: null,
      });
      const result = await push.deliver(userId, [
        { message: message("a") },
        { message: message("b") },
      ]);
      // Web Push: a は 2 回失敗して 3 回目で届く。FCM: a は 400 で送り直さず、b は届く。
      expect(calls.filter((call) => call.startsWith("web:"))).toEqual([
        "web:a",
        "web:a",
        "web:a",
        "web:b",
      ]);
      expect(calls.filter((call) => call.startsWith("fcm:"))).toEqual([
        "fcm:a",
        "fcm:b",
      ]);
      expect(result).toEqual({ webPush: 2, fcm: 1 });
      // 送り直しの上限を超えたら諦めて、次の通知へ進む。
      calls.length = 0;
      webFailures = [503, 503, 503];
      fcmFailures = [];
      expect(
        await push.deliver(userId, [
          { message: message("c") },
          { message: message("d") },
        ]),
      ).toEqual({ webPush: 1, fcm: 2 });
      expect(calls.filter((call) => call.startsWith("web:"))).toEqual([
        "web:c",
        "web:c",
        "web:c",
        "web:d",
      ]);
    });

    it("取ったまま送り終えなかった job は、期限が過ぎたら取り直し、上限の回数で諦める (M6)", async () => {
      const job = await reminderJob();
      const fireAt = job.fireAt.getTime();
      let deliveries = 0;
      const broken = {
        enabled: true,
        deliver: async () => {
          deliveries += 1;
          throw new Error("送信の途中で落ちた");
        },
      } as unknown as CalendarPushSender;
      let now = fireAt;
      const make = () =>
        new NotificationDispatcher(db, {
          push: broken,
          now: () => now,
          log: () => {},
        });
      await make().dispatch();
      expect(deliveries).toBe(1);
      let [row] = await db.select().from(eventReminderJobs);
      expect(row?.sentAt).toBeNull();
      expect(row?.claimedAt).not.toBeNull();
      // 期限の内は取り直さない (ほかの worker が送っている途中かもしれない)。
      now = fireAt + MIN;
      await make().dispatch();
      expect(deliveries).toBe(1);
      // 期限が過ぎたら取り直して送る。
      now = fireAt + 3 * MIN;
      await make().dispatch();
      expect(deliveries).toBe(2);
      now = fireAt + 6 * MIN;
      await make().dispatch();
      expect(deliveries).toBe(3);
      // 上限 (3 回) に達したら、送らずに済ませる。
      now = fireAt + 9 * MIN;
      await make().dispatch();
      expect(deliveries).toBe(3);
      [row] = await db.select().from(eventReminderJobs);
      expect(row?.sentAt).not.toBeNull();
    });

    it("応答しない送り先があっても待ち続けず、1 件の組み立ての失敗でまとまりを落とさない (M5、M6)", async () => {
      // 中身の読めない行 (投げる) と、普通の招待。
      const broken = await insertInvite();
      const fine = await insertInvite();
      await note([broken.id, fine.id]);
      await db
        .update(eventNotices)
        .set({
          snapshot: sql`jsonb_set(jsonb_set(${eventNotices.snapshot}, '{startAt}', '"garbage"'), '{rrule}', '"FREQ=DAILY"')`,
        })
        .where(eq(eventNotices.eventId, broken.id));
      await subscribe("https://push.example/hang");
      const delivered: string[] = [];
      const web: CalendarWebPushTransport = async (subscription, body) => {
        if (subscription.endpoint.endsWith("/hang")) {
          await new Promise(() => {}); // 応答しない
        }
        delivered.push(JSON.parse(body).eventId);
      };
      const logs: string[] = [];
      const dispatcher = new NotificationDispatcher(db, {
        push: new CalendarPushSender(db, { webPush: web }, () => {}),
        now: () => NOW,
        log: (line) => logs.push(line),
        deliverTimeoutMs: 50,
      });
      expect((await dispatcher.dispatch()).notices).toBe(2);
      expect(
        logs.some((line) => line.includes("組み立てられませんでした")),
      ).toBe(true);
      expect(logs.some((line) => line.includes("終わりませんでした"))).toBe(
        true,
      );
      const rows = await notices();
      expect(rows.every((row) => row.sentAt !== null)).toBe(true);
      // 応答しない送り先のせいで、SSE にも届かないということはない (送るのは読めた 1 件)。
      expect(delivered).toEqual([]);
      expect(
        rows.find((row) => row.eventId === fine.id)?.claimedAt,
      ).not.toBeNull();
    });

    it("消えたカレンダーの未送信の行は送らない (L5)", async () => {
      await subscribe("https://push.example/web");
      const invite = await insertInvite();
      await note([invite.id]);
      await db
        .update(eventNotices)
        .set({ calendarId: crypto.randomUUID() })
        .where(eq(eventNotices.eventId, invite.id));
      const { sent, push } = setup();
      await new NotificationDispatcher(db, { push, now: () => NOW }).dispatch();
      expect(sent).toHaveLength(0);
    });

    it("予定の行が消えて 30 日たった記録は、繰り返す予定のものも消す (L5)", async () => {
      const series = await insertInvite({ rrule: "FREQ=WEEKLY" });
      await note([series.id], [], { lastSyncedAt: null });
      await db.delete(events).where(eq(events.id, series.id));
      // created_at は DB の時計なので、ここは実際の時刻で確かめる。
      const today = Date.now();
      expect(await pruneEventNotices(db, new Date(today))).toBe(0);
      await db
        .update(eventNotices)
        .set({ createdAt: new Date(today - 31 * DAY) });
      expect(await pruneEventNotices(db, new Date(today))).toBe(1);
    });
  });
});
