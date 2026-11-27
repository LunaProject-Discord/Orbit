/**
 * カレンダーの差分同期の DB 関数 (@orbit/db の calendar-store) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  accounts,
  calendars,
  createDb,
  type Database,
  deleteCalendarEventsByRemoteId,
  deleteCalendarEventsNotIn,
  eventAttendees,
  events,
  findCalendarEvents,
  listEventEtags,
  type RemoteEventInput,
  replaceCalendarEvents,
  upsertAccountCalendars,
  upsertCalendarEvents,
  users,
} from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const adminUrl = process.env.DATABASE_URL;

/** 予定 1 行分の入力。指定しない項目は既定の値にする。 */
function remoteEvent(
  overrides: Partial<RemoteEventInput> & { uid: string; remoteId: string },
): RemoteEventInput {
  return {
    recurrenceId: null,
    summary: "予定",
    location: null,
    description: null,
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: "2026-12-01T01:00:00.000Z",
    endAt: "2026-12-01T02:00:00.000Z",
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    endTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: null,
    exdates: null,
    organizer: null,
    attendees: [],
    sequence: 0,
    conferenceUrl: null,
    remoteUpdatedAt: null,
    reminders: null,
    raw: `raw:${overrides.uid}:${overrides.recurrenceId ?? ""}:${overrides.summary ?? "予定"}`,
    etag: "1",
    ...overrides,
  };
}

