/**
 * 予定の書き戻し (processEventOutbox) を、偽のプロバイダと実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import {
  calendars,
  changes,
  type Database,
  eventAttendees,
  eventConflicts,
  events,
  outbox,
} from "@orbit/db";
import { and, asc, eq, gt } from "drizzle-orm";
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
    kind: "event_create" | "event_update" | "event_delete" | "event_respond",
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
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
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
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
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
    expect(await run()).toMatchObject({ done: 0, failed: 1 });
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
    expect(await run()).toMatchObject({ done: 1, failed: 0 });
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
    expect(await run()).toMatchObject({ done: 2, failed: 0 });
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
    expect(await run()).toMatchObject({ done: 2, failed: 0 });
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
    expect(await run()).toMatchObject({ done: 0, failed: 1 });
    const [after] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendar.id));
    expect(after?.syncToken).toBeNull();
    // 次の全件同期で、相手側の内容に戻る。
    await sync();
    expect((await rowOf(row.id))?.summary).toBe("元の題");
  });
  describe("反映されなかった変更の記録 (event_conflicts)", () => {
    const conflictsOf = (eventId: string) =>
      db
        .select()
        .from(eventConflicts)
        .where(eq(eventConflicts.eventId, eventId));
    /** いまの最後の変更番号より後に、このカレンダーの変更が載ったか。 */
    const lastSeq = async () => {
      const rows = await db
        .select({ seq: changes.seq })
        .from(changes)
        .orderBy(asc(changes.seq));
      return rows.at(-1)?.seq ?? 0n;
    };
    const calendarNoticedAfter = async (seq: bigint) => {
      const rows = await db
        .select()
        .from(changes)
        .where(
          and(
            eq(changes.entity, "calendar"),
            eq(changes.entityId, calendar.id),
            gt(changes.seq, seq),
          ),
        );
      return rows.length > 0;
    };

    it("field_lost: 412 の統合で負けた項目と、負けた値を記録する", async () => {
      const row = await syncedEvent({});
      await db
        .update(events)
        .set({
          summary: "ローカルの題",
          fieldUpdatedAt: {
            summary: new Date(Date.now() - 10 * 60_000).toISOString(),
          },
        })
        .where(eq(events.id, row.id));
      await enqueue("event_update", {
        eventId: row.id,
        calendarId: calendar.id,
        fields: ["summary"],
      });
      // 相手側でも、ローカルより後に題が変わっていた。
      fake.putRemote(remoteId(), [
        {
          remoteId: "ev",
          summary: "相手側の新しい題",
          location: "元の場所",
          remoteUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ]);
      fake.enqueue("updateEvent", { status: "conflict" });
      const seq = await lastSeq();
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect((await rowOf(row.id))?.summary).toBe("相手側の新しい題");
      expect(await conflictsOf(row.id)).toEqual([
        expect.objectContaining({
          kind: "field_lost",
          calendarId: calendar.id,
          fields: ["summary"],
          lost: { summary: "ローカルの題" },
          title: "ローカルの題",
          snapshot: null,
        }),
      ]);
      expect(await calendarNoticedAfter(seq)).toBe(true);
    });

    it("write_failed: 断られた変更を、巻き戻す前の値で記録する", async () => {
      const row = await syncedEvent({});
      await editSummary(row.id, "ローカルの題");
      fake.enqueue("updateEvent", {
        status: "rejected",
        reason: "拒否された",
      });
      expect(await run()).toMatchObject({ done: 0, failed: 1 });
      expect((await rowOf(row.id))?.summary).toBe("元の題");
      expect(await conflictsOf(row.id)).toEqual([
        expect.objectContaining({
          kind: "write_failed",
          fields: ["summary"],
          lost: { summary: "ローカルの題" },
          title: "ローカルの題",
          reason: "拒否された",
        }),
      ]);
    });

    it("create_failed: 作成が確定して失敗したら記録し、行は残す", async () => {
      const local = await insertLocal("作れない予定");
      await enqueue("event_create", {
        eventId: local.id,
        calendarId: calendar.id,
      });
      fake.enqueue("createEvent", {
        status: "rejected",
        reason: "書き込めません",
      });
      expect(await run()).toMatchObject({ done: 0, failed: 1 });
      expect(await rowOf(local.id)).toBeDefined();
      expect(await conflictsOf(local.id)).toEqual([
        expect.objectContaining({
          kind: "create_failed",
          fields: [],
          lost: null,
          title: "作れない予定",
          reason: "書き込めません",
        }),
      ]);
    });

    it("remote_deleted: 相手側で消えていたので消した予定を、snapshot に控える", async () => {
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
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(await rowOf(row.id)).toBeUndefined();
      const [conflict] = await conflictsOf(row.id);
      expect(conflict).toMatchObject({
        kind: "remote_deleted",
        fields: ["summary"],
        lost: { summary: "古い変更" },
        title: "古い変更",
      });
      expect(conflict?.snapshot).toMatchObject({
        summary: "古い変更",
        location: "元の場所",
        parentId: null,
        recurrenceId: null,
        time: { allDay: false },
      });
    });

    it("delete_cancelled: 消した後に相手側で変わっていたので戻した予定を記録する", async () => {
      const row = await syncedEvent({});
      // API が行を消して削除を積んだ (消したのは 10 分前)。
      await db.delete(events).where(eq(events.id, row.id));
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
        deletedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      // その後、相手側で変えられていた。
      fake.putRemote(remoteId(), [
        {
          remoteId: "ev",
          summary: "相手側で変えた題",
          location: "元の場所",
          remoteUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ]);
      fake.enqueue("deleteEvent", { status: "conflict" });
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      const [restored] = await db
        .select()
        .from(events)
        .where(
          and(eq(events.calendarId, calendar.id), eq(events.remoteId, "ev")),
        );
      expect(restored?.summary).toBe("相手側で変えた題");
      expect(await conflictsOf(restored?.id as string)).toEqual([
        expect.objectContaining({
          kind: "delete_cancelled",
          fields: [],
          title: "相手側で変えた題",
        }),
      ]);
    });

    it("write_failed (削除): 断られた削除は、戻した予定の ID で記録する", async () => {
      const row = await syncedEvent({});
      await db.delete(events).where(eq(events.id, row.id));
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
      fake.enqueue("deleteEvent", {
        status: "rejected",
        reason: "消せません",
      });
      expect(await run()).toMatchObject({ done: 0, failed: 1 });
      const [restored] = await db
        .select()
        .from(events)
        .where(
          and(eq(events.calendarId, calendar.id), eq(events.remoteId, "ev")),
        );
      expect(restored).toBeDefined();
      expect(await conflictsOf(restored?.id as string)).toEqual([
        expect.objectContaining({
          kind: "write_failed",
          fields: [],
          lost: null,
          title: "元の題",
          reason: "消せません",
        }),
      ]);
    });

    it("30 日より古い記録は、書き戻しの掃除と同じ時機に消す", async () => {
      const old = crypto.randomUUID();
      const recent = crypto.randomUUID();
      await db.insert(eventConflicts).values([
        {
          userId,
          calendarId: calendar.id,
          eventId: old,
          kind: "field_lost",
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000),
        },
        {
          userId,
          calendarId: calendar.id,
          eventId: recent,
          kind: "field_lost",
          createdAt: new Date(Date.now() - 29 * 24 * 60 * 60_000),
        },
      ]);
      await run();
      expect(await conflictsOf(old)).toEqual([]);
      expect(await conflictsOf(recent)).toHaveLength(1);
    });
  });

  describe("出欠の返事 (event_respond)", () => {
    const attendee = (
      email: string,
      self: boolean,
      status: "needs_action" | "accepted" = "needs_action",
    ) => ({ email, name: null, role: "required" as const, status, self });
    /** 招待された予定を相手側に置いて取り込む。 */
    const invited = async () => {
      fake.putRemote(remoteId(), [
        {
          remoteId: "inv",
          summary: "招待",
          organizer: { email: "boss@example.com", self: false },
          attendees: [
            attendee("boss@example.com", false, "accepted"),
            attendee("me@example.com", true),
          ],
          remoteUpdatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
      ]);
      await sync();
      const [row] = await db
        .select()
        .from(events)
        .where(
          and(eq(events.calendarId, calendar.id), eq(events.remoteId, "inv")),
        );
      if (!row) throw new Error("予定がありません。");
      return row;
    };
    /** API の返事と同じに、自分の行を変えて積む。 */
    const respond = async (
      row: typeof events.$inferSelect,
      status: "accepted" | "declined",
    ) => {
      await db
        .update(eventAttendees)
        .set({ status })
        .where(
          and(
            eq(eventAttendees.eventId, row.id),
            eq(eventAttendees.self, true),
          ),
        );
      return enqueue("event_respond", {
        eventId: row.id,
        calendarId: calendar.id,
        status,
        comment: null,
        target: {
          eventId: row.id,
          calendarId: calendar.id,
          remoteId: row.remoteId,
          etag: row.etag,
          uid: row.uid,
          recurrenceId: null,
          parentRemoteId: null,
        },
      });
    };
    const myStatus = async (eventId: string) => {
      const [mine] = await db
        .select({ status: eventAttendees.status })
        .from(eventAttendees)
        .where(
          and(
            eq(eventAttendees.eventId, eventId),
            eq(eventAttendees.self, true),
          ),
        );
      return mine?.status;
    };
    const remoteStatus = () =>
      fake.remote(remoteId(), "inv")?.[0]?.attendees.find((item) => item.self)
        ?.status;

    it("返事を書き戻し、自分の行だけが変わる", async () => {
      const row = await invited();
      await respond(row, "accepted");
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(remoteStatus()).toBe("accepted");
      expect(await myStatus(row.id)).toBe("accepted");
      const after = await rowOf(row.id);
      expect(after?.etag).not.toBe(row.etag);
      const boss = await db
        .select({ status: eventAttendees.status })
        .from(eventAttendees)
        .where(
          and(
            eq(eventAttendees.eventId, row.id),
            eq(eventAttendees.email, "boss@example.com"),
          ),
        );
      expect(boss).toEqual([{ status: "accepted" }]);
    });

    it("競合したら新しい etag でやり直す", async () => {
      const row = await invited();
      await respond(row, "accepted");
      fake.enqueue("respond", { status: "conflict" });
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(
        fake.calls.filter((call) => call.method === "respond"),
      ).toHaveLength(2);
      expect(remoteStatus()).toBe("accepted");
    });

    it("確定した失敗は相手側の出欠に戻し、lost の無い記録を残す", async () => {
      const row = await invited();
      await respond(row, "accepted");
      fake.enqueue("respond", { status: "rejected", reason: "返事できません" });
      expect(await run()).toMatchObject({ done: 0, failed: 1 });
      expect(await myStatus(row.id)).toBe("needs_action");
      const recorded = await db
        .select()
        .from(eventConflicts)
        .where(eq(eventConflicts.eventId, row.id));
      expect(recorded).toEqual([
        expect.objectContaining({
          kind: "write_failed",
          fields: ["attendees"],
          lost: null,
          title: "招待",
          reason: "出欠の返事を送れませんでした: 返事できません",
        }),
      ]);
    });

    it("不参加で返事をして削除: 行が消えていても返事を届け、続く削除は新しい etag で消す", async () => {
      const row = await invited();
      await respond(row, "declined");
      // API の削除と同じに、行を消して削除を積む (古い etag のまま)。
      await db.delete(events).where(eq(events.id, row.id));
      await enqueue("event_delete", {
        calendarId: calendar.id,
        target: {
          eventId: row.id,
          calendarId: calendar.id,
          remoteId: "inv",
          etag: row.etag,
          uid: row.uid,
          recurrenceId: null,
          parentRemoteId: null,
        },
        deletedAt: new Date().toISOString(),
      });
      expect(await run()).toMatchObject({ done: 2, failed: 0 });
      const responded = fake.calls.find((call) => call.method === "respond");
      expect(responded?.ref?.remoteId).toBe("inv");
      const deleted = fake.calls.filter(
        (call) => call.method === "deleteEvent",
      );
      // 返事で変わった etag で、1 回で消せる (取りやめにならない)。
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.ref?.etag).not.toBe(row.etag);
      expect(fake.remote(remoteId(), "inv")).toBeNull();
      expect(
        await db
          .select()
          .from(eventConflicts)
          .where(eq(eventConflicts.eventId, row.id)),
      ).toEqual([]);
    });

    it("行が無く target も無い古い返事は、何もせず done にする", async () => {
      await enqueue("event_respond", {
        eventId: crypto.randomUUID(),
        calendarId: calendar.id,
        status: "accepted",
        comment: null,
      });
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(fake.calls.some((call) => call.method === "respond")).toBe(false);
    });
  });
});
