/**
 * 土台のレビュー (foundation-review.md) の指摘の再現テスト。偽のプロバイダと実際の PostgreSQL で、
 * 指摘の筋書きを再現し、直したあとの動きを確かめる。DATABASE_URL が無い環境では実行しない。
 * (指摘 7、12、13 は API 側、8 と 10 の manager の部分は manager.test.ts にある。)
 */
import {
  changes,
  type Database,
  events,
  listEventKeys,
  outbox,
} from "@orbit/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RETRY_AFTER_MS, processEventOutbox } from "./outbox.js";
import {
  type AccountRow,
  type CalendarRow,
  CalendarTransientError,
} from "./provider.js";
import { FakeCalendarProvider } from "./testing/fake-provider.js";
import { makeProviderContext } from "./testing/provider-contract.js";
import { syncCalendar } from "./testing/sync.js";
import {
  createTestDatabase,
  insertAccount,
  insertCalendar,
  insertUser,
  type TestDatabase,
} from "./testing/test-db.js";

const adminUrl = process.env.DATABASE_URL;
const HOUR = 60 * 60_000;

describe.skipIf(!adminUrl)("土台のレビューの指摘", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendar: CalendarRow;
  let fake: FakeCalendarProvider;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_calreview");
    db = test.db;
    userId = await insertUser(db, "calreview@example.com");
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    account = await insertAccount(db, userId, { calendarEnabled: true });
    calendar = await insertCalendar(db, userId, account.id);
    fake = new FakeCalendarProvider();
  });

  const remoteCalendarId = () => calendar.remoteId as string;
  const logs: string[] = [];
  const run = (options: { now?: () => Date; signal?: AbortSignal } = {}) =>
    processEventOutbox({
      db,
      account,
      provider: fake,
      ctx: makeProviderContext({
        account,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      log: (message) => logs.push(message),
      ...(options.now ? { now: options.now } : {}),
    });
  const sync = (calendarId = calendar.id) =>
    syncCalendar(db, fake, account, calendarId);
  const rows = (calendarId = calendar.id) =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendarId))
      // 原本 (recurrenceId が null) を先に並べる。
      .orderBy(sql`${events.recurrenceId} asc nulls first`);
  const rowOf = async (id: string) => {
    const [row] = await db.select().from(events).where(eq(events.id, id));
    return row;
  };
  const outboxRows = () =>
    db
      .select()
      .from(outbox)
      .where(eq(outbox.accountId, account.id))
      .orderBy(asc(outbox.createdAt), asc(outbox.id));
  let sequence = 0;
  const enqueue = async (
    kind: "event_create" | "event_update" | "event_delete",
    payload: Record<string, unknown>,
  ) => {
    sequence++;
    const [row] = await db
      .insert(outbox)
      .values({
        accountId: account.id,
        kind,
        payload,
        idempotencyKey: `${kind}:${crypto.randomUUID()}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)),
      })
      .returning();
    if (!row) throw new Error("outbox に積めませんでした。");
    return row;
  };
  const insertLocal = async (summary = "作った予定") => {
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(events)
      .values({
        id,
        userId,
        calendarId: calendar.id,
        uid: `${id}@orbit`,
        summary,
        startAt: new Date("2026-12-05T01:00:00Z"),
        endAt: new Date("2026-12-05T02:00:00Z"),
        fieldUpdatedAt: { summary: new Date().toISOString() },
      })
      .returning();
    if (!row) throw new Error("予定を作れませんでした。");
    return row;
  };
  const deletePayload = (row: typeof events.$inferSelect) => ({
    calendarId: row.calendarId,
    target: {
      eventId: row.id,
      calendarId: row.calendarId,
      remoteId: row.remoteId,
      etag: row.etag,
      uid: row.uid,
      recurrenceId: row.recurrenceId,
      parentRemoteId: null,
    },
    deletedAt: new Date().toISOString(),
  });

  describe("指摘 1: CalDAV 型でリソースから消えた例外", () => {
    const seedResource = () =>
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "/a.ics", uid: "u1", rrule: "FREQ=DAILY" },
        {
          remoteId: "/a.ics",
          uid: "u1",
          recurrenceId: "2026-12-02T01:00:00Z",
          summary: "例外",
          parentRemoteId: "/a.ics",
        },
      ]);
    const onlyMaster = () =>
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "/a.ics", uid: "u1", rrule: "FREQ=DAILY" },
      ]);

    it("差分同期で、リソースから消えた例外の行を消す", async () => {
      seedResource();
      await sync();
      expect(await rows()).toHaveLength(2);
      onlyMaster();
      await sync();
      const after = await rows();
      expect(after.map((row) => row.recurrenceId)).toEqual([null]);
    });

    it("全件同期でも、リソースから消えた例外の行を消す", async () => {
      seedResource();
      await sync();
      onlyMaster();
      // 差分を飛ばして全件で突き合わせる。
      fake.pageSize = 50;
      const { calendars } = await import("@orbit/db");
      await db
        .update(calendars)
        .set({ syncToken: null })
        .where(eq(calendars.id, calendar.id));
      await sync();
      expect((await rows()).map((row) => row.recurrenceId)).toEqual([null]);
    });

    it("書き戻し待ちの例外の行は残す", async () => {
      seedResource();
      await sync();
      const exception = (await rows()).find((row) => row.recurrenceId);
      if (!exception) throw new Error("例外がありません。");
      await enqueue("event_update", {
        eventId: exception.id,
        calendarId: calendar.id,
        fields: ["summary"],
      });
      onlyMaster();
      await sync();
      expect(await rowOf(exception.id)).toBeDefined();
    });
  });

  describe("指摘 2: 作成の書き戻しの冪等", () => {
    /** 相手側に届いたあと、結果を保存する前に止まった形にする。 */
    const crashAfterCreate = () => {
      const create = fake.createEvent.bind(fake);
      fake.createEvent = async (...args) => {
        await create(...args);
        fake.createEvent = create;
        throw new Error("応答を受け取る前に止まりました");
      };
    };

    it("やり直しで、相手側に二重に作らない (既にあれば ok を返すプロバイダ)", async () => {
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      crashAfterCreate();
      await expect(run()).rejects.toThrow("止まりました");
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(fake.remoteCount(remoteCalendarId())).toBe(1);
      expect((await rowOf(local.id))?.remoteId).toMatch(/^r\d+$/);
    });

    it("create の conflict (既にある) は、getEvent で取り直して ok にする", async () => {
      fake.existingCreate = "conflict";
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      crashAfterCreate();
      await expect(run()).rejects.toThrow("止まりました");
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(fake.calls.some((call) => call.method === "getEvent")).toBe(true);
      expect(fake.remoteCount(remoteCalendarId())).toBe(1);
      const row = await rowOf(local.id);
      expect(row?.remoteId).toMatch(/^r\d+$/);
      expect((await outboxRows())[0]?.status).toBe("done");
    });

    it("UID の付け替えの前に取り込みが同じ uid の行を入れていたら、こちらの行へ寄せる", async () => {
      fake.rewriteUid = (uid) => `remote-${uid}`;
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      crashAfterCreate();
      await expect(run()).rejects.toThrow("止まりました");
      // やり直す前に取り込みが走り、付け替わった uid の行が入る。
      await sync();
      const ingested = (await rows()).find((row) => row.id !== local.id);
      if (!ingested) throw new Error("取り込んだ行がありません。");
      expect(ingested.uid).toBe(`remote-${local.uid}`);
      // 取り込んだ行を利用者が変えた (その書き戻しは、こちらの行へ付け替わる)。
      const update = await enqueue("event_update", {
        eventId: ingested.id,
        calendarId: calendar.id,
        fields: ["summary"],
      });
      expect(await run()).toMatchObject({ failed: 0 });
      const after = await rows();
      expect(after.map((row) => row.id)).toEqual([local.id]);
      expect(after[0]?.uid).toBe(`remote-${local.uid}`);
      expect(after[0]?.remoteId).toBe(ingested.remoteId);
      const statuses = await outboxRows();
      expect(statuses[0]?.status).toBe("done");
      const moved = statuses.find((row) => row.id === update.id);
      expect((moved?.payload as { eventId: string }).eventId).toBe(local.id);
      expect(fake.remoteCount(remoteCalendarId())).toBe(1);
    });
  });

  describe("指摘 3: 例外の uid をプロバイダが省ける", () => {
    it("同じ応答の原本から uid を補う", async () => {
      fake.omitExceptionUid = true;
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "m", uid: "series", rrule: "FREQ=WEEKLY" },
        {
          remoteId: "m_1",
          uid: "series",
          recurrenceId: "2026-12-08T01:00:00Z",
          parentRemoteId: "m",
          summary: "この回だけ",
        },
      ]);
      await sync();
      const [master, exception] = await rows();
      expect(exception?.uid).toBe("series");
      expect(exception?.parentId).toBe(master?.id);
    });

    it("差分で例外だけが届いたら、DB の原本から uid を補う", async () => {
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "m", uid: "series", rrule: "FREQ=WEEKLY" },
      ]);
      await sync();
      fake.omitExceptionUid = true;
      fake.putRemote(remoteCalendarId(), [
        {
          remoteId: "m_1",
          uid: "series",
          recurrenceId: "2026-12-08T01:00:00Z",
          parentRemoteId: "m",
          status: "cancelled",
        },
      ]);
      await sync();
      const [master, exception] = await rows();
      expect(exception?.uid).toBe("series");
      expect(exception?.status).toBe("cancelled");
      expect(exception?.parentId).toBe(master?.id);
    });

    it("例外が原本より前のページに出ても、最後まで持ち越して補う", async () => {
      fake.omitExceptionUid = true;
      fake.pageSize = 1;
      // 偽のプロバイダは remoteId の順に返すので、例外 (a) が原本 (b) より先のページになる。
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "b", uid: "series", rrule: "FREQ=WEEKLY" },
        {
          remoteId: "a",
          uid: "series",
          recurrenceId: "2026-12-08T01:00:00Z",
          parentRemoteId: "b",
        },
      ]);
      await sync();
      const [master, exception] = await rows();
      expect(exception?.uid).toBe("series");
      expect(exception?.parentId).toBe(master?.id);
    });

    it("cursor.knownEvents() は remoteId → uid と etag を返す", async () => {
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "m", uid: "series", rrule: "FREQ=WEEKLY" },
      ]);
      await sync();
      const known = await listEventKeys(db, calendar.id);
      expect(known.get("m")?.uid).toBe("series");
      expect(known.get("m")?.etag).toMatch(/^e\d+$/);
    });
  });

  describe("指摘 4: 書き戻し待ちの guard はカレンダー単位", () => {
    it("削除待ちの uid が、別のカレンダーの同じ uid の取り込みを止めない", async () => {
      const other = await insertCalendar(db, userId, account.id);
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "evA", uid: "shared-uid", summary: "A" },
      ]);
      fake.putRemote(other.remoteId as string, [
        { remoteId: "evB", uid: "shared-uid", summary: "B" },
      ]);
      await sync();
      await sync(other.id);
      const [a] = await rows();
      if (!a) throw new Error("予定がありません。");
      await db.delete(events).where(eq(events.id, a.id));
      await enqueue("event_delete", deletePayload(a));
      fake.putRemote(other.remoteId as string, [
        { remoteId: "evB", uid: "shared-uid", summary: "B 変更後" },
      ]);
      await sync(other.id);
      expect((await rows(other.id)).map((row) => row.summary)).toEqual([
        "B 変更後",
      ]);
    });

    it("削除待ちの remoteId が、別のカレンダーの同じ remoteId の削除を止めない", async () => {
      const other = await insertCalendar(db, userId, account.id);
      fake.putRemote(remoteCalendarId(), [{ remoteId: "same", uid: "x" }]);
      fake.putRemote(other.remoteId as string, [
        { remoteId: "same", uid: "x" },
      ]);
      await sync();
      await sync(other.id);
      const [a] = await rows();
      if (!a) throw new Error("予定がありません。");
      await db.delete(events).where(eq(events.id, a.id));
      await enqueue("event_delete", deletePayload(a));
      fake.removeRemote(other.remoteId as string, "same");
      await sync(other.id);
      expect(await rows(other.id)).toHaveLength(0);
    });
  });

  describe("指摘 5: 一時的な失敗は回数で確定失敗にしない", () => {
    it("CalendarTransientError は回数に数えず、retryAfter まで待つ (後続も待つ)", async () => {
      const first = await insertLocal("1 件目");
      const second = await insertLocal("2 件目");
      await enqueue("event_create", {
        eventId: first.id,
        calendarId: calendar.id,
      });
      await enqueue("event_create", {
        eventId: second.id,
        calendarId: calendar.id,
      });
      fake.enqueue(
        "createEvent",
        new CalendarTransientError("429 Too Many Requests", {
          retryAfterMs: 60_000,
        }),
      );
      const start = Date.now();
      const result = await run();
      expect(result).toMatchObject({ done: 0, failed: 0 });
      expect(result.retryAt?.getTime()).toBeGreaterThanOrEqual(start + 60_000);
      const [a, b] = await outboxRows();
      expect(a?.status).toBe("pending");
      expect(a?.attempts).toBe(0);
      expect(b?.attempts).toBe(0);
      // 待ちの間は、通知で起こされても実行しない。
      const calls = fake.calls.length;
      expect(await run()).toMatchObject({ done: 0, failed: 0 });
      expect(fake.calls.length).toBe(calls);
      // 時刻が来たら、順番どおりに実行する。
      const later = () => new Date(Date.now() + 61_000);
      expect(await run({ now: later })).toMatchObject({ done: 2, failed: 0 });
    });

    it("待つ時間が無い CalendarTransientError は既定の時間だけ待つ", async () => {
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      fake.enqueue("createEvent", new CalendarTransientError("503"));
      const start = Date.now();
      const result = await run();
      expect(result.retryAt?.getTime()).toBeGreaterThanOrEqual(
        start + DEFAULT_RETRY_AFTER_MS,
      );
    });

    it("ふつうの例外が 5 回を超えて続いても、6 時間たつまでは失敗にしない", async () => {
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      for (let index = 0; index < 7; index++) {
        fake.enqueue("createEvent", new Error("503 Service Unavailable"));
        await expect(run()).rejects.toThrow("503");
      }
      const [row] = await outboxRows();
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(7);
      expect(row?.firstFailedAt).not.toBeNull();
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
    });

    it("最初の一時的な失敗から 6 時間たつと、確定した失敗にする", async () => {
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      fake.enqueue("createEvent", new Error("503 Service Unavailable"));
      await expect(run()).rejects.toThrow("503");
      fake.enqueue("createEvent", new Error("503 Service Unavailable"));
      const later = () => new Date(Date.now() + 6 * HOUR + 1_000);
      expect(await run({ now: later })).toMatchObject({ done: 0, failed: 1 });
      expect((await outboxRows())[0]?.status).toBe("failed");
    });
  });

  describe("指摘 6: まだ相手側に無い例外の変更の確定失敗", () => {
    it("例外の行を消し、変更履歴に載せる", async () => {
      fake.putRemote(remoteCalendarId(), [
        { remoteId: "m", uid: "um", rrule: "FREQ=DAILY", summary: "原本" },
      ]);
      await sync();
      const [master] = await rows();
      const id = crypto.randomUUID();
      await db.insert(events).values({
        id,
        userId,
        calendarId: calendar.id,
        uid: "um",
        recurrenceId: "2026-12-03T01:00:00Z",
        parentId: master?.id,
        summary: "この回だけ変更",
        startAt: new Date("2026-12-03T03:00:00Z"),
        endAt: new Date("2026-12-03T04:00:00Z"),
        fieldUpdatedAt: { summary: new Date().toISOString() },
      });
      await enqueue("event_update", {
        eventId: id,
        calendarId: calendar.id,
        fields: ["summary", "time"],
      });
      fake.enqueue("updateEvent", { status: "rejected", reason: "だめ" });
      expect(await run()).toMatchObject({ done: 0, failed: 1 });
      expect(await rowOf(id)).toBeUndefined();
      await sync();
      expect((await rows()).map((row) => row.recurrenceId)).toEqual([null]);
      const notices = await db
        .select()
        .from(changes)
        .where(
          and(
            eq(changes.entity, "event"),
            eq(changes.entityId, id),
            eq(changes.op, "delete"),
          ),
        );
      expect(notices.length).toBeGreaterThan(0);
    });
  });

  describe("指摘 8: 書き戻しのループの停止と、行の取り方", () => {
    it("停止を求められていたら、次の行を始めない", async () => {
      const local = await insertLocal();
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      const controller = new AbortController();
      controller.abort();
      expect(await run({ signal: controller.signal })).toMatchObject({
        done: 0,
        failed: 0,
      });
      expect(fake.calls).toHaveLength(0);
      const [row] = await outboxRows();
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(0);
    });

    it("ほかの同期が先に終えた行は、もう一度実行しない", async () => {
      const first = await insertLocal("1 件目");
      const second = await insertLocal("2 件目");
      await enqueue("event_create", {
        eventId: first.id,
        calendarId: calendar.id,
      });
      const later = await enqueue("event_create", {
        eventId: second.id,
        calendarId: calendar.id,
      });
      const create = fake.createEvent.bind(fake);
      fake.createEvent = async (...args) => {
        // 1 件目の実行中に、ほかの同期が 2 件目を終えた。
        await db
          .update(outbox)
          .set({ status: "done" })
          .where(eq(outbox.id, later.id));
        return create(...args);
      };
      expect(await run()).toMatchObject({ done: 1 });
      expect(
        fake.calls
          .filter((call) => call.method === "createEvent")
          .map((call) => call.write?.event.summary),
      ).toEqual(["1 件目"]);
    });
  });

  describe("指摘 9: gone の判定は lastSyncedAt に頼らない", () => {
    it("取り込みが先に走っても、相手側の削除より後のローカルの変更は作り直す", async () => {
      fake.putRemote(remoteCalendarId(), [
        {
          remoteId: "ev",
          summary: "元",
          remoteUpdatedAt: new Date(Date.now() - HOUR).toISOString(),
        },
      ]);
      await sync();
      const [row] = await rows();
      if (!row) throw new Error("予定がありません。");
      fake.removeRemote(remoteCalendarId(), "ev");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await db
        .update(events)
        .set({
          summary: "あとから変更",
          fieldUpdatedAt: { summary: new Date().toISOString() },
        })
        .where(eq(events.id, row.id));
      await enqueue("event_update", {
        eventId: row.id,
        calendarId: calendar.id,
        fields: ["summary"],
      });
      // 取り込みが先に走る (書き戻し待ちなので消さず、印を付ける)。
      await sync();
      const kept = await rowOf(row.id);
      expect(kept?.remoteDeletedAfter).not.toBeNull();
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      const after = await rowOf(row.id);
      expect(after).toBeDefined();
      expect(after?.remoteId).not.toBe("ev");
      expect(after?.remoteDeletedAfter).toBeNull();
      expect(fake.remoteCount(remoteCalendarId())).toBe(1);
    });

    it("印が付いていても、相手側の削除より前の変更ならローカルを消す", async () => {
      fake.putRemote(remoteCalendarId(), [{ remoteId: "ev", summary: "元" }]);
      await sync();
      const [row] = await rows();
      if (!row) throw new Error("予定がありません。");
      await db
        .update(events)
        .set({
          summary: "古い変更",
          fieldUpdatedAt: { summary: "2020-01-01T00:00:00.000Z" },
        })
        .where(eq(events.id, row.id));
      await enqueue("event_update", {
        eventId: row.id,
        calendarId: calendar.id,
        fields: ["summary"],
      });
      fake.removeRemote(remoteCalendarId(), "ev");
      await sync();
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(await rowOf(row.id)).toBeUndefined();
    });
  });

  describe("指摘 11: conflict の解決中に API で消された予定", () => {
    it("取り直した内容を書いても、消した予定をよみがえらせない", async () => {
      fake.putRemote(remoteCalendarId(), [
        {
          remoteId: "ev",
          summary: "元",
          remoteUpdatedAt: new Date(Date.now() - HOUR).toISOString(),
        },
      ]);
      await sync();
      const [row] = await rows();
      if (!row) throw new Error("予定がありません。");
      await db
        .update(events)
        .set({
          summary: "ローカル",
          fieldUpdatedAt: { summary: new Date().toISOString() },
        })
        .where(eq(events.id, row.id));
      await enqueue("event_update", {
        eventId: row.id,
        calendarId: calendar.id,
        fields: ["summary"],
      });
      // 相手側が先に変わる → conflict。
      fake.putRemote(remoteCalendarId(), [
        {
          remoteId: "ev",
          summary: "元",
          location: "相手が場所を変更",
          remoteUpdatedAt: new Date(Date.now() - HOUR / 2).toISOString(),
        },
      ]);
      const getEvent = fake.getEvent.bind(fake);
      fake.getEvent = async (...args) => {
        // 取り直している間に、API が予定を消した。
        await db.delete(events).where(eq(events.id, row.id));
        await enqueue("event_delete", deletePayload(row));
        fake.getEvent = getEvent;
        return getEvent(...args);
      };
      await run();
      expect(await rows()).toHaveLength(0);
    });
  });
});