describe.skipIf(!adminUrl)("カレンダーの差分同期の DB 関数", () => {
  const dbName = `mail_calstore_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let userId: string;
  let accountId: string;
  let calendarId: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    ({ db, pool } = createDb(url.toString()));
    // PostgreSQL 16 には uuidv7 が無いので、代わりの関数を作る。
    await db.execute(sql`do $$ begin
      if to_regproc('uuidv7') is null then
        create function uuidv7() returns uuid language sql volatile
          as 'select gen_random_uuid()';
      end if;
    end $$`);
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../packages/db/drizzle", import.meta.url),
      ),
    });
    const [user] = await db
      .insert(users)
      .values({ email: "calstore@example.com", name: "calstore" })
      .returning({ id: users.id });
    userId = user?.id as string;
    const [account] = await db
      .insert(accounts)
      .values({
        userId,
        email: "calstore@example.com",
        provider: "gmail",
        authType: "oauth2",
        username: "calstore@example.com",
        credentialsEncrypted: "x",
      })
      .returning({ id: accounts.id });
    accountId = account?.id as string;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists ${dbName}`);
    await admin?.end();
  });

  beforeEach(async () => {
    const [calendar] = await db
      .insert(calendars)
      .values({ userId, source: "local", name: "テスト" })
      .returning({ id: calendars.id });
    calendarId = calendar?.id as string;
  });

  const upsert = (inputs: RemoteEventInput[]) =>
    db.transaction((tx) =>
      upsertCalendarEvents(tx, { userId, calendarId }, inputs),
    );

  const rows = () =>
    db
      .select()
      .from(events)
      .where(eq(events.calendarId, calendarId))
      .orderBy(events.uid, events.recurrenceId);

  it("差分を upsert し、入力に無い行は消さない。etag と raw が同じなら触らない", async () => {
    const first = await upsert([
      remoteEvent({
        uid: "a",
        remoteId: "ra",
        attendees: [
          {
            email: "me@example.com",
            name: null,
            role: "required",
            status: "accepted",
            self: true,
          },
          {
            email: "you@example.com",
            name: "あなた",
            role: "optional",
            status: "needs_action",
          },
        ],
        reminders: [{ method: "display", minutes: 10 }],
        fieldUpdatedAt: { summary: "2026-11-01T00:00:00.000Z" },
      }),
      remoteEvent({ uid: "b", remoteId: "rb" }),
    ]);
    expect(first.upserted).toHaveLength(2);
    expect(first.deleted).toEqual([]);

    const [a] = await db.select().from(events).where(eq(events.uid, "a"));
    expect(a).toMatchObject({
      remoteId: "ra",
      etag: "1",
      useDefaultReminders: false,
      fieldUpdatedAt: { summary: "2026-11-01T00:00:00.000Z" },
    });
    const attendees = await db
      .select({ email: eventAttendees.email, self: eventAttendees.self })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, a?.id as string))
      .orderBy(eventAttendees.email);
    expect(attendees).toEqual([
      { email: "me@example.com", self: true },
      { email: "you@example.com", self: false },
    ]);

    // 同じ内容をもう一度: 何も変えない。
    const same = await upsert([remoteEvent({ uid: "a", remoteId: "ra" })]);
    expect(same.upserted).toEqual([]);

    // b だけ変わった差分: b を更新し、a は残す。fieldUpdatedAt を省けば既存の値を保つ。
    const changed = await upsert([
      remoteEvent({ uid: "b", remoteId: "rb", summary: "変更", etag: "2" }),
    ]);
    const all = await rows();
    const b = all.find((row) => row.uid === "b");
    expect(changed.upserted).toEqual([b?.id]);
    expect(all.map((row) => [row.uid, row.summary, row.etag])).toEqual([
      ["a", "予定", "1"],
      ["b", "変更", "2"],
    ]);

    // etag だけ変わっても更新する。fieldUpdatedAt を省いた更新では既存の値を保つ。
    const etagOnly = await upsert([
      remoteEvent({
        uid: "a",
        remoteId: "ra",
        etag: "2",
        attendees: [],
      }),
    ]);
    expect(etagOnly.upserted).toEqual([a?.id]);
    const [a2] = await db.select().from(events).where(eq(events.uid, "a"));
    expect(a2?.fieldUpdatedAt).toEqual({
      summary: "2026-11-01T00:00:00.000Z",
    });

    const found = await findCalendarEvents(db, calendarId, {
      remoteIds: ["rb"],
      uids: ["a"],
    });
    expect(found.map((row) => row.uid).sort()).toEqual(["a", "b"]);
    expect(found.find((row) => row.uid === "a")?.attendees).toEqual([]);
    expect(found.find((row) => row.uid === "a")?.reminders).toEqual([]);

    expect(await listEventEtags(db, calendarId)).toEqual(
      new Map([
        ["ra", "2"],
        ["rb", "2"],
      ]),
    );
  });

  it("相手側で UID が変わったら、古い行を消して作り直す", async () => {
    const first = await upsert([remoteEvent({ uid: "old", remoteId: "r1" })]);
    const result = await upsert([
      remoteEvent({ uid: "new", remoteId: "r1", etag: "2" }),
    ]);
    expect(result.deleted).toEqual(first.upserted);
    expect((await rows()).map((row) => row.uid)).toEqual(["new"]);
  });

  it("例外が原本より先に届いたら、原本を入れたときに引き取る", async () => {
    const orphan = await upsert([
      remoteEvent({
        uid: "s",
        remoteId: "rs-1",
        recurrenceId: "2026-12-08T01:00:00.000Z",
      }),
    ]);
    expect((await rows())[0]?.parentId).toBeNull();

    const master = await upsert([
      remoteEvent({ uid: "s", remoteId: "rs", rrule: "FREQ=WEEKLY" }),
    ]);
    const all = await rows();
    const masterRow = all.find((row) => row.recurrenceId === null);
    const child = all.find((row) => row.recurrenceId !== null);
    expect(child?.parentId).toBe(masterRow?.id);
    // 原本と、引き取った例外の両方が upserted に入る。
    expect(master.upserted.sort()).toEqual(
      [masterRow?.id, ...orphan.upserted].sort(),
    );
  });

  it("parentRemoteId で、uid の違う原本を親にする", async () => {
    await upsert([
      remoteEvent({ uid: "series", remoteId: "m1", rrule: "FREQ=DAILY" }),
    ]);
    await upsert([
      remoteEvent({
        uid: "instance",
        remoteId: "m1-x",
        recurrenceId: "2026-12-02T01:00:00.000Z",
        parentRemoteId: "m1",
      }),
    ]);
    const all = await rows();
    const masterRow = all.find((row) => row.uid === "series");
    expect(all.find((row) => row.uid === "instance")?.parentId).toBe(
      masterRow?.id,
    );
  });

  it("remoteId で消すと、原本と例外 (子) の ID を返す。keepEventIds の行は残す", async () => {
    // CalDAV のように、原本と例外が同じ remoteId を持つ。
    const caldav = await upsert([
      remoteEvent({ uid: "c", remoteId: "/c.ics", rrule: "FREQ=DAILY" }),
      remoteEvent({
        uid: "c",
        remoteId: "/c.ics",
        recurrenceId: "2026-12-02T01:00:00.000Z",
      }),
    ]);
    // Google のように、例外は別の remoteId を持つ。
    const google = await upsert([
      remoteEvent({ uid: "g", remoteId: "g1", rrule: "FREQ=DAILY" }),
      remoteEvent({
        uid: "g",
        remoteId: "g1_x",
        recurrenceId: "2026-12-02T01:00:00.000Z",
        parentRemoteId: "g1",
      }),
    ]);
    const keep = await upsert([remoteEvent({ uid: "k", remoteId: "k1" })]);

    const removed = await db.transaction((tx) =>
      deleteCalendarEventsByRemoteId(tx, calendarId, ["/c.ics", "g1", "k1"], {
        keepEventIds: new Set(keep.upserted),
      }),
    );
    expect(removed.deleted.sort()).toEqual(
      [...caldav.upserted, ...google.upserted].sort(),
    );
    expect((await rows()).map((row) => row.uid)).toEqual(["k"]);
  });

  it("全件同期の仕上げは、見なかった remoteId の行を消し、remoteId が null の行を残す", async () => {
    await upsert([
      remoteEvent({ uid: "seen", remoteId: "r-seen" }),
      remoteEvent({ uid: "gone", remoteId: "r-gone" }),
    ]);
    // 作成の書き戻し待ち (remoteId が null)。
    await db.insert(events).values({
      userId,
      calendarId,
      uid: "local@orbit",
      summary: "書き戻し待ち",
    });
    const result = await db.transaction((tx) =>
      deleteCalendarEventsNotIn(tx, calendarId, new Set(["r-seen"])),
    );
    expect(result.deleted).toHaveLength(1);
    expect((await rows()).map((row) => row.uid)).toEqual([
      "local@orbit",
      "seen",
    ]);

    // 書き戻しの結果が同じ uid で返れば、その行に remoteId が付く。
    await upsert([remoteEvent({ uid: "local@orbit", remoteId: "r-local" })]);
    const local = (await rows()).filter((row) => row.uid === "local@orbit");
    expect(local).toHaveLength(1);
    expect(local[0]?.remoteId).toBe("r-local");
  });

  it("replaceCalendarEvents は attendees の self を省いても動く", async () => {
    const { self: _self, ...attendee } = {
      email: "x@example.com",
      name: null,
      role: "required" as const,
      status: "accepted" as const,
      self: true,
    };
    await db.transaction((tx) =>
      replaceCalendarEvents(tx, { userId, calendarId }, [
        remoteEvent({ uid: "ics", remoteId: "unused", attendees: [attendee] }),
      ]),
    );
    const [row] = await rows();
    expect(row?.remoteId).toBeNull();
    const [saved] = await db
      .select({ self: eventAttendees.self })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, row?.id as string));
    expect(saved?.self).toBe(false);
  });

  it("upsertAccountCalendars は利用者の設定と同期の位置を保ち、消えたカレンダーを消す", async () => {
    const scope = { userId, accountId, source: "google" as const };
    const base = {
      description: null,
      timeZone: "Asia/Tokyo",
      readOnly: false,
      url: null,
      defaultReminders: null,
    };
    const first = await db.transaction((tx) =>
      upsertAccountCalendars(tx, scope, [
        { ...base, remoteId: "primary", name: "自分", color: "#111111" },
        {
          ...base,
          remoteId: "other",
          name: "別",
          color: null,
          providerState: { kind: "birthdays" },
        },
      ]),
    );
    expect(first.upserted).toHaveLength(2);
    expect(first.deleted).toEqual([]);

    const byRemote = async (remoteId: string) => {
      const [row] = await db
        .select()
        .from(calendars)
        .where(
          and(
            eq(calendars.accountId, accountId),
            eq(calendars.remoteId, remoteId),
          ),
        );
      return row;
    };
    const primary = await byRemote("primary");
    // 利用者の設定と同期の位置を変える。
    await db
      .update(calendars)
      .set({
        visible: false,
        sortOrder: 3,
        color: "#ff0000",
        pollIntervalSeconds: 600,
        syncToken: "token",
        providerState: { kind: "normal", watch: "w1" },
      })
      .where(eq(calendars.id, primary?.id as string));

    // 変わらない一覧なら何もしない。
    const same = await db.transaction((tx) =>
      upsertAccountCalendars(tx, scope, [
        { ...base, remoteId: "primary", name: "自分", color: "#111111" },
        { ...base, remoteId: "other", name: "別", color: null },
      ]),
    );
    expect(same).toEqual({ upserted: [], deleted: [] });

    const second = await db.transaction((tx) =>
      upsertAccountCalendars(tx, scope, [
        {
          ...base,
          remoteId: "primary",
          name: "名前を変えた",
          color: "#222222",
          readOnly: true,
          providerState: { kind: "normal" },
        },
      ]),
    );
    expect(second.upserted).toEqual([primary?.id]);
    const other = first.upserted.find((id) => id !== primary?.id);
    expect(second.deleted).toEqual([other]);

    expect(await byRemote("primary")).toMatchObject({
      name: "名前を変えた",
      readOnly: true,
      visible: false,
      sortOrder: 3,
      color: "#ff0000",
      pollIntervalSeconds: 600,
      syncToken: "token",
      providerState: { kind: "normal", watch: "w1" },
    });
    expect(await byRemote("other")).toBeUndefined();
  });
});
