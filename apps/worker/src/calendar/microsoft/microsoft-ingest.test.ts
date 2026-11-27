/**
 * Microsoft のプロバイダを、土台の取り込み (ingestEventDelta) と実際の PostgreSQL で確かめる。
 * Graph は偽物 (fetch の差し替え)。DATABASE_URL が無い環境では実行しない。
 */
import { type Database, events } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AccountRow, CalendarRow } from "../provider.js";
import { syncCalendar } from "../testing/sync.js";
import {
  createTestDatabase,
  insertAccount,
  insertCalendar,
  insertUser,
  type TestDatabase,
} from "../testing/test-db.js";
import { FakeGraph } from "./fake-graph.js";
import { createMicrosoftProvider } from "./index.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("Microsoft の予定の取り込み (DB)", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendar: CalendarRow;
  let graph: FakeGraph;
  const provider = createMicrosoftProvider({
    now: () => new Date("2026-11-27T00:00:00Z"),
  });

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_msgraph");
    db = test.db;
    userId = await insertUser(db, "msgraph@example.com");
    account = await insertAccount(db, userId, {
      provider: "microsoft",
      protocol: "graph",
      calendarEnabled: true,
    });
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    calendar = await insertCalendar(db, userId, account.id, {
      source: "microsoft",
      remoteId: "cal-1",
      timeZone: "Asia/Tokyo",
    });
    graph = new FakeGraph();
    // testing/sync.ts の syncCalendar は既定の fetch を使うので、差し替える。
    vi.stubGlobal("fetch", graph.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const rows = () =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendar.id))
      .orderBy(sql`${events.recurrenceId} nulls first`);

  it("例外は原本の uid で、原本の子として入る。原本ごと消えたら全部消える", async () => {
    graph.put("cal-1", {
      id: "master-1",
      type: "seriesMaster",
      iCalUId: "series-uid",
      subject: "週次",
      originalStartTimeZone: "Tokyo Standard Time",
      start: { dateTime: "2026-12-07T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-07T02:00:00.0000000", timeZone: "UTC" },
      recurrence: {
        pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
        range: { type: "noEnd", startDate: "2026-12-07" },
      },
    });
    graph.put("cal-1", {
      id: "exception-1",
      type: "exception",
      seriesMasterId: "master-1",
      iCalUId: "different-uid",
      originalStart: "2026-12-14T01:00:00Z",
      subject: "週次 (変更)",
      start: { dateTime: "2026-12-14T03:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-14T04:00:00.0000000", timeZone: "UTC" },
    });
    await syncCalendar(db, provider, account, calendar.id);
    const [master, exception] = await rows();
    expect(master).toMatchObject({
      uid: "series-uid",
      remoteId: "master-1",
      recurrenceId: null,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    expect(exception).toMatchObject({
      uid: "series-uid",
      remoteId: "exception-1",
      recurrenceId: "2026-12-14T01:00:00Z",
      parentId: master?.id,
      summary: "週次 (変更)",
    });

    graph.remove("master-1");
    await syncCalendar(db, provider, account, calendar.id);
    expect(await rows()).toEqual([]);
  });
});
