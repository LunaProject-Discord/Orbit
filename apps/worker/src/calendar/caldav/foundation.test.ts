/**
 * CalDAV のプロバイダを、土台の取り込み (ingestEventDelta) と書き戻し (processEventOutbox) につないで、
 * 実際の PostgreSQL と偽の CalDAV サーバーで確かめる。DATABASE_URL が無い環境では実行しない。
 */
import { randomUUID } from "node:crypto";
import {
  calendars,
  type Database,
  eventReminders,
  events,
  listEventEtags,
  listEventKeys,
  outbox,
} from "@orbit/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestEventDelta } from "../ingest.js";
import { processEventOutbox } from "../outbox.js";
import type { AccountRow, ProviderContext, RemoteEvent } from "../provider.js";
import { makeProviderContext } from "../testing/provider-contract.js";
import {
  createTestDatabase,
  insertAccount,
  insertCalendar,
  insertUser,
  type TestDatabase,
} from "../testing/test-db.js";
import { FakeCaldavServer, vcalendar, vevent } from "./fake-server.js";
import { createCaldavProvider } from "./index.js";

const adminUrl = process.env.DATABASE_URL;

const SERIES = vcalendar(
  vevent({
    UID: "series@example.com",
    DTSTART: "20261201T010000Z",
    DTEND: "20261201T020000Z",
    RRULE: "FREQ=WEEKLY",
    SUMMARY: "週次",
    "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR": "AUTOMATIC",
  }),
  vevent({
    UID: "series@example.com",
    "RECURRENCE-ID": "20261208T010000Z",
    DTSTART: "20261208T030000Z",
    DTEND: "20261208T040000Z",
    SUMMARY: "週次 (ずらした回)",
  }),
);

