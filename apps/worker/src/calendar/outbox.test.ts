/**
 * 予定の書き戻し (processEventOutbox) を、偽のプロバイダと実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import { calendars, changes, type Database, events, outbox } from "@orbit/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processEventOutbox } from "./outbox.js";
import type { AccountRow, CalendarRow } from "./provider.js";
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

describe.skipIf(!adminUrl)("予定の書き戻し", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;
  let account: AccountRow;
  let calendar: CalendarRow;
  let fake: FakeCalendarProvider;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_eventoutbox");
    db = test.db;
    userId = await insertUser(db, "eventoutbox@example.com");
  });

  afterAll(async () => {
    await test?.drop();
  });

  beforeEach(async () => {
    // 行の順番 (createdAt) が他のテストと混ざらないよう、テストごとにアカウントを分ける。
    account = await insertAccount(db, userId, { calendarEnabled: true });
    calendar = await insertCalendar(db, userId, account.id);
    fake = new FakeCalendarProvider();
  });

  const remoteId = () => calendar.remoteId as string;
  const logs: string[] = [];
  const run = () =>
    processEventOutbox({
      db,
      account,
      provider: fake,
      ctx: makeProviderContext({ account }),
      log: (message) => logs.push(message),
    });
  const sync = () => syncCalendar(db, fake, account, calendar.id);
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
    // createdAt の順番を確実にする。
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
  /** 相手側に予定を置いて取り込み、その行を返す。 */
  const syncedEvent = async (seed: { summary?: string; location?: string }) => {
    fake.putRemote(remoteId(), [
      {
        remoteId: "ev",
        summary: seed.summary ?? "元の題",
        location: seed.location ?? "元の場所",
        remoteUpdatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]);
    await sync();
    const [row] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.calendarId, calendar.id), eq(events.remoteId, "ev")),
      );
    if (!row) throw new Error("予定がありません。");
    return row;
  };
  /** ローカルで題を変え、書き戻しを積む (API の PATCH と同じ形)。 */
  const editSummary = async (eventId: string, summary: string) => {
    await db
      .update(events)
      .set({
        summary,
        fieldUpdatedAt: { summary: new Date().toISOString() },
      })
      .where(eq(events.id, eventId));
    return enqueue("event_update", {
      eventId,
      calendarId: calendar.id,
      fields: ["summary"],
    });
  };

  it("作成を書き戻すと、行に remoteId と etag と raw が付く", async () => {
    const local = await insertLocal();
    await enqueue("event_create", {
      eventId: local.id,
      calendarId: calendar.id,
    });
    expect(await run()).toEqual({ done: 1, failed: 0 });
    const row = await rowOf(local.id);
    expect(row?.remoteId).toMatch(/^r\d+$/);
    expect(row?.etag).not.toBeNull();
    expect(row?.raw).toContain("作った予定");
    expect(fake.remote(remoteId(), row?.remoteId as string)?.[0]?.summary).toBe(
      "作った予定",
    );
    expect((await outboxRows())[0]?.status).toBe("done");
    // もう一度実行しても、作り直さない。
    await run();
    expect(fake.remoteCount(remoteId())).toBe(1);
  });

  it("相手側が UID を付け替えても、同じ行に remoteId が付く", async () => {
    fake.rewriteUid = (uid) => `remote-${uid}`;
    const local = await insertLocal();
    await enqueue("event_create", {
      eventId: local.id,
      calendarId: calendar.id,
    });
    await run();
    const row = await rowOf(local.id);
    expect(row?.uid).toBe(`remote-${local.uid}`);
    expect(row?.remoteId).not.toBeNull();
  });

  it("競合したら取り直してマージし、ローカルで勝った項目だけを送り直す", async () => {
    const row = await syncedEvent({});
    await editSummary(row.id, "ローカルの題");
    // 相手側で場所が変わった (etag が変わる)。
    fake.putRemote(remoteId(), [
      {
        remoteId: "ev",
        summary: "元の題",
        location: "相手側の場所",
        remoteUpdatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ]);
    expect(await run()).toEqual({ done: 1, failed: 0 });
    const updates = fake.calls.filter((call) => call.method === "updateEvent");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.write?.fields).toEqual(["summary"]);
    const remote = fake.remote(remoteId(), "ev")?.[0];
    expect(remote?.summary).toBe("ローカルの題");
    expect(remote?.location).toBe("相手側の場所");
    const after = await rowOf(row.id);
    expect(after?.summary).toBe("ローカルの題");
    expect(after?.location).toBe("相手側の場所");
    expect(after?.etag).toBe(remote?.etag);
  });

  it("3 回続けて競合したら打ち切り、失敗にして相手側の内容に戻す", async () => {
    const row = await syncedEvent({});
    await editSummary(row.id, "ローカルの題");
    fake.enqueue(
      "updateEvent",
      { status: "conflict" },
      { status: "conflict" },
      { status: "conflict" },
    );
    expect(await run()).toEqual({ done: 0, failed: 1 });
    expect(
      fake.calls.filter((call) => call.method === "updateEvent"),
    ).toHaveLength(3);
    const [failed] = await outboxRows();
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toContain("3 回");
    expect((await rowOf(row.id))?.summary).toBe("元の題");
    const notices = await db
      .select()
      .from(changes)
      .where(
        and(eq(changes.entity, "calendar"), eq(changes.entityId, calendar.id)),
      );
    expect(notices.length).toBeGreaterThan(0);
  });

  it("相手側で消えていて、ローカルの変更の方が新しければ作り直す", async () => {
    const row = await syncedEvent({});
    fake.removeRemote(remoteId(), "ev");
    await editSummary(row.id, "消された後の変更");
    await run();
    const after = await rowOf(row.id);
    expect(after?.remoteId).not.toBe("ev");
    expect(after?.remoteId).not.toBeNull();
    expect(fake.calls.some((call) => call.method === "createEvent")).toBe(true);
  });

  it("相手側で消えていて、ローカルの変更の方が古ければローカルを消す", async () => {
    const row = await syncedEvent({});
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
    fake.removeRemote(remoteId(), "ev");
    expect(await run()).toEqual({ done: 1, failed: 0 });
    expect(await rowOf(row.id)).toBeUndefined();
  });

  it("一時的な失敗では止まり、順番を保って次の周回でやり直す", async () => {
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
    fake.enqueue("createEvent", new Error("接続が切れました"));
    await expect(run()).rejects.toThrow("接続が切れました");
    const [a, b] = await outboxRows();
    expect(a?.status).toBe("pending");
    expect(a?.attempts).toBe(1);
    expect(b?.attempts).toBe(0);
    expect(await run()).toEqual({ done: 2, failed: 0 });
    const created = fake.calls
      .filter((call) => call.method === "createEvent")
      .map((call) => call.write?.event.summary);
    expect(created).toEqual(["1 件目", "1 件目", "2 件目"]);
  });

  it("削除を書き戻す。消えた予定を指す変更は飛ばして done にする", async () => {
    const row = await syncedEvent({});
    await db.delete(events).where(eq(events.id, row.id));
    await enqueue("event_update", {
      eventId: row.id,
      calendarId: calendar.id,
      fields: ["summary"],
    });
    await enqueue("event_delete", {
      calendarId: calendar.id,
      target: {
        eventId: row.id,
        calendarId: calendar.id,
        remoteId: "ev",
        etag: row.etag,
        uid: row.uid,
        recurrenceId: null,
        parentRemoteId: null,
      },
      deletedAt: new Date().toISOString(),
    });
    expect(await run()).toEqual({ done: 2, failed: 0 });
    expect(fake.remote(remoteId(), "ev")).toBeNull();
    expect(fake.calls.some((call) => call.method === "updateEvent")).toBe(
      false,
    );
  });

  it("作成の実行中に消された予定は、作成の結果を使って相手側からも消す (行は戻さない)", async () => {
    const local = await insertLocal();
    await enqueue("event_create", {
      eventId: local.id,
      calendarId: calendar.id,
    });
    const create = fake.createEvent.bind(fake);
    fake.createEvent = async (...args) => {
      const result = await create(...args);
      // 相手側に作っている間に、API が行を消して削除を積んだ (remoteId はまだ null)。
      await db.delete(events).where(eq(events.id, local.id));
      await enqueue("event_delete", {
        calendarId: calendar.id,
        target: {
          eventId: local.id,
          calendarId: calendar.id,
          remoteId: null,
          etag: null,
          uid: local.uid,
          recurrenceId: null,
          parentRemoteId: null,
        },
        deletedAt: new Date().toISOString(),
      });
      return result;
    };
    await run();
    await run();
    expect(fake.remoteCount(remoteId())).toBe(0);
    expect(await rowOf(local.id)).toBeUndefined();
    expect((await outboxRows()).map((row) => row.status)).toEqual([
      "done",
      "done",
    ]);
  });

  it("確定した失敗で、相手側を取り直せなければ同期の位置を消して全件で突き合わせる", async () => {
    const row = await syncedEvent({});
    await editSummary(row.id, "ローカルの題");
    fake.enqueue("updateEvent", { status: "rejected", reason: "拒否された" });
    fake.enqueue("getEvent", new Error("取り直せない"));
    expect(await run()).toEqual({ done: 0, failed: 1 });
    const [after] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendar.id));
    expect(after?.syncToken).toBeNull();
    // 次の全件同期で、相手側の内容に戻る。
    await sync();
    expect((await rowOf(row.id))?.summary).toBe("元の題");
  });
});
