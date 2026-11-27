/**
 * 予定の取り込み (ingestEventDelta) を、偽のプロバイダと実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import { calendars, changes, type Database, events, outbox } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccountRow, CalendarRow } from "./provider.js";
import { FakeCalendarProvider } from "./testing/fake-provider.js";
import { syncCalendar } from "./testing/sync.js";
import {
  createTestDatabase,
  insertAccount,
  insertCalendar,
  insertUser,
  type TestDatabase,
} from "./testing/test-db.js";

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("予定の取り込み", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendar: CalendarRow;
  let fake: FakeCalendarProvider;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_ingest");
    db = test.db;
    userId = await insertUser(db, "ingest@example.com");
    account = await insertAccount(db, userId, { calendarEnabled: true });
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    calendar = await insertCalendar(db, userId, account.id);
    fake = new FakeCalendarProvider();
  });

  const remoteId = () => calendar.remoteId as string;
  const rows = () =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendar.id))
      .orderBy(events.uid, events.recurrenceId);
  const calendarRow = async () => {
    const [row] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendar.id));
    return row as CalendarRow;
  };
  const sync = () => syncCalendar(db, fake, account, calendar.id);
  const enqueue = (
    kind: "event_create" | "event_update" | "event_delete",
    payload: Record<string, unknown>,
  ) =>
    db.insert(outbox).values({
      accountId: account.id,
      kind,
      payload,
      idempotencyKey: `${kind}:${crypto.randomUUID()}`,
    });

  it("複数のページを取り込み、最後のページで同期の位置を保存する。差分では変更と削除を反映する", async () => {
    fake.pageSize = 2;
    fake.putRemote(
      remoteId(),
      ["a", "b", "c", "d", "e"].map((id) => ({
        remoteId: id,
        summary: `予定 ${id}`,
      })),
    );
    const results = await sync();
    expect(results).toHaveLength(3);
    expect((await rows()).map((row) => row.summary)).toEqual([
      "予定 a",
      "予定 b",
      "予定 c",
      "予定 d",
      "予定 e",
    ]);
    const after = await calendarRow();
    expect(after.syncToken).toMatch(/^v\d+$/);
    expect(after.lastSyncedAt).not.toBeNull();

    fake.putRemote(remoteId(), [{ remoteId: "b", summary: "変えた b" }]);
    fake.removeRemote(remoteId(), "d");
    await sync();
    const list = await rows();
    expect(list.map((row) => row.remoteId)).toEqual(["a", "b", "c", "e"]);
    expect(list.find((row) => row.remoteId === "b")?.summary).toBe("変えた b");
  });

  it("変更履歴に、作った予定と消した予定を記録する", async () => {
    fake.putRemote(remoteId(), [{ remoteId: "x" }, { remoteId: "y" }]);
    await sync();
    const ids = (await rows()).map((row) => row.id);
    const upserts = await db
      .select()
      .from(changes)
      .where(and(eq(changes.userId, userId), eq(changes.entity, "event")));
    for (const id of ids) {
      expect(
        upserts.some((row) => row.entityId === id && row.op === "upsert"),
      ).toBe(true);
    }
    const removed = ids[0] as string;
    fake.removeRemote(remoteId(), "x");
    await sync();
    const deletes = await db
      .select()
      .from(changes)
      .where(and(eq(changes.entityId, removed), eq(changes.op, "delete")));
    expect(deletes).toHaveLength(1);
  });

  it("全件同期の仕上げで、出てこなかった予定を消す。書き戻し待ちの予定とその原本は残す", async () => {
    fake.putRemote(remoteId(), [
      {
        remoteId: "master",
        uid: "series",
        rrule: "FREQ=DAILY;COUNT=5",
      },
      { remoteId: "gone" },
      { remoteId: "stay" },
    ]);
    await sync();
    const master = (await rows()).find((row) => row.remoteId === "master");
    if (!master) throw new Error("原本がありません。");
    // 回の変更 (まだ相手側に無い例外) と、作成の書き戻し待ちの予定。
    const [exception] = await db
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: "series",
        recurrenceId: "2026-12-02T01:00:00Z",
        parentId: master.id,
        summary: "この回だけ変えた",
        startAt: new Date("2026-12-02T03:00:00Z"),
        endAt: new Date("2026-12-02T04:00:00Z"),
      })
      .returning();
    const [local] = await db
      .insert(events)
      .values({
        userId,
        calendarId: calendar.id,
        uid: "local@orbit",
        summary: "作ったばかり",
        startAt: new Date("2026-12-03T03:00:00Z"),
        endAt: new Date("2026-12-03T04:00:00Z"),
      })
      .returning();
    await enqueue("event_update", {
      eventId: exception?.id,
      calendarId: calendar.id,
      fields: ["summary", "time"],
    });
    await enqueue("event_create", {
      eventId: local?.id,
      calendarId: calendar.id,
    });

    // 相手側で原本と gone が消え、同期の位置も無効になった (全件で取り直す)。
    fake.removeRemote(remoteId(), "master");
    fake.removeRemote(remoteId(), "gone");
    await db
      .update(calendars)
      .set({ syncToken: null })
      .where(eq(calendars.id, calendar.id));
    await sync();

    const list = await rows();
    const ids = list.map((row) => row.id);
    expect(ids).toContain(master.id);
    expect(ids).toContain(exception?.id);
    expect(ids).toContain(local?.id);
    expect(list.some((row) => row.remoteId === "gone")).toBe(false);
    expect(list.some((row) => row.remoteId === "stay")).toBe(true);
  });

  it("書き戻し待ちの項目は上書きしない。ほかの項目は相手側を採る", async () => {
    const base = new Date(Date.now() - 60 * 60_000);
    fake.putRemote(remoteId(), [
      {
        remoteId: "p",
        summary: "元の題",
        location: "元の場所",
        remoteUpdatedAt: base.toISOString(),
      },
    ]);
    await sync();
    const [row] = await rows();
    if (!row) throw new Error("予定がありません。");
    // ローカルで題を変えた (書き戻し待ち)。
    const localAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await db
      .update(events)
      .set({ summary: "ローカルの題", fieldUpdatedAt: { summary: localAt } })
      .where(eq(events.id, row.id));
    await enqueue("event_update", {
      eventId: row.id,
      calendarId: calendar.id,
      fields: ["summary"],
    });
    // 相手側では、ローカルより前に場所と題が変わっていた。
    fake.putRemote(remoteId(), [
      {
        remoteId: "p",
        summary: "相手側の題",
        location: "相手側の場所",
        remoteUpdatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      },
    ]);
    await sync();
    const [merged] = await rows();
    expect(merged?.summary).toBe("ローカルの題");
    expect(merged?.location).toBe("相手側の場所");
    // raw は相手側の内容 (次の比較の基準) になる。
    expect(merged?.raw).toContain("相手側の題");

    // 相手側でもっと新しく題が変わったら、相手側が勝つ。
    fake.putRemote(remoteId(), [
      {
        remoteId: "p",
        summary: "新しい相手側の題",
        location: "相手側の場所",
        remoteUpdatedAt: new Date().toISOString(),
      },
    ]);
    const results = await sync();
    const [latest] = await rows();
    expect(latest?.summary).toBe("新しい相手側の題");
    expect(results.flatMap((result) => result.lostLocal)).toEqual([
      { eventId: row.id, fields: ["summary"] },
    ]);
  });

  it("削除の書き戻し待ちの予定は取り込まない。変更の書き戻し待ちの予定は、相手側で消えても残す", async () => {
    fake.putRemote(remoteId(), [{ remoteId: "del" }, { remoteId: "upd" }]);
    await sync();
    const [deleting, updating] = await rows();
    if (!deleting || !updating) throw new Error("予定がありません。");
    // API が del を消して、削除を積んだ。
    await db.delete(events).where(eq(events.id, deleting.id));
    await enqueue("event_delete", {
      calendarId: calendar.id,
      target: {
        eventId: deleting.id,
        calendarId: calendar.id,
        remoteId: "del",
        etag: deleting.etag,
        uid: deleting.uid,
        recurrenceId: null,
        parentRemoteId: null,
      },
      deletedAt: new Date().toISOString(),
    });
    await enqueue("event_update", {
      eventId: updating.id,
      calendarId: calendar.id,
      fields: ["summary"],
    });
    fake.putRemote(remoteId(), [{ remoteId: "del", summary: "相手側で変更" }]);
    fake.removeRemote(remoteId(), "upd");
    await sync();
    const list = await rows();
    expect(list.map((row) => row.id)).toEqual([updating.id]);
  });
});