describe.skipIf(!adminUrl)("CalDAV と土台の取り込み・書き戻し", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendarId: string;
  let server: FakeCaldavServer;
  let ctx: ProviderContext;
  const provider = createCaldavProvider({ isPrivateHost: async () => false });
  const logs: string[] = [];

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_caldav");
    db = test.db;
    userId = await insertUser(db, "caldav@example.com");
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    server = new FakeCaldavServer({ syncCollection: true });
    server.putDirect("/cal/user/work/series.ics", SERIES);
    account = await insertAccount(db, userId, {
      provider: "generic",
      authType: "password",
      username: "user",
      caldavUrl: `${server.origin}/`,
      mailEnabled: false,
      calendarEnabled: true,
    });
    const url = `${server.origin}/cal/user/work/`;
    const calendar = await insertCalendar(db, userId, account.id, {
      source: "caldav",
      remoteId: url,
      url,
      timeZone: "Asia/Tokyo",
      providerState: { syncCollection: true },
    });
    calendarId = calendar.id;
    const base = makeProviderContext({ account });
    ctx = {
      ...base,
      auth: { type: "password", username: "user", password: "secret" },
      fetchFn: server.fetch,
    };
  });

  const sync = async () => {
    const [calendar] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendarId));
    if (!calendar) throw new Error("カレンダーがありません");
    const seen = new Set<string>();
    const carry: RemoteEvent[] = [];
    let pageCursor: string | null = null;
    do {
      const delta = await provider.syncEvents(ctx, calendar, {
        syncToken: calendar.syncToken,
        pageCursor,
        knownEtags: () => listEventEtags(db, calendar.id),
        knownEvents: () => listEventKeys(db, calendar.id),
      });
      await ingestEventDelta(db, {
        account,
        calendar,
        provider,
        delta,
        seen,
        carry,
      });
      pageCursor = delta.nextPageCursor;
    } while (pageCursor !== null);
  };
  const rows = () =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendarId))
      .orderBy(events.recurrenceId);
  const run = () =>
    processEventOutbox({
      db,
      account,
      provider,
      ctx,
      log: (message) => logs.push(message),
    });
  const enqueue = async (
    kind: "event_create" | "event_update",
    payload: Record<string, unknown>,
  ) => {
    await db.insert(outbox).values({
      accountId: account.id,
      kind,
      payload,
      idempotencyKey: `${kind}:${randomUUID()}`,
    });
  };

  it("原本と例外を 1 つの href で取り込み、ローカルの変更を書き戻して、相手側の変更を取り込む", async () => {
    await sync();
    let list = await rows();
    expect(
      list.map((row) => [row.recurrenceId, row.remoteId, row.summary]),
    ).toEqual([
      [
        "2026-12-08T01:00:00Z",
        "/cal/user/work/series.ics",
        "週次 (ずらした回)",
      ],
      [null, "/cal/user/work/series.ics", "週次"],
    ]);
    const master = list.find((row) => row.recurrenceId === null);
    if (!master) throw new Error("原本がありません");
    expect(list.find((row) => row.recurrenceId)?.parentId).toBe(master.id);

    // ローカルで題を変えて書き戻す。
    const changedAt = new Date().toISOString();
    await db
      .update(events)
      .set({ summary: "週次 (改題)", fieldUpdatedAt: { summary: changedAt } })
      .where(eq(events.id, master.id));
    await enqueue("event_update", {
      eventId: master.id,
      calendarId,
      fields: ["summary"],
    });
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
    const stored =
      server.resources.get("/cal/user/work/series.ics")?.data ?? "";
    expect(stored).toContain("SUMMARY:週次 (改題)");
    expect(stored).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
    list = await rows();
    // 原本と例外の両方が、新しい etag になる。
    const etag = server.resources.get("/cal/user/work/series.ics")?.etag;
    expect(list.map((row) => row.etag)).toEqual([etag, etag]);

    // 自分の書き込みは差分で取り直さない。相手側の変更は取り込む。
    await sync();
    server.putDirect(
      "/cal/user/work/series.ics",
      stored.replace("SUMMARY:週次 (ずらした回)", "SUMMARY:相手側で変えた回"),
    );
    await sync();
    list = await rows();
    expect(list.map((row) => row.summary)).toEqual([
      "相手側で変えた回",
      "週次 (改題)",
    ]);
  });

  it("回の削除 (原本の recurrence の変更) は EXDATE を足し、その回の例外をリソースから取り除く", async () => {
    await sync();
    const list = await rows();
    const master = list.find((row) => row.recurrenceId === null);
    const exception = list.find((row) => row.recurrenceId !== null);
    if (!master || !exception) throw new Error("行がありません");
    // API の回の削除と同じく、例外の行を消し、原本の exdates に足す。
    await db.delete(events).where(eq(events.id, exception.id));
    await db
      .update(events)
      .set({
        exdates: ["2026-12-08T01:00:00Z"],
        fieldUpdatedAt: { recurrence: new Date().toISOString() },
      })
      .where(eq(events.id, master.id));
    await enqueue("event_update", {
      eventId: master.id,
      calendarId,
      fields: ["recurrence"],
    });
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
    const stored =
      server.resources.get("/cal/user/work/series.ics")?.data ?? "";
    expect(stored).toContain("EXDATE:20261208T010000Z");
    expect(stored).not.toContain("RECURRENCE-ID");
    await sync();
    expect((await rows()).map((row) => row.recurrenceId)).toEqual([null]);
  });

  it("Orbit で作った予定は events.id の href に作られ、remoteId が付く", async () => {
    await sync();
    const id = randomUUID();
    await db.insert(events).values({
      id,
      userId,
      calendarId,
      uid: `${id}@orbit`,
      summary: "作った予定",
      startAt: new Date("2026-12-05T01:00:00Z"),
      endAt: new Date("2026-12-05T02:00:00Z"),
      startTimeZone: "Asia/Tokyo",
      endTimeZone: "Asia/Tokyo",
      fieldUpdatedAt: { summary: new Date().toISOString() },
    });
    await enqueue("event_create", { eventId: id, calendarId });
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
    const [row] = await db.select().from(events).where(eq(events.id, id));
    expect(row?.remoteId).toBe(`/cal/user/work/${id}.ics`);
    expect(row?.etag).toBe(
      server.resources.get(`/cal/user/work/${id}.ics`)?.etag,
    );
    await sync();
    const pending = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.calendarId, calendarId), isNull(events.remoteId)));
    expect(pending).toHaveLength(0);
    expect(logs.filter((line) => line.includes("失敗"))).toEqual([]);
  });

  it("終日の負の分 (当日 9:00) は TRIGGER:PT9H で書き、書き戻しと取り込みを往復しても変わらない", async () => {
    await sync();
    const id = randomUUID();
    await db.insert(events).values({
      id,
      userId,
      calendarId,
      uid: `${id}@orbit`,
      summary: "休み",
      allDay: true,
      startDate: "2026-12-24",
      endDate: "2026-12-25",
      useDefaultReminders: false,
    });
    await db.insert(eventReminders).values([
      { eventId: id, method: "display", minutes: -540 },
      { eventId: id, method: "display", minutes: 900 },
    ]);
    const minutesOf = async () =>
      (
        await db
          .select()
          .from(eventReminders)
          .where(eq(eventReminders.eventId, id))
      )
        .map((row) => row.minutes)
        .sort((a, b) => a - b);
    const href = `/cal/user/work/${id}.ics`;
    await enqueue("event_create", { eventId: id, calendarId });
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
    let stored = server.resources.get(href)?.data ?? "";
    expect(stored).toContain("TRIGGER:PT9H");
    expect(stored).toContain("TRIGGER:-PT900M");
    await sync();
    expect(await minutesOf()).toEqual([-540, 900]);

    // 別の項目を書き戻しても VALARM は変わらない。
    await db
      .update(events)
      .set({
        summary: "冬休み",
        fieldUpdatedAt: { summary: new Date().toISOString() },
      })
      .where(eq(events.id, id));
    await enqueue("event_update", {
      eventId: id,
      calendarId,
      fields: ["summary"],
    });
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
    stored = server.resources.get(href)?.data ?? "";
    expect(stored.match(/BEGIN:VALARM/g)).toHaveLength(2);
    await sync();
    expect(await minutesOf()).toEqual([-540, 900]);

    // リマインダーを書き戻しても (読んだ値のまま) 同じ。
    await enqueue("event_update", {
      eventId: id,
      calendarId,
      fields: ["reminders"],
    });
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
    await sync();
    expect(await minutesOf()).toEqual([-540, 900]);

    // 相手側で当日 10:00 に変えたら -600 で読む。
    server.putDirect(href, stored.replace("TRIGGER:PT9H", "TRIGGER:PT10H"));
    await sync();
    expect(await minutesOf()).toEqual([-600, 900]);
  });

  it("全件同期で iCalendar を読めなくなったリソースの行は消さない", async () => {
    await sync();
    expect(await rows()).toHaveLength(2);
    // 相手側のリソースが読めない形になり、同期の位置も無効になった (全件で取り直す)。
    server.putDirect(
      "/cal/user/work/series.ics",
      "BEGIN:VEVENT\r\nUID:series@example.com\r\nEND:VEVENT\r\n",
    );
    await db
      .update(calendars)
      .set({ syncToken: null })
      .where(eq(calendars.id, calendarId));
    await sync();
    expect((await rows()).map((row) => [row.remoteId, row.summary])).toEqual([
      ["/cal/user/work/series.ics", "週次 (ずらした回)"],
      ["/cal/user/work/series.ics", "週次"],
    ]);
    // 消えたリソースは、全件同期で消す。
    server.deleteDirect("/cal/user/work/series.ics");
    await db
      .update(calendars)
      .set({ syncToken: null })
      .where(eq(calendars.id, calendarId));
    await sync();
    expect(await rows()).toHaveLength(0);
  });
});
