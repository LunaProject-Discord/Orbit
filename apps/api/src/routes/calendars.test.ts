/**
 * 予定の API (/v1/calendars) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type CalendarSyncNotification,
  CHANNEL_CALENDAR_SYNC,
  HOLIDAYS_VERSION,
} from "@orbit/core";
import {
  accounts,
  calendars,
  createDb,
  type Database,
  eventAttendees,
  eventConflicts,
  events,
  outbox,
  users,
} from "@orbit/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { calendarRoutes, ensureHolidays, mergeFields } from "./calendars.js";

const adminUrl = process.env.DATABASE_URL;

type Json = Record<string, unknown>;
type EventJson = Json & { id: string; summary: string | null };
type Occurrence = {
  eventId: string;
  masterId: string;
  recurrenceId: string | null;
  startAt: string | null;
  startDate: string | null;
};

describe("mergeFields", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  it("別の項目は両方残し、同じ項目は後から変えた方を残す", () => {
    const result = mergeFields(
      {
        summary: "2026-11-30T12:00:00.000Z",
        location: "2026-11-30T10:00:00.000Z",
      },
      { summary: "古い", location: "新しい" },
      {
        summary: "2026-11-30T11:00:00Z",
        location: "2026-11-30T11:00:00Z",
      },
      now,
    );
    expect(result.accepted).toEqual({ location: "新しい" });
    expect(result.rejected).toEqual(["summary"]);
    expect(result.fieldUpdatedAt).toEqual({
      summary: "2026-11-30T12:00:00.000Z",
      location: "2026-11-30T11:00:00.000Z",
    });
  });
  it("時刻が無ければ届いた時刻、未来の時刻は届いた時刻に丸める", () => {
    const result = mergeFields(
      {},
      { summary: "a", busy: false },
      { busy: "2027-01-01T00:00:00Z" },
      now,
    );
    expect(result.fieldUpdatedAt).toEqual({
      summary: now.toISOString(),
      busy: now.toISOString(),
    });
  });
});

describe.skipIf(!adminUrl)("予定の API", () => {
  const dbName = `mail_calendars_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let app: Hono<AppEnv>;
  let otherApp: Hono<AppEnv>;
  let readOnlyId: string;
  let thirdId: string;
  let icsApp: Hono<AppEnv>;
  /** 購読の取得で返す中身 (null なら 304)。 */
  let feed: string | null = null;
  let feedRequests: Record<string, string>[] = [];

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    target: Hono<AppEnv> = app,
  ) => {
    const response = await target.request(`/calendars${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as Json,
    };
  };

  const range = async (from: string, to: string) => {
    const result = await call(
      "GET",
      `/events?from=${from}&to=${to}&timeZone=Asia/Tokyo`,
    );
    expect(result.status).toBe(200);
    return result.body as { events: EventJson[]; occurrences: Occurrence[] };
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    ({ db, pool } = createDb(url.toString()));
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
      .values({ email: "owner@example.com", name: "owner" })
      .returning({ id: users.id });
    const [other] = await db
      .insert(users)
      .values({ email: "other@example.com", name: "other" })
      .returning({ id: users.id });
    const [third] = await db
      .insert(users)
      .values({ email: "third@example.com", name: "third" })
      .returning({ id: users.id });
    if (!user || !other || !third) {
      throw new Error("利用者を作れませんでした。");
    }
    thirdId = third.id;
    const [holidays] = await db
      .insert(calendars)
      .values({
        userId: user.id,
        source: "holidays",
        name: "日本の祝日",
        // 予定の確かめに祝日が混ざらないよう、入れ直し済みにしておく。
        etag: `${HOLIDAYS_VERSION}/${new Date().toISOString().slice(0, 4)}`,
      })
      .returning({ id: calendars.id });
    readOnlyId = holidays?.id as string;

    const build = (id: string, email: string) => {
      const target = new Hono<AppEnv>();
      target.use(async (c, next) => {
        c.set("user", { id, email, name: email });
        await next();
      });
      // 書き戻しに対応していない場合を確かめるため、既定の一覧 (CALENDAR_WRITEBACK_SOURCES) は使わない。
      target.route("/calendars", calendarRoutes({ db, writebackSources: [] }));
      return target;
    };
    app = build(user.id, "owner@example.com");
    icsApp = new Hono<AppEnv>();
    icsApp.use(async (c, next) => {
      c.set("user", {
        id: third.id,
        email: "third@example.com",
        name: "third",
      });
      await next();
    });
    icsApp.route(
      "/calendars",
      calendarRoutes({
        db,
        // 名前解決をしないで済むように、内部のアドレスの確認を外す。
        allowPrivateMailHosts: true,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          feedRequests.push(init.headers as Record<string, string>);
          if (feed === null) return new Response(null, { status: 304 });
          return new Response(feed, { headers: { etag: `"${feed.length}"` } });
        }) as typeof fetch,
      }),
    );
    otherApp = build(other.id, "other@example.com");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await admin?.query(`drop database if exists ${dbName}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await admin?.end();
  });

  let calendarId: string;

  it("カレンダーを作り、一覧に出す。ほかの利用者には見えない", async () => {
    const created = await call("POST", "", {
      name: "仕事",
      color: "#F43F7A",
      timeZone: "Asia/Tokyo",
    });
    expect(created.status).toBe(201);
    calendarId = (created.body.calendar as Json).id as string;
    const list = await call("GET", "");
    const names = (list.body.calendars as Json[]).map((row) => [
      row.name,
      row.readOnly,
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["仕事", false],
        ["日本の祝日", true],
      ]),
    );
    // ほかの利用者には、その人の祝日のカレンダーだけが出る。
    const others = await call("GET", "", undefined, otherApp);
    expect(
      (others.body.calendars as Json[]).map((row) => [row.source, row.id]),
    ).toEqual([["holidays", expect.not.stringMatching(readOnlyId)]]);
    expect(
      (await call("PATCH", `/${calendarId}`, { name: "x" }, undefined)).status,
    ).toBe(200);
    expect(
      (await call("PATCH", `/${calendarId}`, { name: "仕事" }, otherApp))
        .status,
    ).toBe(404);
    // 祝日の名前は変えられないが、表示の切り替えはできる。
    expect((await call("PATCH", `/${readOnlyId}`, { name: "x" })).status).toBe(
      409,
    );
    expect(
      (await call("PATCH", `/${readOnlyId}`, { visible: false })).status,
    ).toBe(200);
  });

  it("予定を作って期間で引く。終日と時刻付き、範囲の外は出ない", async () => {
    const timed = await call("POST", "/events", {
      calendarId,
      summary: "定例会議",
      location: "第一会議室",
      time: {
        allDay: false,
        startAt: "2026-12-01T10:00:00+09:00",
        endAt: "2026-12-01T11:00:00+09:00",
        startTimeZone: "Asia/Tokyo",
      },
      reminders: [{ method: "display", minutes: 10 }],
      useDefaultReminders: false,
    });
    expect(timed.status).toBe(201);
    const event = timed.body.event as Json;
    // 参加者のある予定の作成は「招待と出欠」の確かめで行う (Orbit 内のカレンダーは参加者を持てない)。
    expect(event).toMatchObject({
      summary: "定例会議",
      startAt: "2026-12-01T01:00:00.000Z",
      reminders: [{ method: "display", minutes: 10 }],
      attendees: [],
      organizer: null,
    });
    const allDay = await call("POST", "/events", {
      calendarId,
      summary: "出張",
      time: { allDay: true, startDate: "2026-12-02", endDate: "2026-12-04" },
    });
    expect(allDay.status).toBe(201);

    const week = await range("2026-11-29", "2026-12-06");
    expect(
      week.occurrences.map((o) => [o.startAt ?? o.startDate, o.recurrenceId]),
    ).toEqual([
      ["2026-12-01T01:00:00Z", null],
      ["2026-12-02", null],
    ]);
    expect(week.events.map((e) => e.summary).sort()).toEqual([
      "出張",
      "定例会議",
    ]);
    expect((await range("2026-12-06", "2026-12-07")).occurrences).toEqual([]);
    // 出張の最終日 (12/3) だけの範囲にもかかる。
    expect((await range("2026-12-03", "2026-12-04")).occurrences).toHaveLength(
      1,
    );
    // ほかの利用者には見えない。
    const others = await call(
      "GET",
      "/events?from=2026-11-29&to=2026-12-06&timeZone=Asia/Tokyo",
      undefined,
      otherApp,
    );
    expect(others.body.occurrences).toEqual([]);
  });

  it("同じ ID の再送では二重に作らない", async () => {
    const id = randomUUID();
    const body = {
      id,
      calendarId,
      summary: "再送",
      time: { allDay: true, startDate: "2026-12-10", endDate: "2026-12-11" },
    };
    expect((await call("POST", "/events", body)).status).toBe(201);
    expect((await call("POST", "/events", body)).status).toBe(201);
    const days = await range("2026-12-10", "2026-12-11");
    expect(days.occurrences.filter((o) => o.eventId === id)).toHaveLength(1);
  });

  it("同じ ID の作成が同時に届いても、どちらも 201 で行は 1 つ (指摘 7)", async () => {
    const id = randomUUID();
    const body = {
      id,
      calendarId,
      summary: "同時",
      time: { allDay: true, startDate: "2026-12-12", endDate: "2026-12-13" },
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call("POST", "/events", body)),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.event.id))).toEqual(new Set([id]));
    const days = await range("2026-12-12", "2026-12-13");
    expect(days.occurrences.filter((o) => o.eventId === id)).toHaveLength(1);
  });

  it("書き込めないカレンダーや、ほかの利用者のカレンダーには作れない", async () => {
    const time = {
      allDay: true,
      startDate: "2026-12-10",
      endDate: "2026-12-11",
    };
    expect(
      (await call("POST", "/events", { calendarId: readOnlyId, time })).status,
    ).toBe(409);
    expect(
      (await call("POST", "/events", { calendarId, time }, otherApp)).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/events", {
          calendarId,
          time: {
            allDay: true,
            startDate: "2026-12-10",
            endDate: "2026-12-10",
          },
        })
      ).status,
    ).toBe(400);
  });

  it("項目ごとに変更をまとめ、後から変えた方を残す", async () => {
    const created = await call("POST", "/events", {
      calendarId,
      summary: "打ち合わせ",
      time: { allDay: true, startDate: "2026-12-15", endDate: "2026-12-16" },
    });
    const id = (created.body.event as Json).id as string;
    // 端末 A がタイトルを変えた。
    const first = await call("PATCH", `/events/${id}`, {
      changes: { summary: "A の変更" },
      changedAt: { summary: new Date().toISOString() },
    });
    expect(first.body.rejected).toEqual([]);
    // 端末 B は A より前にタイトルと場所を変えていて (オフライン)、あとから届いた。
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const second = await call("PATCH", `/events/${id}`, {
      changes: { summary: "B の変更", location: "B の場所" },
      changedAt: { summary: earlier, location: earlier },
    });
    expect(second.status).toBe(200);
    expect(second.body.rejected).toEqual(["summary"]);
    expect(second.body.event).toMatchObject({
      summary: "A の変更",
      location: "B の場所",
    });
    expect(
      (
        await call(
          "PATCH",
          `/events/${id}`,
          { changes: { summary: "x" } },
          otherApp,
        )
      ).status,
    ).toBe(404);
  });

  it("繰り返しを展開し、1 回だけの変更と削除ができる", async () => {
    const created = await call("POST", "/events", {
      calendarId,
      summary: "週次",
      time: {
        allDay: false,
        startAt: "2026-12-07T10:00:00+09:00",
        endAt: "2026-12-07T10:30:00+09:00",
        startTimeZone: "Asia/Tokyo",
      },
      recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO" },
    });
    expect(created.status).toBe(201);
    const id = (created.body.event as Json).id as string;
    const mine = async () =>
      (await range("2026-12-07", "2027-01-04")).occurrences.filter(
        (o) => o.masterId === id,
      );
    expect((await mine()).map((o) => o.recurrenceId)).toEqual([
      "2026-12-07T01:00:00Z",
      "2026-12-14T01:00:00Z",
      "2026-12-21T01:00:00Z",
      "2026-12-28T01:00:00Z",
    ]);

    // 12/14 の回だけ 15:00 に動かし、タイトルを変える。
    const moved = await call(
      "PATCH",
      `/events/${id}/occurrences/2026-12-14T01:00:00Z`,
      {
        changes: {
          summary: "週次 (移動)",
          time: {
            allDay: false,
            startAt: "2026-12-14T15:00:00+09:00",
            endAt: "2026-12-14T15:30:00+09:00",
            startTimeZone: "Asia/Tokyo",
          },
        },
      },
    );
    expect(moved.status).toBe(200);
    const exceptionId = (moved.body.event as Json).id as string;
    expect(moved.body.event).toMatchObject({
      parentId: id,
      recurrenceId: "2026-12-14T01:00:00Z",
      summary: "週次 (移動)",
    });
    // 同じ回をもう一度変えると、同じ例外が変わる。
    const again = await call(
      "PATCH",
      `/events/${id}/occurrences/2026-12-14T10:00:00%2B09:00`,
      { changes: { location: "オンライン" } },
    );
    expect((again.body.event as Json).id).toBe(exceptionId);
    // 規則に無い回は変えられない。
    expect(
      (
        await call("PATCH", `/events/${id}/occurrences/2026-12-15T01:00:00Z`, {
          changes: { summary: "x" },
        })
      ).status,
    ).toBe(400);

    // 12/21 の回を消す。
    expect(
      (await call("DELETE", `/events/${id}/occurrences/2026-12-21T01:00:00Z`))
        .status,
    ).toBe(204);
    const after = await mine();
    expect(after.map((o) => [o.eventId === exceptionId, o.startAt])).toEqual([
      [false, "2026-12-07T01:00:00Z"],
      [true, "2026-12-14T06:00:00Z"],
      [false, "2026-12-28T01:00:00Z"],
    ]);

    // 原本を消すと、例外も消える。
    expect((await call("DELETE", `/events/${id}`)).status).toBe(204);
    expect(await mine()).toEqual([]);
    expect((await call("GET", `/events/${exceptionId}`)).status).toBe(404);
  });

  it("タイトル・場所・メモで探せる (全角と半角、大文字と小文字を区別しない)", async () => {
    await call("POST", "/events", {
      calendarId,
      summary: "ＡＢＣ社と打ち合わせ",
      description: "<p>資料を<b>持参</b></p>",
      time: { allDay: true, startDate: "2026-12-20", endDate: "2026-12-21" },
    });
    const search = async (q: string, target = app) =>
      (
        (
          await call(
            "GET",
            `/events/search?q=${encodeURIComponent(q)}`,
            undefined,
            target,
          )
        ).body.events as EventJson[]
      ).map((e) => e.summary);
    expect(await search("abc")).toEqual(["ＡＢＣ社と打ち合わせ"]);
    expect(await search("持参 abc社")).toEqual(["ＡＢＣ社と打ち合わせ"]);
    expect(await search("会議室")).toEqual(["定例会議"]);
    expect(await search("存在しない")).toEqual([]);
    expect(await search("abc", otherApp)).toEqual([]);
  });

  it("差分同期で、変わった予定と消えた予定を返す", async () => {
    const start = await call("GET", "/sync?since=0&limit=1000");
    expect(start.status).toBe(200);
    const seq = start.body.latestSeq as string;
    expect(Number(seq)).toBeGreaterThan(0);

    const created = await call("POST", "/events", {
      calendarId,
      summary: "同期の確認",
      time: { allDay: true, startDate: "2026-12-24", endDate: "2026-12-25" },
    });
    const id = (created.body.event as Json).id as string;
    const changed = await call("GET", `/sync?since=${seq}`);
    expect((changed.body.events as EventJson[]).map((e) => e.id)).toEqual([id]);

    await call("DELETE", `/events/${id}`);
    const removed = await call("GET", `/sync?since=${changed.body.latestSeq}`);
    expect(removed.body.events).toEqual([]);
    expect(removed.body.deleted).toEqual({ calendars: [], events: [id] });

    // ほかの利用者には、その人の祝日のカレンダーと祝日だけが届く。
    const others = await call("GET", "/sync?since=0", undefined, otherApp);
    const otherCalendars = others.body.calendars as Json[];
    expect(otherCalendars.map((row) => row.source)).toEqual(["holidays"]);
    expect(
      (others.body.events as Json[]).every(
        (event) => event.calendarId === otherCalendars[0]?.id,
      ),
    ).toBe(true);
  });

  it("カレンダーを消すと予定も消える", async () => {
    expect((await call("DELETE", `/${readOnlyId}`)).status).toBe(409);
    expect(
      (await call("DELETE", `/${calendarId}`, undefined, otherApp)).status,
    ).toBe(404);
    expect((await call("DELETE", `/${calendarId}`)).status).toBe(204);
    expect((await range("2026-11-29", "2027-01-01")).occurrences).toEqual([]);
  });

  it("祝日のカレンダーを用意し、版が同じなら入れ直さない", async () => {
    await ensureHolidays(db, thirdId, "2026-11-27");
    const [holidays] = await db
      .select()
      .from(calendars)
      .where(
        and(eq(calendars.userId, thirdId), eq(calendars.source, "holidays")),
      );
    expect(holidays).toMatchObject({ readOnly: true, name: "日本の祝日" });
    const rows = await db
      .select({ summary: events.summary, startDate: events.startDate })
      .from(events)
      .where(eq(events.calendarId, holidays?.id as string));
    expect(rows).toContainEqual({
      summary: "勤労感謝の日",
      startDate: "2026-11-23",
    });
    // 2036 年 (今年の 10 年後) まで入る。
    expect(rows.some((row) => row.startDate?.startsWith("2036-"))).toBe(true);
    const updatedAt = holidays?.updatedAt;
    await ensureHolidays(db, thirdId, "2026-11-28");
    const [again] = await db
      .select({ updatedAt: calendars.updatedAt })
      .from(calendars)
      .where(eq(calendars.id, holidays?.id as string));
    expect(again?.updatedAt).toEqual(updatedAt);
    // 祝日のカレンダーは消せない。
    const removed = await icsApp.request(`/calendars/${holidays?.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(409);
  });

  it("ICS を購読し、取り直しで変わった予定だけ入れ替える", async () => {
    const ics = (summary: string, extra: string[] = []) =>
      [
        "BEGIN:VCALENDAR",
        "X-WR-CALNAME:チームの予定",
        "BEGIN:VEVENT",
        "UID:keep",
        "DTSTART;TZID=Asia/Tokyo:20261201T100000",
        "DTEND;TZID=Asia/Tokyo:20261201T110000",
        `SUMMARY:${summary}`,
        "END:VEVENT",
        ...extra,
        "END:VCALENDAR",
      ].join("\r\n");
    const post = (body: Json) =>
      icsApp.request("/calendars/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    feed = "<html>not a calendar</html>";
    const bad = await post({ url: "webcal://calendar.example.com/a.ics" });
    expect(bad.status).toBe(400);

    feed = ics("最初", [
      "BEGIN:VEVENT",
      "UID:gone",
      "DTSTART;VALUE=DATE:20261202",
      "SUMMARY:消える予定",
      "END:VEVENT",
    ]);
    const created = await post({ url: "webcal://calendar.example.com/a.ics" });
    expect(created.status).toBe(201);
    const calendar = ((await created.json()) as { calendar: Json }).calendar;
    expect(calendar).toMatchObject({
      source: "ics",
      name: "チームの予定",
      readOnly: true,
      url: "https://calendar.example.com/a.ics",
    });
    const id = calendar.id as string;
    const before = await db
      .select({ id: events.id, uid: events.uid, summary: events.summary })
      .from(events)
      .where(eq(events.calendarId, id));
    expect(before.map((row) => row.summary).sort()).toEqual([
      "最初",
      "消える予定",
    ]);

    // 304 なら何もしない。送るときは前回の ETag を付ける。
    feed = null;
    feedRequests = [];
    const unchanged = await icsApp.request(`/calendars/${id}/refresh`, {
      method: "POST",
    });
    expect(unchanged.status).toBe(200);
    expect(feedRequests[0]?.["if-none-match"]).toMatch(/^"\d+"$/);

    feed = ics("変えた");
    await icsApp.request(`/calendars/${id}/refresh`, { method: "POST" });
    const after = await db
      .select({ id: events.id, uid: events.uid, summary: events.summary })
      .from(events)
      .where(eq(events.calendarId, id));
    expect(after).toEqual([
      {
        id: before.find((row) => row.uid === "keep")?.id,
        uid: "keep",
        summary: "変えた",
      },
    ]);

    // 購読の予定は書き換えられないが、カレンダーの名前は変えられ、購読は消せる。
    const rename = await icsApp.request(`/calendars/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "チーム" }),
    });
    expect(rename.status).toBe(200);
    const remove = await icsApp.request(`/calendars/${id}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(204);
  });

  describe("プロバイダのカレンダーへの書き戻し (outbox)", () => {
    let accountId: string;
    let googleCalendarId: string;
    /** google を書き戻せる設定にした API。 */
    let writebackApp: Hono<AppEnv>;
    let listener: pg.Client;
    const notifications: CalendarSyncNotification[] = [];

    type OutboxRow = typeof outbox.$inferSelect;
    const queued = async (): Promise<OutboxRow[]> =>
      db
        .select()
        .from(outbox)
        .where(eq(outbox.accountId, accountId))
        .orderBy(asc(outbox.createdAt), asc(outbox.id));
    const send = (method: string, path: string, body?: unknown) =>
      call(method, path, body, writebackApp);
    const timed = (startAt: string, endAt: string) => ({
      allDay: false,
      startAt,
      endAt,
      startTimeZone: "Asia/Tokyo",
    });

    beforeAll(async () => {
      const [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "owner@example.com"));
      if (!owner) throw new Error("利用者が見つかりません。");
      const [account] = await db
        .insert(accounts)
        .values({
          userId: owner.id,
          email: "owner@gmail.com",
          provider: "gmail",
          authType: "oauth2",
          username: "owner@gmail.com",
          credentialsEncrypted: "x",
          calendarEnabled: true,
        })
        .returning({ id: accounts.id });
      accountId = account?.id as string;
      const [calendar] = await db
        .insert(calendars)
        .values({
          userId: owner.id,
          accountId,
          source: "google",
          remoteId: "primary",
          name: "Google",
        })
        .returning({ id: calendars.id });
      googleCalendarId = calendar?.id as string;
      writebackApp = new Hono<AppEnv>();
      writebackApp.use(async (c, next) => {
        c.set("user", {
          id: owner.id,
          email: "owner@example.com",
          name: "owner",
        });
        await next();
      });
      writebackApp.route(
        "/calendars",
        calendarRoutes({ db, writebackSources: ["google"] }),
      );
      const url = new URL(adminUrl as string);
      url.pathname = `/${dbName}`;
      listener = new pg.Client({ connectionString: url.toString() });
      await listener.connect();
      listener.on("notification", (message) => {
        if (message.channel === CHANNEL_CALENDAR_SYNC && message.payload) {
          notifications.push(JSON.parse(message.payload));
        }
      });
      await listener.query(`listen ${CHANNEL_CALENDAR_SYNC}`);
    });

    afterAll(async () => {
      await listener?.end();
    });

    beforeEach(async () => {
      await db.delete(outbox);
      notifications.length = 0;
    });

    it("Orbit 内のカレンダーの変更は積まない", async () => {
      const local = await send("POST", "", { name: "ローカル" });
      const created = await send("POST", "/events", {
        calendarId: (local.body.calendar as Json).id,
        summary: "ローカル",
        time: { allDay: true, startDate: "2027-01-05", endDate: "2027-01-06" },
      });
      expect(created.status).toBe(201);
      const id = (created.body.event as Json).id as string;
      await send("PATCH", `/events/${id}`, { changes: { summary: "変更" } });
      await send("DELETE", `/events/${id}`);
      expect(await db.select().from(outbox)).toEqual([]);
    });

    it("書き戻しに対応していなければ、プロバイダのカレンダーは読み取り専用", async () => {
      const list = await call("GET", "");
      expect(
        (list.body.calendars as Json[]).find(
          (row) => row.id === googleCalendarId,
        )?.readOnly,
      ).toBe(true);
      const created = await call("POST", "/events", {
        calendarId: googleCalendarId,
        time: { allDay: true, startDate: "2027-01-05", endDate: "2027-01-06" },
      });
      expect(created.status).toBe(409);
      const writable = await send("GET", "");
      expect(
        (writable.body.calendars as Json[]).find(
          (row) => row.id === googleCalendarId,
        )?.readOnly,
      ).toBe(false);
    });

    it("作成・変更・削除を 1 行ずつ積み、再送では増えない", async () => {
      const id = randomUUID();
      const body = {
        id,
        calendarId: googleCalendarId,
        summary: "書き戻し",
        time: timed("2027-01-06T10:00:00+09:00", "2027-01-06T11:00:00+09:00"),
      };
      expect((await send("POST", "/events", body)).status).toBe(201);
      expect((await send("POST", "/events", body)).status).toBe(201);
      let rows = await queued();
      expect(rows.map((row) => [row.kind, row.idempotencyKey])).toEqual([
        ["event_create", `event_create:${id}`],
      ]);
      expect(rows[0]?.payload).toEqual({
        eventId: id,
        calendarId: googleCalendarId,
      });
      expect(notifications).toContainEqual({ accountId, reason: "outbox" });

      // 作成を書き戻した (ワーカーが remoteId を付けて、行を done にした) ことにする。
      await db
        .update(events)
        .set({ remoteId: "remote-1", etag: '"1"' })
        .where(eq(events.id, id));
      await db.update(outbox).set({ status: "done" });

      // 作成より後の、端末で変えた時刻。
      const changedAt = new Date().toISOString();
      const patch = {
        changes: { summary: "変えた", location: "会議室" },
        changedAt: { summary: changedAt, location: changedAt },
      };
      expect((await send("PATCH", `/events/${id}`, patch)).status).toBe(200);
      expect((await send("PATCH", `/events/${id}`, patch)).status).toBe(200);
      rows = (await queued()).filter((row) => row.kind === "event_update");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({
        eventId: id,
        calendarId: googleCalendarId,
        fields: ["location", "summary"],
      });
      expect(rows[0]?.idempotencyKey).toMatch(
        new RegExp(
          `^event_update:${id}:location,summary:${changedAt}:[0-9a-f]{16}$`,
        ),
      );
      // 全部の項目が負けた変更は積まない。
      const stale = await send("PATCH", `/events/${id}`, {
        changes: { summary: "古い" },
        changedAt: { summary: new Date(Date.now() - 60_000).toISOString() },
      });
      expect(stale.body.rejected).toEqual(["summary"]);
      expect(
        (await queued()).filter((row) => row.kind === "event_update"),
      ).toHaveLength(1);

      expect((await send("DELETE", `/events/${id}`)).status).toBe(204);
      rows = await queued();
      // まだ実行していない変更は、削除で要らなくなるので取り消す。
      expect(rows.map((row) => [row.kind, row.status])).toEqual([
        ["event_create", "done"],
        ["event_delete", "pending"],
      ]);
      expect(rows[1]?.idempotencyKey).toBe(`event_delete:${id}`);
      expect(rows[1]?.payload).toMatchObject({
        calendarId: googleCalendarId,
        target: {
          eventId: id,
          calendarId: googleCalendarId,
          remoteId: "remote-1",
          etag: '"1"',
          uid: `${id}@orbit`,
          recurrenceId: null,
          parentRemoteId: null,
        },
      });
    });

    it("指摘 13: 同じ項目を同じ changedAt で別の値に変えても積む (同じ値の再送は積まない)", async () => {
      const id = randomUUID();
      expect(
        (
          await send("POST", "/events", {
            id,
            calendarId: googleCalendarId,
            summary: "元",
            time: timed(
              "2027-01-10T10:00:00+09:00",
              "2027-01-10T11:00:00+09:00",
            ),
          })
        ).status,
      ).toBe(201);
      await db
        .update(events)
        .set({ remoteId: "remote-13", etag: '"1"' })
        .where(eq(events.id, id));
      await db.update(outbox).set({ status: "done" });
      const changedAt = new Date().toISOString();
      const patch = (summary: string) =>
        send("PATCH", `/events/${id}`, {
          changes: { summary },
          changedAt: { summary: changedAt },
        });
      expect((await patch("一つ目")).status).toBe(200);
      // 1 つ目を書き戻し終えた。
      await db.update(outbox).set({ status: "done" });
      expect((await patch("一つ目")).status).toBe(200);
      expect((await patch("二つ目")).status).toBe(200);
      const updates = (await queued()).filter(
        (row) => row.kind === "event_update",
      );
      expect(updates.map((row) => row.status)).toEqual(["done", "pending"]);
      const [row] = await db.select().from(events).where(eq(events.id, id));
      expect(row?.summary).toBe("二つ目");
    });

    it("指摘 12: calendarEnabled が false か、同期が calendarError で止まっていれば 409", async () => {
      const created = await send("POST", "/events", {
        calendarId: googleCalendarId,
        summary: "止まる前",
        time: { allDay: true, startDate: "2027-01-11", endDate: "2027-01-12" },
      });
      expect(created.status).toBe(201);
      const id = (created.body.event as Json).id as string;
      await db.delete(outbox);
      const attempts = () =>
        Promise.all([
          send("POST", "/events", {
            calendarId: googleCalendarId,
            summary: "止まっている間",
            time: {
              allDay: true,
              startDate: "2027-01-11",
              endDate: "2027-01-12",
            },
          }),
          send("PATCH", `/events/${id}`, { changes: { summary: "変更" } }),
          send("DELETE", `/events/${id}`),
        ]);
      try {
        await db
          .update(accounts)
          .set({ calendarEnabled: false })
          .where(eq(accounts.id, accountId));
        for (const result of await attempts()) {
          expect(result.status).toBe(409);
          expect(result.body.error).toBe("calendar_disabled");
        }
        await db
          .update(accounts)
          .set({ calendarEnabled: true, calendarError: "認証が切れました" })
          .where(eq(accounts.id, accountId));
        for (const result of await attempts()) {
          expect(result.status).toBe(409);
          expect(result.body.error).toBe("calendar_sync_stopped");
        }
        expect(await queued()).toEqual([]);
        const [row] = await db.select().from(events).where(eq(events.id, id));
        expect(row?.summary).toBe("止まる前");
      } finally {
        await db
          .update(accounts)
          .set({ calendarEnabled: true, calendarError: null })
          .where(eq(accounts.id, accountId));
      }
      expect(
        (await send("PATCH", `/events/${id}`, { changes: { summary: "再開" } }))
          .status,
      ).toBe(200);
    });

    it("作成を書き戻す前に消すと、作成の行を消して何も積まない", async () => {
      const created = await send("POST", "/events", {
        calendarId: googleCalendarId,
        summary: "すぐ消す",
        time: { allDay: true, startDate: "2027-01-07", endDate: "2027-01-08" },
      });
      const id = (created.body.event as Json).id as string;
      await send("PATCH", `/events/${id}`, { changes: { summary: "変更" } });
      expect((await queued()).map((row) => row.kind)).toEqual([
        "event_create",
        "event_update",
      ]);
      expect((await send("DELETE", `/events/${id}`)).status).toBe(204);
      expect(await queued()).toEqual([]);
    });

    it("作成の書き戻しを実行中に消すと、削除を積む", async () => {
      const created = await send("POST", "/events", {
        calendarId: googleCalendarId,
        summary: "実行中",
        time: { allDay: true, startDate: "2027-01-08", endDate: "2027-01-09" },
      });
      const id = (created.body.event as Json).id as string;
      await db.update(outbox).set({ status: "processing" });
      expect((await send("DELETE", `/events/${id}`)).status).toBe(204);
      const rows = await queued();
      expect(rows.map((row) => [row.kind, row.status])).toEqual([
        ["event_create", "processing"],
        ["event_delete", "pending"],
      ]);
      expect(rows[1]?.payload).toMatchObject({
        target: { eventId: id, remoteId: null, uid: `${id}@orbit` },
      });
    });

    it("回の変更は例外の変更、回の削除は原本の繰り返しの変更として積む", async () => {
      const created = await send("POST", "/events", {
        calendarId: googleCalendarId,
        summary: "週次",
        time: timed("2027-01-11T10:00:00+09:00", "2027-01-11T10:30:00+09:00"),
        recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO" },
      });
      const id = (created.body.event as Json).id as string;
      await db
        .update(events)
        .set({ remoteId: "series-1" })
        .where(eq(events.id, id));
      await db.update(outbox).set({ status: "done" });

      const moved = await send(
        "PATCH",
        `/events/${id}/occurrences/2027-01-18T01:00:00Z`,
        { changes: { summary: "移動" } },
      );
      expect(moved.status).toBe(200);
      const exceptionId = (moved.body.event as Json).id as string;
      let pending = (await queued()).filter((row) => row.status === "pending");
      expect(pending.map((row) => [row.kind, row.payload])).toEqual([
        [
          "event_update",
          {
            eventId: exceptionId,
            calendarId: googleCalendarId,
            fields: ["summary"],
          },
        ],
      ]);

      expect(
        (await send("DELETE", `/events/${id}/occurrences/2027-01-25T01:00:00Z`))
          .status,
      ).toBe(204);
      // 例外を消すのも、その回の削除 (原本の EXDATE) になる。
      expect((await send("DELETE", `/events/${exceptionId}`)).status).toBe(204);
      pending = (await queued()).filter((row) => row.status === "pending");
      // 例外の変更はまだ実行していないので取り消し、原本の変更だけを積む
      // (2 回の削除が同じミリ秒なら同じキーになり、1 行にまとまる)。
      expect(pending.length).toBeGreaterThanOrEqual(1);
      for (const row of pending) {
        expect([row.kind, row.payload]).toEqual([
          "event_update",
          { eventId: id, calendarId: googleCalendarId, fields: ["recurrence"] },
        ]);
      }
      const [master] = await db.select().from(events).where(eq(events.id, id));
      expect(master?.exdates).toEqual([
        "2027-01-25T01:00:00Z",
        "2027-01-18T01:00:00Z",
      ]);
    });
  });
  describe("オフラインと競合 (clientNow、changedAt、deletedAt)", () => {
    let offlineCalendarId: string;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const MIN = 60_000;
    const allDay = {
      allDay: true,
      startDate: "2027-02-01",
      endDate: "2027-02-02",
    };
    const create = async (extra: Json = {}) => {
      const created = await call("POST", "/events", {
        calendarId: offlineCalendarId,
        summary: "オフライン",
        time: allDay,
        changedAt: ago(120 * MIN),
        ...extra,
      });
      expect(created.status).toBe(201);
      return created.body.event as EventJson & {
        fieldUpdatedAt: Record<string, string>;
      };
    };

    beforeAll(async () => {
      const created = await call("POST", "", { name: "オフライン" });
      offlineCalendarId = (created.body.calendar as Json).id as string;
    });

    it("オフラインで作って変えた予定を後から順に送っても、変更が rejected にならない", async () => {
      const id = randomUUID();
      const madeAt = ago(60 * MIN);
      const event = await create({ id, changedAt: madeAt, clientNow: ago(0) });
      // 作った時刻が全項目の変更時刻になる (届いた時刻ではない)。
      expect(event.fieldUpdatedAt.summary).toBe(new Date(madeAt).toISOString());
      expect(event.fieldUpdatedAt.time).toBe(new Date(madeAt).toISOString());
      const patched = await call("PATCH", `/events/${id}`, {
        changes: { summary: "あとで変えた題" },
        changedAt: { summary: ago(55 * MIN) },
        clientNow: ago(0),
      });
      expect(patched.status).toBe(200);
      expect(patched.body.rejected).toEqual([]);
      expect(patched.body.event).toMatchObject({ summary: "あとで変えた題" });
    });

    it("同じ PATCH を 2 回送っても rejected が空 (補正で時刻が古くなった場合も)", async () => {
      const event = await create();
      const body = {
        changes: {
          summary: "再送",
          // 参加者の再送は「招待と出欠」で確かめる (Orbit 内のカレンダーは参加者を持てない)。
          reminders: [{ method: "display", minutes: 5 }],
        },
        changedAt: {
          summary: ago(MIN),
          reminders: ago(MIN),
        },
        clientNow: ago(0),
      };
      const first = await call("PATCH", `/events/${event.id}`, body);
      expect(first.body.rejected).toEqual([]);
      const again = await call("PATCH", `/events/${event.id}`, body);
      expect(again.body.rejected).toEqual([]);
      // 2 回目は端末の時計が 20 秒進んで見える (補正で 20 秒古くなり、時刻では負ける)。
      const shifted = await call("PATCH", `/events/${event.id}`, {
        ...body,
        clientNow: new Date(Date.now() + 20_000).toISOString(),
      });
      expect(shifted.body.rejected).toEqual([]);
      expect(shifted.body.event).toMatchObject({ summary: "再送" });
      expect((shifted.body.event as Json).fieldUpdatedAt).toEqual(
        (first.body.event as Json).fieldUpdatedAt,
      );
      // 値が違えば、いままでどおり rejected。
      const other = await call("PATCH", `/events/${event.id}`, {
        changes: { summary: "別の値" },
        changedAt: { summary: ago(2 * MIN) },
      });
      expect(other.body.rejected).toEqual(["summary"]);
    });

    it("時計が 1 時間遅い端末の新しい変更が勝ち、1 時間進んだ端末の古い変更が負ける", async () => {
      const event = await create();
      // 時計の合った端末 A が 5 分前に変えた。
      await call("PATCH", `/events/${event.id}`, {
        changes: { summary: "A" },
        changedAt: { summary: ago(5 * MIN) },
        clientNow: ago(0),
      });
      // 時計が 1 時間遅い端末 B が 1 分前に変えた (端末の時計では 1 時間 1 分前)。
      const slow = await call("PATCH", `/events/${event.id}`, {
        changes: { summary: "B" },
        changedAt: { summary: ago(61 * MIN) },
        clientNow: ago(60 * MIN),
      });
      expect(slow.body.rejected).toEqual([]);
      expect(slow.body.event).toMatchObject({ summary: "B" });
      // 時計が 1 時間進んだ端末 C が 10 分前に変えていた (端末の時計では 50 分後)。
      const fast = await call("PATCH", `/events/${event.id}`, {
        changes: { summary: "C" },
        changedAt: { summary: ago(-50 * MIN) },
        clientNow: ago(-60 * MIN),
      });
      expect(fast.body.rejected).toEqual(["summary"]);
      expect(fast.body.event).toMatchObject({ summary: "B" });
    });

    it("削除の後に変更があれば消さずに changed_since。削除が後なら消え、その後の PATCH は 404、POST の再送は 410", async () => {
      const id = randomUUID();
      const body = {
        id,
        calendarId: offlineCalendarId,
        summary: "消す予定",
        time: allDay,
        changedAt: ago(30 * MIN),
      };
      expect((await call("POST", "/events", body)).status).toBe(201);
      await call("PATCH", `/events/${id}`, {
        changes: { location: "ほかの端末の変更" },
        changedAt: { location: ago(MIN) },
      });
      // 端末 B は、ほかの端末の変更より前にオフラインで消していた。
      const cancelled = await call("DELETE", `/events/${id}`, {
        deletedAt: ago(5 * MIN),
        clientNow: ago(0),
      });
      expect(cancelled.status).toBe(409);
      expect(cancelled.body).toMatchObject({
        error: "changed_since",
        event: { id, location: "ほかの端末の変更" },
      });
      expect((await call("GET", `/events/${id}`)).status).toBe(200);
      // 削除が後なら消える。
      expect(
        (await call("DELETE", `/events/${id}`, { deletedAt: ago(0) })).status,
      ).toBe(204);
      expect(
        (
          await call("PATCH", `/events/${id}`, {
            changes: { summary: "x" },
          })
        ).status,
      ).toBe(404);
      // 消えた予定の POST の再送では作り直さない。
      const resent = await call("POST", "/events", body);
      expect(resent.status).toBe(410);
      expect(resent.body).toEqual({ error: "gone" });
      expect((await call("GET", `/events/${id}`)).status).toBe(404);
      // 本文の無い DELETE と、読めない本文。
      const plain = await create();
      expect(
        (
          await app.request(`/calendars/events/${plain.id}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: "{",
          })
        ).status,
      ).toBe(400);
      expect((await call("DELETE", `/events/${plain.id}`)).status).toBe(204);
    });

    it("回の削除の時刻が原本の繰り返しの時刻になり、その後の規則の変更が通る。新しい例外への古い変更も通る", async () => {
      const master = await create({
        time: {
          allDay: false,
          startAt: "2027-03-01T10:00:00+09:00",
          endAt: "2027-03-01T11:00:00+09:00",
          startTimeZone: "Asia/Tokyo",
        },
        recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO" },
        changedAt: ago(60 * MIN),
      });
      const deletedAt = ago(30 * MIN);
      expect(
        (
          await call(
            "DELETE",
            `/events/${master.id}/occurrences/2027-03-08T01:00:00Z`,
            { changedAt: deletedAt, clientNow: ago(0) },
          )
        ).status,
      ).toBe(204);
      const after = (await call("GET", `/events/${master.id}`)).body
        .event as Json & { fieldUpdatedAt: Record<string, string> };
      expect(after.fieldUpdatedAt.recurrence).toBe(
        new Date(deletedAt).toISOString(),
      );
      expect(after.exdates).toEqual(["2027-03-08T01:00:00Z"]);
      const rule = await call("PATCH", `/events/${master.id}`, {
        changes: {
          recurrence: {
            rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10",
            exdates: ["2027-03-08T01:00:00Z"],
          },
        },
        changedAt: { recurrence: ago(10 * MIN) },
      });
      expect(rule.body.rejected).toEqual([]);

      // 原本の題が後から変わっていても、その前に行ったこの回の変更は通る。
      await call("PATCH", `/events/${master.id}`, {
        changes: { summary: "原本の新しい題" },
        changedAt: { summary: ago(MIN) },
      });
      const occurrence = await call(
        "PATCH",
        `/events/${master.id}/occurrences/2027-03-15T01:00:00Z`,
        {
          changes: { summary: "この回だけ" },
          changedAt: { summary: ago(20 * MIN) },
        },
      );
      expect(occurrence.status).toBe(200);
      expect(occurrence.body.rejected).toEqual([]);
      expect(occurrence.body.event).toMatchObject({ summary: "この回だけ" });

      // その回が消した後に変わっていれば、回の削除は changed_since。
      const late = await call(
        "DELETE",
        `/events/${master.id}/occurrences/2027-03-15T01:00:00Z`,
        { changedAt: ago(40 * MIN) },
      );
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({
        error: "changed_since",
        event: { summary: "この回だけ" },
      });
    });

    it("差分同期に、反映されなかった変更の件数と最新の時刻が載る", async () => {
      const empty = await call("GET", "/sync?since=0&limit=1");
      expect(empty.body).toMatchObject({ openConflicts: 0, conflictsAt: null });
      const [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "owner@example.com"));
      const createdAt = new Date("2026-11-20T00:00:00.000Z");
      await db.insert(eventConflicts).values([
        {
          userId: owner?.id as string,
          calendarId: offlineCalendarId,
          eventId: randomUUID(),
          kind: "field_lost",
          createdAt,
        },
        {
          userId: owner?.id as string,
          calendarId: offlineCalendarId,
          eventId: randomUUID(),
          kind: "write_failed",
          createdAt: new Date("2026-11-21T00:00:00.000Z"),
          resolvedAt: new Date(),
        },
      ]);
      const listed = await call("GET", "/sync?since=0&limit=1");
      expect(listed.body).toMatchObject({
        openConflicts: 1,
        conflictsAt: createdAt.toISOString(),
      });
      await db.delete(eventConflicts);
    });
  });

  describe("招待と出欠 (段取り 8)", () => {
    let ownerId: string;
    let inviteAccountId: string;
    /** Google (scheduling: server)。 */
    let googleId: string;
    /** 招待を自分で送らない CalDAV (scheduling: none)。 */
    let caldavNoneId: string;
    /** 招待を自分で送る CalDAV (scheduling: server)。 */
    let caldavServerId: string;
    /** 読み取り専用 (購読)。 */
    let feedId: string;
    let localId: string;
    let inviteApp: Hono<AppEnv>;
    const send = (method: string, path: string, body?: unknown) =>
      call(method, path, body, inviteApp);
    const MIN = 60_000;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    type Person = {
      email: string;
      self?: boolean;
      status?: "needs_action" | "accepted" | "declined" | "tentative";
    };

    /** 予定を直接入れる (同期で取り込んだ行の代わり)。 */
    const seedEvent = async (input: {
      calendarId: string;
      organizer: { email: string; self?: boolean } | null;
      attendees: Person[];
      status?: "confirmed" | "cancelled";
      summary?: string;
      rrule?: string;
    }) => {
      const id = randomUUID();
      const [row] = await db
        .insert(events)
        .values({
          id,
          userId: ownerId,
          calendarId: input.calendarId,
          uid: `${id}@remote`,
          remoteId: `remote-${id}`,
          etag: '"e1"',
          summary: input.summary ?? "招待",
          status: input.status ?? "confirmed",
          startAt: new Date("2027-03-01T01:00:00Z"),
          endAt: new Date("2027-03-01T02:00:00Z"),
          startTimeZone: "Asia/Tokyo",
          endTimeZone: "Asia/Tokyo",
          rrule: input.rrule ?? null,
          organizer: input.organizer,
          fieldUpdatedAt: {},
        })
        .returning();
      if (!row) throw new Error("予定を作れませんでした。");
      if (input.attendees.length > 0) {
        await db.insert(eventAttendees).values(
          input.attendees.map((person) => ({
            eventId: id,
            email: person.email,
            status: person.status ?? "needs_action",
            self: person.self ?? false,
          })),
        );
      }
      return row;
    };
    const invitation = (calendarId = googleId) =>
      seedEvent({
        calendarId,
        organizer: { email: "boss@example.com", self: false },
        attendees: [
          { email: "boss@example.com", status: "accepted" },
          { email: "invitee@gmail.com", self: true },
        ],
      });
    const queuedFor = (eventId: string) =>
      db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.accountId, inviteAccountId),
            sql`${outbox.payload}->>'eventId' = ${eventId}`,
          ),
        )
        .orderBy(asc(outbox.createdAt), asc(outbox.id));
    /** 参加者の [アドレス, 出欠, self] (アドレス順。行の順番は決まっていないため)。 */
    const attendeesOf = (body: Json) =>
      ((body.event as Json).attendees as Json[])
        .map((item) => [item.email, item.status, item.self])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    beforeAll(async () => {
      const [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "owner@example.com"));
      ownerId = owner?.id as string;
      const [account] = await db
        .insert(accounts)
        .values({
          userId: ownerId,
          email: "invitee@gmail.com",
          provider: "gmail",
          authType: "oauth2",
          username: "invitee@gmail.com",
          credentialsEncrypted: "x",
          calendarEnabled: true,
        })
        .returning({ id: accounts.id });
      inviteAccountId = account?.id as string;
      const insertCalendar = async (
        values: Partial<typeof calendars.$inferInsert>,
      ) => {
        const [row] = await db
          .insert(calendars)
          .values({
            userId: ownerId,
            accountId: inviteAccountId,
            name: "カレンダー",
            source: "google",
            ...values,
          })
          .returning({ id: calendars.id });
        return row?.id as string;
      };
      googleId = await insertCalendar({ source: "google", remoteId: "inv" });
      caldavNoneId = await insertCalendar({
        source: "caldav",
        remoteId: "https://dav.example.com/none/",
        providerState: { syncCollection: true, autoSchedule: false },
      });
      caldavServerId = await insertCalendar({
        source: "caldav",
        remoteId: "https://dav.example.com/server/",
        providerState: { autoSchedule: true },
      });
      feedId = await insertCalendar({
        source: "ics",
        accountId: null,
        readOnly: true,
      });
      localId = await insertCalendar({ source: "local", accountId: null });
      inviteApp = new Hono<AppEnv>();
      inviteApp.use(async (c, next) => {
        c.set("user", {
          id: ownerId,
          email: "owner@example.com",
          name: "owner",
        });
        await next();
      });
      inviteApp.route(
        "/calendars",
        calendarRoutes({ db, writebackSources: ["google", "caldav"] }),
      );
    });

    it("カレンダーの応答に scheduling が入る", async () => {
      const list = await send("GET", "");
      const byId = new Map(
        (list.body.calendars as Json[]).map((row) => [row.id, row.scheduling]),
      );
      expect(byId.get(googleId)).toBe("server");
      expect(byId.get(caldavServerId)).toBe("server");
      expect(byId.get(caldavNoneId)).toBe("none");
      expect(byId.get(feedId)).toBe("none");
      expect(byId.get(localId)).toBe("none");
    });

    it("返事: 自分の行だけが変わり、outbox に 1 行。再送では増えず、古い返事は applied: false", async () => {
      const row = await invitation();
      const respondedAt = ago(MIN);
      const body = { status: "accepted", respondedAt };
      const first = await send("POST", `/events/${row.id}/respond`, body);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        applied: true,
        notifiesOrganizer: true,
      });
      expect(attendeesOf(first.body)).toEqual([
        ["boss@example.com", "accepted", false],
        ["invitee@gmail.com", "accepted", true],
      ]);
      expect(
        ((first.body.event as Json).fieldUpdatedAt as Json).myResponse,
      ).toBe(new Date(respondedAt).toISOString());
      const queued = await queuedFor(row.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        kind: "event_respond",
        idempotencyKey: `event_respond:${row.id}:accepted:${respondedAt}`,
        payload: {
          eventId: row.id,
          calendarId: googleId,
          status: "accepted",
          comment: null,
          target: {
            eventId: row.id,
            remoteId: row.remoteId,
            etag: row.etag,
            uid: row.uid,
            recurrenceId: null,
            parentRemoteId: null,
          },
        },
      });

      // 同じ要求の再送。
      const again = await send("POST", `/events/${row.id}/respond`, body);
      expect(again.status).toBe(200);
      expect(again.body.applied).toBe(false);
      expect(await queuedFor(row.id)).toHaveLength(1);

      // 先に (端末で) 行った別の返事が後から届いた。
      const older = await send("POST", `/events/${row.id}/respond`, {
        status: "declined",
        respondedAt: ago(5 * MIN),
      });
      expect(older.body.applied).toBe(false);
      expect(attendeesOf(older.body)[1]).toEqual([
        "invitee@gmail.com",
        "accepted",
        true,
      ]);
      expect(await queuedFor(row.id)).toHaveLength(1);

      // 返事を変える (新しい要求)。コメントも付ける。
      const changed = await send("POST", `/events/${row.id}/respond`, {
        status: "declined",
        comment: "出張中です",
        respondedAt: ago(0),
      });
      expect(changed.body.applied).toBe(true);
      expect(attendeesOf(changed.body)[1]?.[1]).toBe("declined");
      const [mine] = await db
        .select({ comment: eventAttendees.comment })
        .from(eventAttendees)
        .where(
          and(
            eq(eventAttendees.eventId, row.id),
            eq(eventAttendees.self, true),
          ),
        );
      expect(mine?.comment).toBe("出張中です");
      expect(await queuedFor(row.id)).toHaveLength(2);
    });

    it("時計が 1 時間進んだ端末の、先に行った返事は後の返事に負ける (clientNow で補正)", async () => {
      const row = await invitation();
      const now = await send("POST", `/events/${row.id}/respond`, {
        status: "accepted",
        respondedAt: new Date().toISOString(),
      });
      expect(now.body.applied).toBe(true);
      const ahead = Date.now() + 60 * MIN;
      // 端末の時計では「2 分前」に返事をした (補正しなければ未来 = いまに丸められて勝ってしまう)。
      const skewed = await send("POST", `/events/${row.id}/respond`, {
        status: "declined",
        respondedAt: new Date(ahead - 2 * MIN).toISOString(),
        clientNow: new Date(ahead).toISOString(),
      });
      expect(skewed.body.applied).toBe(false);
      expect(attendeesOf(skewed.body)[1]?.[1]).toBe("accepted");
    });

    it("返事を断る: ほかの利用者の予定、参加者でない、主催者、取り消し済み、読み取り専用、同期が止まっている", async () => {
      const respond = (id: string, target: Hono<AppEnv> = inviteApp) =>
        call(
          "POST",
          `/events/${id}/respond`,
          { status: "accepted", respondedAt: ago(0) },
          target,
        );
      const invited = await invitation();
      expect((await respond(invited.id, otherApp)).status).toBe(404);
      expect((await respond(randomUUID())).status).toBe(404);

      const shared = await seedEvent({
        calendarId: googleId,
        organizer: { email: "boss@example.com", self: false },
        attendees: [{ email: "someone@example.com" }],
      });
      expect(await respond(shared.id)).toMatchObject({
        status: 409,
        body: { error: "not_attendee" },
      });

      const mine = await seedEvent({
        calendarId: googleId,
        organizer: { email: "invitee@gmail.com", self: true },
        attendees: [
          { email: "invitee@gmail.com", self: true, status: "accepted" },
          { email: "bob@example.com" },
        ],
      });
      expect(await respond(mine.id)).toMatchObject({
        status: 409,
        body: { error: "organizer" },
      });

      const cancelled = await seedEvent({
        calendarId: googleId,
        status: "cancelled",
        organizer: { email: "boss@example.com", self: false },
        attendees: [{ email: "invitee@gmail.com", self: true }],
      });
      expect(await respond(cancelled.id)).toMatchObject({
        status: 409,
        body: { error: "cancelled" },
      });

      const readOnly = await invitation(feedId);
      expect(await respond(readOnly.id)).toMatchObject({
        status: 409,
        body: { error: "read_only" },
      });

      await db
        .update(accounts)
        .set({ calendarError: "認証が切れました" })
        .where(eq(accounts.id, inviteAccountId));
      try {
        expect(await respond(invited.id)).toMatchObject({
          status: 409,
          body: { error: "calendar_sync_stopped" },
        });
      } finally {
        await db
          .update(accounts)
          .set({ calendarError: null })
          .where(eq(accounts.id, inviteAccountId));
      }
      // どれも何も積まない。
      for (const id of [invited.id, shared.id, mine.id, cancelled.id]) {
        expect(await queuedFor(id)).toEqual([]);
      }
    });

    it("招待を送らない CalDAV では、記録はするが主催者に届かないことを返す", async () => {
      const row = await invitation(caldavNoneId);
      const result = await send("POST", `/events/${row.id}/respond`, {
        status: "tentative",
        respondedAt: ago(0),
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        applied: true,
        notifiesOrganizer: false,
      });
      expect(attendeesOf(result.body)[1]?.[1]).toBe("tentative");
      // 自分のカレンダー (CalDAV サーバー) の PARTSTAT は書き戻す。
      expect(await queuedFor(row.id)).toHaveLength(1);
    });

    it("主催者の印の無い古い行は、アカウントのアドレスとの比較で補う", async () => {
      const legacy = await seedEvent({
        calendarId: googleId,
        organizer: { email: "Invitee@Gmail.com" },
        attendees: [
          { email: "invitee@gmail.com", self: true, status: "accepted" },
          { email: "bob@example.com" },
        ],
      });
      const got = await send("GET", `/events/${legacy.id}`);
      expect((got.body.event as Json).organizer).toEqual({
        email: "Invitee@Gmail.com",
        self: true,
      });
      const other = await invitation();
      expect(
        ((await send("GET", `/events/${other.id}`)).body.event as Json)
          .organizer,
      ).toEqual({ email: "boss@example.com", self: false });
      expect(
        (
          await send("POST", `/events/${legacy.id}/respond`, {
            status: "declined",
            respondedAt: ago(0),
          })
        ).body,
      ).toEqual({ error: "organizer" });
    });

    it("参加者の変更: 主催者は通る。参加者は not_organizer。status と self は無視する", async () => {
      const mine = await seedEvent({
        calendarId: googleId,
        organizer: { email: "invitee@gmail.com", self: true },
        attendees: [
          { email: "invitee@gmail.com", self: true, status: "accepted" },
          { email: "bob@example.com", status: "accepted" },
        ],
      });
      const changed = await send("PATCH", `/events/${mine.id}`, {
        changes: {
          attendees: [
            { email: "invitee@gmail.com" },
            { email: "Bob@Example.com" },
            {
              email: "Carol@Example.com",
              name: "Carol",
              status: "accepted",
              self: true,
            },
          ],
        },
      });
      expect(changed.status).toBe(200);
      expect(attendeesOf(changed.body)).toEqual([
        ["bob@example.com", "accepted", false],
        ["carol@example.com", "needs_action", false],
        ["invitee@gmail.com", "accepted", true],
      ]);
      expect((await queuedFor(mine.id)).map((row) => row.kind)).toEqual([
        "event_update",
      ]);

      const invited = await invitation();
      expect(
        await send("PATCH", `/events/${invited.id}`, {
          changes: { attendees: [{ email: "x@example.com" }] },
        }),
      ).toMatchObject({ status: 409, body: { error: "not_organizer" } });
      const shared = await seedEvent({
        calendarId: googleId,
        organizer: { email: "boss@example.com", self: false },
        attendees: [{ email: "someone@example.com" }],
      });
      expect(
        await send("PATCH", `/events/${shared.id}`, {
          changes: { attendees: [] },
        }),
      ).toMatchObject({ status: 409, body: { error: "not_organizer" } });
      expect(await queuedFor(invited.id)).toEqual([]);
    });

    it("招待された予定は、通知と予定あり / 空きだけ変えられる (同じ値の項目は無視する)", async () => {
      const invited = await invitation();
      expect(
        await send("PATCH", `/events/${invited.id}`, {
          changes: { summary: "自分用の題" },
        }),
      ).toMatchObject({ status: 409, body: { error: "not_organizer" } });
      const allowed = await send("PATCH", `/events/${invited.id}`, {
        changes: {
          // 画面が全項目を送ってきても、いまと同じ値の項目は変えようとしていないものとして扱う。
          summary: "招待",
          busy: false,
          useDefaultReminders: false,
          reminders: [{ method: "display", minutes: 15 }],
        },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body.event).toMatchObject({
        summary: "招待",
        busy: false,
        reminders: [{ method: "display", minutes: 15 }],
      });
      const [queued] = await queuedFor(invited.id);
      expect((queued?.payload as Json).fields).toEqual([
        "busy",
        "reminders",
        "useDefaultReminders",
      ]);
    });

    it("回の変更でも同じ決まり。断ったときは例外の行を作らない", async () => {
      const series = await seedEvent({
        calendarId: googleId,
        organizer: { email: "boss@example.com", self: false },
        attendees: [{ email: "invitee@gmail.com", self: true }],
        rrule: "FREQ=DAILY;COUNT=5",
      });
      const refused = await send(
        "PATCH",
        `/events/${series.id}/occurrences/2027-03-02T01:00:00Z`,
        { changes: { location: "別の部屋" } },
      );
      expect(refused).toMatchObject({
        status: 409,
        body: { error: "not_organizer" },
      });
      expect(
        await db.select().from(events).where(eq(events.parentId, series.id)),
      ).toEqual([]);
      const allowed = await send(
        "PATCH",
        `/events/${series.id}/occurrences/2027-03-02T01:00:00Z`,
        { changes: { busy: false } },
      );
      expect(allowed.status).toBe(200);
    });

    it("招待を送れないカレンダー: 参加者を足すのは no_scheduling、外すのは通る", async () => {
      const mine = await seedEvent({
        calendarId: caldavNoneId,
        organizer: { email: "invitee@gmail.com", self: true },
        attendees: [
          { email: "invitee@gmail.com", self: true, status: "accepted" },
          { email: "bob@example.com" },
          { email: "carol@example.com" },
        ],
      });
      expect(
        await send("PATCH", `/events/${mine.id}`, {
          changes: {
            attendees: [
              { email: "invitee@gmail.com" },
              { email: "bob@example.com" },
              { email: "carol@example.com" },
              { email: "dave@example.com" },
            ],
          },
        }),
      ).toMatchObject({ status: 409, body: { error: "no_scheduling" } });
      const fewer = await send("PATCH", `/events/${mine.id}`, {
        changes: {
          attendees: [
            { email: "invitee@gmail.com" },
            { email: "bob@example.com" },
          ],
        },
      });
      expect(fewer.status).toBe(200);
      const emptied = await send("PATCH", `/events/${mine.id}`, {
        changes: { attendees: [] },
      });
      expect(emptied.status).toBe(200);
      expect((emptied.body.event as Json).attendees).toEqual([]);

      // 作成も同じ。Orbit 内のカレンダーも送れない。
      for (const calendarId of [caldavNoneId, localId]) {
        expect(
          await send("POST", "/events", {
            calendarId,
            summary: "会議",
            time: {
              allDay: false,
              startAt: "2027-03-05T10:00:00+09:00",
              endAt: "2027-03-05T11:00:00+09:00",
              startTimeZone: "Asia/Tokyo",
            },
            attendees: [{ email: "bob@example.com" }],
          }),
        ).toMatchObject({ status: 409, body: { error: "no_scheduling" } });
      }
    });

    it("招待を送れるカレンダーで参加者付きで作ると、自分を仮の主催者にする", async () => {
      for (const calendarId of [googleId, caldavServerId]) {
        const created = await send("POST", "/events", {
          calendarId,
          summary: "会議",
          time: {
            allDay: false,
            startAt: "2027-03-05T10:00:00+09:00",
            endAt: "2027-03-05T11:00:00+09:00",
            startTimeZone: "Asia/Tokyo",
          },
          attendees: [
            { email: "Alice@Example.com", name: "Alice", status: "accepted" },
          ],
        });
        expect(created.status).toBe(201);
        expect(created.body.event).toMatchObject({
          organizer: { email: "invitee@gmail.com", self: true },
          attendees: [
            {
              email: "alice@example.com",
              name: "Alice",
              status: "needs_action",
              self: false,
            },
          ],
        });
      }
      // 参加者の無い予定には主催者を入れない。
      const plain = await send("POST", "/events", {
        calendarId: googleId,
        summary: "ひとり",
        time: { allDay: true, startDate: "2027-03-06", endDate: "2027-03-07" },
      });
      expect((plain.body.event as Json).organizer).toBeNull();
    });
  });
});
