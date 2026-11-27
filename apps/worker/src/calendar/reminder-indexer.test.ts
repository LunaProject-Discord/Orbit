/**
 * ReminderIndexer (event_occurrences と event_reminder_jobs の作り直し) を実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import { deviceCoversReminder } from "@orbit/core";
import {
  calendars,
  changes,
  type Database,
  eventAttendees,
  eventOccurrences,
  eventReminderJobs,
  eventReminders,
  events,
  userSettings,
  workerCursors,
} from "@orbit/db";
import { asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordChanges } from "../changes.js";
import type { CalendarRow } from "./provider.js";
import {
  computeOccurrences,
  occurrenceWindowEnd,
  ReminderIndexer,
} from "./reminder-indexer.js";
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

describe("computeOccurrences", () => {
  const base = {
    id: "m",
    userId: "u",
    calendarId: "c",
    uid: "x",
    recurrenceId: null,
    parentId: null,
    status: "confirmed",
    allDay: false,
    startAt: new Date("2027-03-02T01:00:00Z"),
    endAt: new Date("2027-03-02T02:00:00Z"),
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: null,
    exdates: null,
  } as unknown as typeof events.$inferSelect;

  it("繰り返さない予定はどれだけ先でも 1 行、終わったものは入れない", () => {
    const far = {
      ...base,
      startAt: new Date("2028-01-01T00:00:00Z"),
      endAt: new Date("2028-01-01T01:00:00Z"),
    };
    const options = {
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
      windowEnd: occurrenceWindowEnd(NOW),
    };
    expect(computeOccurrences(far, [], options)).toHaveLength(1);
    const past = {
      ...base,
      startAt: new Date(NOW - 3 * DAY),
      endAt: new Date(NOW - 2 * DAY),
    };
    expect(computeOccurrences(past, [], options)).toHaveLength(0);
  });

  it("繰り返す予定は今日 + 35 日より前の回だけ。夏時間をまたいでも現地の 10:00", () => {
    const weekly = {
      ...base,
      startAt: new Date("2027-03-01T15:00:00Z"), // 10:00 EST
      endAt: new Date("2027-03-01T16:00:00Z"),
      startTimeZone: "America/New_York",
      rrule: "FREQ=WEEKLY",
    };
    const result = computeOccurrences(weekly, [], {
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
      windowEnd: occurrenceWindowEnd(NOW),
    });
    expect(result).toHaveLength(5);
    expect(result[0]?.startAt?.toISOString()).toBe("2027-03-01T15:00:00.000Z");
    // 2027-03-14 から夏時間 (EDT)。
    expect(result[2]?.startAt?.toISOString()).toBe("2027-03-15T14:00:00.000Z");
  });
});

describe.skipIf(!adminUrl)("ReminderIndexer", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let accountId: string;
  let calendar: CalendarRow;
  let now = NOW;
  let indexer: ReminderIndexer;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_reminders");
    db = test.db;
    userId = await insertUser(db, "reminders@example.com");
    accountId = (await insertAccount(db, userId, { calendarEnabled: true })).id;
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    now = NOW;
    await db.delete(workerCursors);
    await db.delete(events);
    await db.delete(calendars);
    await db.delete(userSettings);
    calendar = await insertCalendar(db, userId, accountId, {
      defaultReminders: [
        { method: "display", minutes: 10 },
        { method: "email", minutes: 30 },
      ],
      expandedUntil: occurrenceWindowEnd(NOW),
    });
    indexer = new ReminderIndexer(db, null, { now: () => now });
    // 位置を作る (それより前の変更は繰り上げが埋める)。
    await indexer.processChanges();
  });

  const record = (
    entity: "event" | "calendar",
    ids: string[],
    op: "upsert" | "delete" = "upsert",
  ) => db.transaction((tx) => recordChanges(tx, userId, entity, op, ids));

  const insertEvent = async (
    values: Partial<typeof events.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: crypto.randomUUID(),
        summary: "定例会議",
        startAt: new Date(NOW + DAY),
        endAt: new Date(NOW + DAY + HOUR),
        startTimeZone: "Asia/Tokyo",
        ...values,
      })
      .returning();
    if (!row) throw new Error("予定を作れませんでした。");
    await record("event", [row.id]);
    return row;
  };

  const jobs = () =>
    db
      .select({
        id: eventReminderJobs.id,
        minutes: eventReminderJobs.minutes,
        fireAt: eventReminderJobs.fireAt,
        changeSeq: eventReminderJobs.changeSeq,
        sentAt: eventReminderJobs.sentAt,
        eventId: eventOccurrences.eventId,
        recurrenceId: eventOccurrences.recurrenceId,
      })
      .from(eventReminderJobs)
      .innerJoin(
        eventOccurrences,
        eq(eventOccurrences.id, eventReminderJobs.occurrenceId),
      )
      .orderBy(asc(eventReminderJobs.fireAt));
  const occurrences = () =>
    db
      .select()
      .from(eventOccurrences)
      .orderBy(asc(eventOccurrences.startAt), asc(eventOccurrences.startDate));

  it("作成で回と job (display だけ) を作り、題名だけの変更では送信済みを保つ", async () => {
    const event = await insertEvent();
    expect(await indexer.processChanges()).toBe(1);
    const [job] = await jobs();
    expect(await jobs()).toHaveLength(1);
    expect(job?.minutes).toBe(10);
    expect(job?.fireAt.getTime()).toBe(NOW + DAY - 10 * MIN);
    expect(await occurrences()).toHaveLength(1);
    const firstSeq = job?.changeSeq;

    await db
      .update(eventReminderJobs)
      .set({ sentAt: new Date(NOW) })
      .where(eq(eventReminderJobs.id, job?.id as string));
    await db
      .update(events)
      .set({ summary: "別の題名" })
      .where(eq(events.id, event.id));
    await record("event", [event.id]);
    await indexer.processChanges();
    const [same] = await jobs();
    expect(same?.id).toBe(job?.id);
    expect(same?.sentAt).not.toBeNull();
    expect(same?.changeSeq).toBe(firstSeq);

    // 同じ変更を重ねて読んでも、処理済みは飛ばす。
    expect(await indexer.processChanges()).toBe(0);
  });

  it("時刻が先へ動いたら送り直し、changeSeq を進める。削除で消える", async () => {
    const event = await insertEvent();
    await indexer.processChanges();
    const [job] = await jobs();
    await db
      .update(eventReminderJobs)
      .set({ sentAt: new Date(NOW) })
      .where(eq(eventReminderJobs.id, job?.id as string));
    await db
      .update(events)
      .set({
        startAt: new Date(NOW + 2 * DAY),
        endAt: new Date(NOW + 2 * DAY + HOUR),
      })
      .where(eq(events.id, event.id));
    await record("event", [event.id]);
    await indexer.processChanges();
    const [moved] = await jobs();
    expect(moved?.fireAt.getTime()).toBe(NOW + 2 * DAY - 10 * MIN);
    expect(moved?.sentAt).toBeNull();
    expect((moved?.changeSeq ?? 0n) > (job?.changeSeq ?? 0n)).toBe(true);

    await db.delete(events).where(eq(events.id, event.id));
    await record("event", [event.id], "delete");
    await indexer.processChanges();
    expect(await jobs()).toHaveLength(0);
    expect(await occurrences()).toHaveLength(0);
  });

  it("予定ごとのリマインダー、不参加、取り消しを反映する", async () => {
    const event = await insertEvent({ useDefaultReminders: false });
    await db
      .insert(eventReminders)
      .values({ eventId: event.id, method: "display", minutes: 60 });
    await record("event", [event.id]);
    await indexer.processChanges();
    expect((await jobs()).map((job) => job.minutes)).toEqual([60]);

    await db.insert(eventAttendees).values({
      eventId: event.id,
      email: "reminders@example.com",
      self: true,
      status: "declined",
    });
    await record("event", [event.id]);
    await indexer.processChanges();
    expect(await jobs()).toHaveLength(0);
    expect(await occurrences()).toHaveLength(1);

    await db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, event.id));
    await record("event", [event.id]);
    await indexer.processChanges();
    expect(await occurrences()).toHaveLength(0);
  });

  it("例外の追加で回を差し替え、例外だけの削除でも原本の回に戻す", async () => {
    const master = await insertEvent({
      startAt: new Date("2027-03-02T01:00:00Z"),
      endAt: new Date("2027-03-02T02:00:00Z"),
      rrule: "FREQ=WEEKLY;COUNT=3",
    });
    await indexer.processChanges();
    expect(await occurrences()).toHaveLength(3);
    const [exception] = await db
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: master.uid,
        parentId: master.id,
        recurrenceId: "2027-03-09T01:00:00Z",
        startAt: new Date("2027-03-09T05:00:00Z"),
        endAt: new Date("2027-03-09T06:00:00Z"),
        startTimeZone: "Asia/Tokyo",
      })
      .returning();
    await record("event", [exception?.id as string]);
    await indexer.processChanges();
    const list = await jobs();
    expect(list).toHaveLength(3);
    const moved = list.find((job) => job.eventId === exception?.id);
    expect(moved?.fireAt.toISOString()).toBe("2027-03-09T04:50:00.000Z");
    expect(moved?.recurrenceId).toBe("2027-03-09T01:00:00Z");

    await db.delete(events).where(eq(events.id, exception?.id as string));
    await record("event", [exception?.id as string], "delete");
    await indexer.processChanges();
    const back = await jobs();
    expect(back).toHaveLength(3);
    expect(back.every((job) => job.eventId === master.id)).toBe(true);
    expect(back[1]?.fireAt.toISOString()).toBe("2027-03-09T00:50:00.000Z");
  });

  it("カレンダーの通知をオフにすると job を消し、変わらない calendar の変更では作り直さない", async () => {
    await insertEvent();
    await indexer.processChanges();
    expect(await jobs()).toHaveLength(1);
    await db
      .update(calendars)
      .set({ notify: false })
      .where(eq(calendars.id, calendar.id));
    await record("calendar", [calendar.id]);
    await indexer.processChanges();
    expect(await jobs()).toHaveLength(0);
    const [row] = await db
      .select({ hash: calendars.remindersHash })
      .from(calendars)
      .where(eq(calendars.id, calendar.id));
    expect(row?.hash).toContain("false");

    await db
      .update(calendars)
      .set({ notify: null })
      .where(eq(calendars.id, calendar.id));
    await record("calendar", [calendar.id]);
    await indexer.processChanges();
    expect(await jobs()).toHaveLength(1);
  });

  it("終日の予定は利用者の既定 (当日 9:00) を使い、設定の変更で作り直す", async () => {
    await insertEvent({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2027-03-03",
      endDate: "2027-03-04",
    });
    await indexer.processChanges();
    const [job] = await jobs();
    expect(job?.minutes).toBe(-540);
    expect(job?.fireAt.toISOString()).toBe("2027-03-03T00:00:00.000Z"); // 東京 9:00

    await db.insert(userSettings).values({
      userId,
      timeZone: "America/New_York",
      calendarNotifications: { allDay: { minutes: 900 } },
    });
    await indexer.rebuildUser(userId);
    const [changed] = await jobs();
    expect(changed?.minutes).toBe(900);
    // 前日 9:00 (ニューヨーク、EST)。
    expect(changed?.fireAt.toISOString()).toBe("2027-03-02T14:00:00.000Z");

    await db
      .update(userSettings)
      .set({ calendarNotifications: { allDay: null } })
      .where(eq(userSettings.userId, userId));
    await indexer.rebuildUser(userId);
    expect(await jobs()).toHaveLength(0);
  });

  it("繰り上げ: expandedUntil が無いカレンダーを埋め、日がたつと回を足して古いものを消す", async () => {
    // 変更を記録せずに入れた予定 (マイグレーション前からある予定)。
    await db.insert(events).values({
      userId,
      calendarId: calendar.id,
      uid: "daily",
      summary: "朝会",
      startAt: new Date("2027-03-01T01:00:00Z"),
      endAt: new Date("2027-03-01T01:15:00Z"),
      startTimeZone: "Asia/Tokyo",
      rrule: "FREQ=DAILY",
    });
    await db
      .update(calendars)
      .set({ expandedUntil: null, remindersHash: null })
      .where(eq(calendars.id, calendar.id));
    await indexer.roll();
    const first = await occurrences();
    expect(first).toHaveLength(35);
    const [cal] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendar.id));
    expect(cal?.expandedUntil).toBe(occurrenceWindowEnd(NOW));
    expect(cal?.remindersHash).not.toBeNull();
    const jobCount = (await jobs()).length;

    // 2 回流しても同じ。
    await indexer.rebuildMasters(
      userId,
      first.map((row) => row.masterId),
      1n,
    );
    expect(await occurrences()).toHaveLength(35);
    expect(await jobs()).toHaveLength(jobCount);

    now = NOW + 3 * DAY;
    await indexer.roll();
    const after = await occurrences();
    expect(after).toHaveLength(36);
    expect(after[0]?.startAt?.toISOString()).toBe("2027-03-03T01:00:00.000Z");
  });
  // -------------------------------------------------------------------------
  // レビューの指摘 (M1、M2、M7、M8、L4) と、テストの抜け
  // -------------------------------------------------------------------------

  const latestSeq = async (entity: "event" | "calendar") => {
    const [row] = await db
      .select({ seq: sql<string>`max(${changes.seq})` })
      .from(changes)
      .where(eq(changes.entity, entity));
    return BigInt(row?.seq ?? 0);
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("計算が投げる予定が 1 件あっても、ほかの予定とほかの利用者は進む (M1)", async () => {
    const otherUser = await insertUser(
      db,
      `other-${crypto.randomUUID()}@example.com`,
    );
    const otherAccount = await insertAccount(db, otherUser, {
      calendarEnabled: true,
    });
    const otherCalendar = await insertCalendar(db, otherUser, otherAccount.id, {
      defaultReminders: [{ method: "display", minutes: 5 }],
      expandedUntil: occurrenceWindowEnd(NOW),
    });
    const bad = await insertEvent({
      rrule: "FREQ=WEEKLY",
      startTimeZone: "Customized Time Zone",
    });
    const good = await insertEvent();
    const [theirs] = await db
      .insert(events)
      .values({
        userId: otherUser,
        calendarId: otherCalendar.id,
        uid: crypto.randomUUID(),
        startAt: new Date(NOW + DAY),
        endAt: new Date(NOW + DAY + HOUR),
      })
      .returning();
    await db.transaction((tx) =>
      recordChanges(tx, otherUser, "event", "upsert", [theirs?.id as string]),
    );
    const logs: string[] = [];
    const isolated = new ReminderIndexer(db, null, {
      now: () => now,
      log: (message) => logs.push(message),
    });
    await isolated.processChanges();
    const list = await jobs();
    expect(list.map((job) => job.eventId).sort()).toEqual(
      [good.id, theirs?.id].sort(),
    );
    expect(logs.some((line) => line.includes(bad.id))).toBe(true);
    // 同じ所で止まり続けない (次の回は何も読み直さない)。
    expect(await isolated.processChanges()).toBe(0);
    await db.delete(calendars).where(eq(calendars.id, otherCalendar.id));
  });

  it("作り直しの失敗 (DB) は利用者ごとに切り離し、位置を進めずに後でやり直す (M1)", async () => {
    const event = await insertEvent();
    class Failing extends ReminderIndexer {
      remaining = 1;
      override async rebuildMasters(
        ...args: Parameters<ReminderIndexer["rebuildMasters"]>
      ) {
        if (this.remaining-- > 0) throw new Error("一時的な失敗");
        return super.rebuildMasters(...args);
      }
    }
    const failing = new Failing(db, null, {
      now: () => now,
      log: () => {},
    });
    expect(await failing.processChanges()).toBe(0);
    expect(await jobs()).toHaveLength(0);
    // 2 分たっても、失敗した変更より先へは位置を進めない。
    now = NOW + 3 * MIN;
    expect(await failing.processChanges()).toBe(1);
    expect((await jobs())[0]?.eventId).toBe(event.id);
  });

  it("最初の起動では先に位置を取り、埋め込みの間の変更も後で読む (M7)", async () => {
    await db.delete(workerCursors);
    const event = await insertEvent();
    await db
      .update(calendars)
      .set({ expandedUntil: null, remindersHash: null })
      .where(eq(calendars.id, calendar.id));
    // 埋め込み (繰り上げ) を止めておく (作り直しは利用者ごとの勧告ロックを取る)。
    const lock = new pg.Client({ connectionString: test.url });
    await lock.connect();
    const key = `reminder-indexer:${userId}`;
    await lock.query("select pg_advisory_lock(hashtext($1))", [key]);
    const started = new ReminderIndexer(db, null, { now: () => now });
    started.start();
    let cursor: { seq: bigint } | undefined;
    for (let i = 0; i < 200 && !cursor; i++) {
      [cursor] = await db
        .select({ seq: workerCursors.seq })
        .from(workerCursors)
        .where(eq(workerCursors.name, "reminder-indexer"));
      if (!cursor) await sleep(10);
    }
    // 埋め込みの途中で予定が変わる。
    await db
      .update(events)
      .set({
        startAt: new Date(NOW + 2 * DAY),
        endAt: new Date(NOW + 2 * DAY + HOUR),
      })
      .where(eq(events.id, event.id));
    await record("event", [event.id]);
    expect(cursor).toBeDefined();
    expect((cursor?.seq ?? 0n) < (await latestSeq("event"))).toBe(true);
    await lock.query("select pg_advisory_unlock(hashtext($1))", [key]);
    await lock.end();
    await started.enqueue(async () => {});
    await started.enqueue(async () => {});
    await started.stop();
    const [job] = await jobs();
    expect(job?.fireAt.getTime()).toBe(NOW + 2 * DAY - 10 * MIN);
  });

  it("繰り上げで作る job の changeSeq は予定の変更の位置で、メールの変更を混ぜない (M2)", async () => {
    await insertEvent({
      startAt: new Date(NOW + HOUR),
      endAt: new Date(NOW + 2 * HOUR),
      rrule: "FREQ=DAILY",
    });
    await indexer.processChanges();
    const eventSeq = await latestSeq("event");
    // その後にメールが届く (changes の seq は進むが、端末の coverSeq は進まない)。
    await db.transaction((tx) =>
      recordChanges(tx, userId, "message", "upsert", [crypto.randomUUID()]),
    );
    now = NOW + 2 * DAY;
    await indexer.roll();
    const list = await jobs();
    const added = list.at(-1);
    expect(added?.changeSeq).toBe(eventSeq);
    // 予定の変更の位置まで同期して予約した端末には送らない。
    expect(
      deviceCoversReminder(
        {
          coverUntil: new Date((added?.fireAt.getTime() ?? 0) + DAY),
          coverSeq: eventSeq,
          exact: true,
        },
        {
          fireAt: added?.fireAt.getTime() ?? 0,
          changeSeq: added?.changeSeq ?? 0n,
        },
      ),
    ).toBe(true);
  });

  it("seq の順とコミットの順が前後しても読み、別の Indexer で読み直しても同じ結果 (重ね読み)", async () => {
    const insertQuiet = async () => {
      const [row] = await db
        .insert(events)
        .values({
          userId,
          calendarId: calendar.id,
          uid: crypto.randomUUID(),
          startAt: new Date(NOW + DAY),
          endAt: new Date(NOW + DAY + HOUR),
          startTimeZone: "Asia/Tokyo",
        })
        .returning();
      if (!row) throw new Error("予定を作れませんでした。");
      return row;
    };
    const early = await insertQuiet();
    const late = await insertQuiet();
    // 先に seq を取ったトランザクションが、後からコミットする。
    const slow = new pg.Client({ connectionString: test.url });
    await slow.connect();
    await slow.query("begin");
    await slow.query(
      "insert into changes (user_id, entity, entity_id, op) values ($1, 'event', $2, 'upsert')",
      [userId, early.id],
    );
    await record("event", [late.id]);
    await indexer.processChanges();
    expect((await jobs()).map((job) => job.eventId)).toEqual([late.id]);
    await slow.query("commit");
    await slow.end();
    now = NOW + 30_000;
    await indexer.processChanges();
    const before = await jobs();
    expect(before.map((job) => job.eventId).sort()).toEqual(
      [early.id, late.id].sort(),
    );
    // 再起動 (保存した位置から読み直す) しても同じ。
    const restarted = new ReminderIndexer(db, null, { now: () => now });
    await restarted.processChanges();
    expect(await jobs()).toEqual(before);
  });

  it("例外だけの削除ではその原本だけを作り直し、設定の変更はまとめて終日と浮動時刻だけを作り直す (M8)", async () => {
    class Spy extends ReminderIndexer {
      calls: string[][] = [];
      override async rebuildMasters(
        ...args: Parameters<ReminderIndexer["rebuildMasters"]>
      ) {
        this.calls.push([...args[1]]);
        return super.rebuildMasters(...args);
      }
    }
    const spy = new Spy(db, null, { now: () => now });
    const weekly = await insertEvent({
      startAt: new Date("2027-03-02T01:00:00Z"),
      endAt: new Date("2027-03-02T02:00:00Z"),
      rrule: "FREQ=WEEKLY;COUNT=3",
    });
    await insertEvent({
      startAt: new Date("2027-03-03T01:00:00Z"),
      endAt: new Date("2027-03-03T02:00:00Z"),
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const [exception] = await db
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: weekly.uid,
        parentId: weekly.id,
        recurrenceId: "2027-03-09T01:00:00Z",
        startAt: new Date("2027-03-09T05:00:00Z"),
        endAt: new Date("2027-03-09T06:00:00Z"),
        startTimeZone: "Asia/Tokyo",
      })
      .returning();
    await record("event", [exception?.id as string]);
    await spy.processChanges();
    spy.calls = [];
    await db.delete(events).where(eq(events.id, exception?.id as string));
    await record("event", [exception?.id as string], "delete");
    await spy.processChanges();
    expect(spy.calls).toEqual([[weekly.id]]);
    expect(
      (await occurrences()).filter((row) => row.eventId === null),
    ).toHaveLength(0);

    const allDay = await insertEvent({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2027-03-05",
      endDate: "2027-03-06",
    });
    const floating = await insertEvent({ startTimeZone: null });
    await spy.processChanges();
    spy.calls = [];
    for (let i = 0; i < 5; i++) spy.requestUserRebuild(userId);
    await spy.enqueue(async () => {});
    expect(spy.calls).toHaveLength(1);
    expect(new Set(spy.calls[0])).toEqual(new Set([allDay.id, floating.id]));
  });

  it("終日の job は夏時間をまたいでも現地の 9:00。タイムゾーンを変えても送信済みを鳴らし直さない (L4)", async () => {
    await db
      .insert(userSettings)
      .values({ userId, timeZone: "America/New_York" });
    await insertEvent({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2027-03-13",
      endDate: "2027-03-14",
      rrule: "FREQ=DAILY;COUNT=3",
    });
    await indexer.processChanges();
    const list = await jobs();
    // 3/14 から夏時間 (EDT)。
    expect(list.map((job) => job.fireAt.toISOString())).toEqual([
      "2027-03-13T14:00:00.000Z",
      "2027-03-14T13:00:00.000Z",
      "2027-03-15T13:00:00.000Z",
    ]);
    await db
      .update(eventReminderJobs)
      .set({ sentAt: new Date(NOW) })
      .where(eq(eventReminderJobs.id, list[0]?.id as string));
    await db
      .update(userSettings)
      .set({ timeZone: "America/Los_Angeles" })
      .where(eq(userSettings.userId, userId));
    await indexer.rebuildUser(userId);
    const [first] = await jobs();
    expect(first?.fireAt.toISOString()).toBe("2027-03-13T17:00:00.000Z");
    expect(first?.sentAt).not.toBeNull();
  });

  it("繰り返すかどうかを変えても、同じ時刻の送信済みを引き継ぐ (L4)", async () => {
    const event = await insertEvent();
    await indexer.processChanges();
    const [job] = await jobs();
    await db
      .update(eventReminderJobs)
      .set({ sentAt: new Date(NOW) })
      .where(eq(eventReminderJobs.id, job?.id as string));
    await db
      .update(events)
      .set({ rrule: "FREQ=DAILY;COUNT=2" })
      .where(eq(events.id, event.id));
    await record("event", [event.id]);
    await indexer.processChanges();
    const list = await jobs();
    expect(list).toHaveLength(2);
    expect(list[0]?.recurrenceId).not.toBeNull();
    expect(list[0]?.fireAt.getTime()).toBe(job?.fireAt.getTime());
    expect(list[0]?.sentAt).not.toBeNull();
    expect(list[1]?.sentAt).toBeNull();
  });

  it("RDATE だけの繰り返しと、親の無い例外も控えに入れる", async () => {
    await insertEvent({
      startAt: new Date("2027-03-02T01:00:00Z"),
      endAt: new Date("2027-03-02T02:00:00Z"),
      rdates: ["2027-03-05T01:00:00Z"],
    });
    await insertEvent({
      uid: "orphan",
      recurrenceId: "2027-03-04T01:00:00Z",
      startAt: new Date("2027-03-04T03:00:00Z"),
      endAt: new Date("2027-03-04T04:00:00Z"),
    });
    await indexer.processChanges();
    expect((await jobs()).map((job) => job.fireAt.toISOString())).toEqual([
      "2027-03-02T00:50:00.000Z",
      "2027-03-04T02:50:00.000Z",
      "2027-03-05T00:50:00.000Z",
    ]);
  });
});
