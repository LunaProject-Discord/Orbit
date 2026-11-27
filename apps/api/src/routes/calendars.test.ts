/**
 * 予定の API (/v1/calendars) を、実際の PostgreSQL で確かめる。
 * DATABASE_URL が無い環境では実行しない。接続先に確認用の DB を作り、終わったら消す。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calendars, createDb, type Database, users } from "@orbit/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../context.js";
import { calendarRoutes, mergeFields } from "./calendars.js";

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
    if (!user || !other) throw new Error("利用者を作れませんでした。");
    const [holidays] = await db
      .insert(calendars)
      .values({ userId: user.id, source: "holidays", name: "日本の祝日" })
      .returning({ id: calendars.id });
    readOnlyId = holidays?.id as string;

    const build = (id: string, email: string) => {
      const target = new Hono<AppEnv>();
      target.use(async (c, next) => {
        c.set("user", { id, email, name: email });
        await next();
      });
      target.route("/calendars", calendarRoutes({ db }));
      return target;
    };
    app = build(user.id, "owner@example.com");
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
    const others = await call("GET", "", undefined, otherApp);
    expect(others.body.calendars).toEqual([]);
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
      attendees: [{ email: "Alice@Example.com", name: "Alice" }],
    });
    expect(timed.status).toBe(201);
    const event = timed.body.event as Json;
    expect(event).toMatchObject({
      summary: "定例会議",
      startAt: "2026-12-01T01:00:00.000Z",
      reminders: [{ method: "display", minutes: 10 }],
      attendees: [
        { email: "alice@example.com", status: "needs_action", self: false },
      ],
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

    const others = await call("GET", "/sync?since=0", undefined, otherApp);
    expect(others.body.events).toEqual([]);
    expect(others.body.calendars).toEqual([]);
  });

  it("カレンダーを消すと予定も消える", async () => {
    expect((await call("DELETE", `/${readOnlyId}`)).status).toBe(409);
    expect(
      (await call("DELETE", `/${calendarId}`, undefined, otherApp)).status,
    ).toBe(404);
    expect((await call("DELETE", `/${calendarId}`)).status).toBe(204);
    expect((await range("2026-11-29", "2027-01-01")).occurrences).toEqual([]);
  });
});
