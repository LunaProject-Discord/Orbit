/**
 * Google のプロバイダを、土台の取り込みと書き戻し (実際の PostgreSQL) につないで確かめる。
 * 相手側は偽の Google Calendar API (fetch の差し替え)。DATABASE_URL が無い環境では実行しない。
 */
import { randomUUID } from "node:crypto";
import {
  calendars,
  type Database,
  events,
  listEventEtags,
  listEventKeys,
  outbox,
} from "@orbit/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { googleEventIdFor } from "./convert.js";
import { FakeGoogleCalendar } from "./fake-google.js";
import { createGoogleProvider } from "./index.js";

const adminUrl = process.env.DATABASE_URL;
const PRIMARY = "me@example.com";

describe.skipIf(!adminUrl)("Google と土台の取り込み・書き戻し", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendarId: string;
  const server = new FakeGoogleCalendar();
  const provider = createGoogleProvider();
  let ctx: ProviderContext;
  const logs: string[] = [];

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_google");
    db = test.db;
    userId = await insertUser(db, "google@example.com");
    account = await insertAccount(db, userId, {
      email: PRIMARY,
      calendarEnabled: true,
    });
    const calendar = await insertCalendar(db, userId, account.id, {
      remoteId: PRIMARY,
      timeZone: "Asia/Tokyo",
    });
    calendarId = calendar.id;
    server.calendars = [
      { id: PRIMARY, summary: PRIMARY, accessRole: "owner", primary: true },
    ];
    ctx = makeProviderContext({
      account,
      fetchFn: server.fetch,
      log: (message) => logs.push(message),
    });
  });
  afterAll(async () => {
    await test?.drop();
  });

  const sync = async () => {
    const [calendar] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendarId));
    if (!calendar) throw new Error("カレンダーがありません。");
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
        log: (message) => logs.push(message),
      });
      pageCursor = delta.nextPageCursor;
    } while (pageCursor !== null);
  };
  const rows = () =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendarId))
      .orderBy(asc(events.recurrenceId));
  let seq = 0;
  const enqueue = async (
    kind: "event_create" | "event_update",
    payload: object,
  ) => {
    seq++;
    await db.insert(outbox).values({
      accountId: account.id,
      kind,
      payload,
      idempotencyKey: `${kind}:${randomUUID()}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    });
  };
  const run = () =>
    processEventOutbox({
      db,
      account,
      provider,
      ctx,
      log: (m) => logs.push(m),
    });

  it("原本と例外 (取り消した回を含む) を、同じ uid と親子で取り込む", async () => {
    server.put(PRIMARY, {
      id: "wk",
      summary: "定例",
      start: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-01T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    server.put(PRIMARY, {
      id: "wk_20261202T010000Z",
      recurringEventId: "wk",
      iCalUID: "wk@google.com",
      originalStartTime: { dateTime: "2026-12-02T10:00:00+09:00" },
      summary: "この回は場所が違う",
      location: "別館",
      start: { dateTime: "2026-12-02T10:00:00+09:00" },
      end: { dateTime: "2026-12-02T11:00:00+09:00" },
    });
    // 取り消した回は iCalUID を持たないことがある (土台が原本から補う)。
    server.put(PRIMARY, {
      id: "wk_20261203T010000Z",
      recurringEventId: "wk",
      originalStartTime: { dateTime: "2026-12-03T01:00:00Z" },
      status: "cancelled",
    });
    await sync();
    const list = await rows();
    const master = list.find((row) => row.recurrenceId === null);
    expect(list.map((row) => [row.uid, row.recurrenceId, row.status])).toEqual([
      ["wk@google.com", "2026-12-02T01:00:00Z", "confirmed"],
      ["wk@google.com", "2026-12-03T01:00:00Z", "cancelled"],
      ["wk@google.com", null, "confirmed"],
    ]);
    for (const row of list.filter((item) => item.recurrenceId !== null)) {
      expect(row.parentId).toBe(master?.id);
    }
  });

  it("Orbit で作った予定に、Google の ID と iCalUID が付く", async () => {
    const id = randomUUID();
    await db.insert(events).values({
      id,
      userId,
      calendarId,
      uid: `${id}@orbit`,
      summary: "新しい予定",
      startAt: new Date("2026-12-10T01:00:00Z"),
      endAt: new Date("2026-12-10T02:00:00Z"),
      startTimeZone: "Asia/Tokyo",
      endTimeZone: "Asia/Tokyo",
    });
    await enqueue("event_create", { eventId: id, calendarId });
    await run();
    const [row] = await db.select().from(events).where(eq(events.id, id));
    const remoteId = googleEventIdFor(id);
    expect(row).toMatchObject({ remoteId, uid: `${remoteId}@google.com` });
    expect(server.get(PRIMARY, remoteId)?.summary).toBe("新しい予定");
    // 次の差分同期でも二重にならない。
    await sync();
    expect(
      (await rows()).filter((item) => item.remoteId === remoteId),
    ).toHaveLength(1);
  });

  it("回の削除 (原本の exdates) を、Google の回の取り消しとして書き戻す", async () => {
    const [master] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendarId),
          eq(events.remoteId, "wk"),
          isNull(events.recurrenceId),
        ),
      );
    if (!master) throw new Error("原本がありません。");
    await db
      .update(events)
      .set({
        exdates: ["2026-12-05T01:00:00Z"],
        fieldUpdatedAt: { recurrence: new Date().toISOString() },
      })
      .where(eq(events.id, master.id));
    await enqueue("event_update", {
      eventId: master.id,
      calendarId,
      fields: ["recurrence"],
    });
    await run();
    const statuses = (
      await db.select().from(outbox).where(eq(outbox.accountId, account.id))
    ).map((row) => row.status);
    expect(statuses.every((status) => status === "done")).toBe(true);
    expect(server.get(PRIMARY, "wk_20261205T010000Z")?.status).toBe(
      "cancelled",
    );
    await sync();
    const cancelled = (await rows()).find(
      (row) => row.recurrenceId === "2026-12-05T01:00:00Z",
    );
    expect(cancelled).toMatchObject({
      status: "cancelled",
      parentId: master.id,
    });
    expect(
      logs.filter((line) => line.includes("書き込みませんでした")),
    ).toEqual([]);
  });
});
