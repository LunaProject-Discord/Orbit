import {
  googleCalendarChannelToken,
  googleCalendarWebhookUrl,
  verifyGoogleCalendarChannelToken,
} from "@orbit/core";
import { describe, expect, it } from "vitest";
import {
  CalendarAuthError,
  type CalendarPushState,
  type CalendarRow,
  CalendarTransientError,
} from "../provider.js";
import {
  describeCalendarProviderContract,
  makeCalendarRow,
  makeEventSnapshot,
  makeProviderContext,
  readAllPages,
} from "../testing/provider-contract.js";
import {
  BIRTHDAYS_REMOTE_ID,
  googleEventIdFor,
  parseGoogleRaw,
} from "./convert.js";
import { error, FakeGoogleCalendar } from "./fake-google.js";
import { createGoogleProvider } from "./index.js";

const PRIMARY = "me@example.com";

function setup() {
  const server = new FakeGoogleCalendar();
  server.calendars = [
    {
      id: PRIMARY,
      summary: PRIMARY,
      timeZone: "Asia/Tokyo",
      backgroundColor: "#9FE1E7",
      accessRole: "owner",
      primary: true,
      defaultReminders: [{ method: "popup", minutes: 10 }],
    },
    {
      id: "ja.japanese#holiday@group.v.calendar.google.com",
      summary: "日本の祝日",
      timeZone: "Asia/Tokyo",
      accessRole: "reader",
    },
    {
      id: "addressbook#contacts@group.v.calendar.google.com",
      summary: "Birthdays",
      accessRole: "reader",
    },
  ];
  const saved: { calendarId: string; state: CalendarPushState }[] = [];
  const logs: string[] = [];
  const ctx = makeProviderContext({
    fetchFn: server.fetch,
    log: (message) => logs.push(message),
    saveCalendarState: async (calendarId, state) => {
      saved.push({ calendarId, state });
    },
  });
  const provider = createGoogleProvider();
  const calendar = makeCalendarRow({
    remoteId: PRIMARY,
    timeZone: "Asia/Tokyo",
  });
  return { server, ctx, provider, calendar, saved, logs };
}

describeCalendarProviderContract(
  "Google",
  () => {
    const { server, ctx, provider, calendar } = setup();
    server.put(PRIMARY, {
      id: "single1",
      summary: "単発",
      start: { dateTime: "2026-12-01T10:00:00+09:00" },
      end: { dateTime: "2026-12-01T11:00:00+09:00" },
    });
    server.put(PRIMARY, {
      id: "weekly1",
      summary: "毎週",
      start: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-01T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    server.put(PRIMARY, {
      id: "weekly1_20261208T010000Z",
      recurringEventId: "weekly1",
      iCalUID: "weekly1@google.com",
      originalStartTime: { dateTime: "2026-12-08T10:00:00+09:00" },
      summary: "この回だけ",
      start: { dateTime: "2026-12-08T13:00:00+09:00" },
      end: { dateTime: "2026-12-08T14:00:00+09:00" },
    });
    server.put(PRIMARY, {
      id: "weekly1_20261215T010000Z",
      recurringEventId: "weekly1",
      originalStartTime: { dateTime: "2026-12-15T01:00:00Z" },
      status: "cancelled",
    });
    return { provider, ctx, calendar };
  },
  { writable: true, conflicts: true },
);

describe("Google のカレンダー一覧", () => {
  it("一覧を変換し、primary の誕生日を読み取り専用のカレンダーとして足す", async () => {
    const { provider, ctx } = setup();
    const list = await provider.listCalendars(ctx);
    expect(list.map((item) => item.remoteId)).toEqual([
      PRIMARY,
      "ja.japanese#holiday@group.v.calendar.google.com",
      BIRTHDAYS_REMOTE_ID,
    ]);
    const [primary, holiday, birthdays] = list;
    expect(primary).toMatchObject({
      name: PRIMARY,
      color: "#9fe1e7",
      readOnly: false,
      kind: "normal",
      defaultReminders: [{ method: "display", minutes: 10 }],
    });
    expect(holiday?.readOnly).toBe(true);
    expect(birthdays).toMatchObject({
      name: "誕生日",
      readOnly: true,
      kind: "birthdays",
      timeZone: "Asia/Tokyo",
    });
  });
});

describe("Google の差分同期", () => {
  it("繰り返しの原本、変えた回、取り消した回を recurrenceId の書き方に変換する", async () => {
    const { server, provider, ctx, calendar } = setup();
    server.put(PRIMARY, {
      id: "m1",
      summary: "定例",
      start: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-01T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: [
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
        "EXDATE;TZID=Asia/Tokyo:20261222T100000",
      ],
    });
    server.put(PRIMARY, {
      id: "m1_20261208T010000Z",
      recurringEventId: "m1",
      iCalUID: "m1@google.com",
      originalStartTime: {
        dateTime: "2026-12-08T10:00:00+09:00",
        timeZone: "Asia/Tokyo",
      },
      summary: "定例 (場所変更)",
      location: "会議室 B",
      start: { dateTime: "2026-12-08T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-08T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    });
    server.put(PRIMARY, {
      id: "m1_20261215T010000Z",
      recurringEventId: "m1",
      originalStartTime: { dateTime: "2026-12-15T10:00:00+09:00" },
      status: "cancelled",
    });
    server.put(PRIMARY, {
      id: "allday",
      summary: "終日",
      start: { date: "2026-12-24" },
      end: { date: "2026-12-25" },
      transparency: "transparent",
      reminders: {
        useDefault: false,
        overrides: [{ method: "email", minutes: 60 }],
      },
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "accepted" },
        { email: "a@example.com", displayName: "A", optional: true },
      ],
      organizer: { email: "boss@example.com", displayName: "上司" },
      hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
    });
    const { pages, events } = await readAllPages(provider, ctx, calendar, null);
    expect(pages.at(-1)?.nextSyncToken).toBe(server.syncToken());
    const byId = new Map(events.map((event) => [event.remoteId, event]));
    expect(byId.get("m1")).toMatchObject({
      uid: "m1@google.com",
      recurrenceId: null,
      parentRemoteId: null,
      rrule: "FREQ=WEEKLY;BYDAY=TU",
      exdates: ["2026-12-22T01:00:00Z"],
      startAt: "2026-12-01T01:00:00Z",
      startTimeZone: "Asia/Tokyo",
    });
    expect(byId.get("m1_20261208T010000Z")).toMatchObject({
      uid: "m1@google.com",
      recurrenceId: "2026-12-08T01:00:00Z",
      parentRemoteId: "m1",
      location: "会議室 B",
      rrule: null,
    });
    const cancelled = byId.get("m1_20261215T010000Z");
    expect(cancelled).toMatchObject({
      recurrenceId: "2026-12-15T01:00:00Z",
      parentRemoteId: "m1",
      status: "cancelled",
    });
    expect(cancelled?.uid ?? null).toBeNull();
    expect(byId.get("allday")).toMatchObject({
      allDay: true,
      startDate: "2026-12-24",
      endDate: "2026-12-25",
      busy: false,
      reminders: [{ method: "email", minutes: 60 }],
      conferenceUrl: "https://meet.google.com/aaa-bbbb-ccc",
      organizer: { email: "boss@example.com", name: "上司" },
      attendees: [
        {
          email: "me@example.com",
          status: "accepted",
          role: "required",
          self: true,
        },
        {
          email: "a@example.com",
          name: "A",
          status: "needs_action",
          role: "optional",
          self: false,
        },
      ],
    });
    // raw は Google の JSON そのまま。
    expect(parseGoogleRaw(byId.get("allday")?.raw ?? null)?.hangoutLink).toBe(
      "https://meet.google.com/aaa-bbbb-ccc",
    );
  });

  it("syncToken で差分を取り、削除を deletedRemoteIds にする。誕生日は primary から外す", async () => {
    const { server, provider, ctx, calendar } = setup();
    server.put(PRIMARY, {
      id: "a1",
      summary: "A",
      start: { date: "2026-12-01" },
      end: { date: "2026-12-02" },
    });
    server.put(PRIMARY, {
      id: "bd1",
      eventType: "birthday",
      summary: "花子の誕生日",
      start: { date: "2026-05-01" },
      end: { date: "2026-05-02" },
      recurrence: ["RRULE:FREQ=YEARLY"],
    });
    const first = await readAllPages(provider, ctx, calendar, null);
    expect(first.events.map((event) => event.remoteId)).toEqual(["a1"]);
    const token = first.pages.at(-1)?.nextSyncToken ?? null;
    server.put(PRIMARY, {
      id: "a2",
      summary: "B",
      start: { date: "2026-12-03" },
      end: { date: "2026-12-04" },
    });
    server.put(PRIMARY, {
      ...(server.get(PRIMARY, "a1") as { id: string }),
      status: "cancelled",
    });
    const delta = await provider.syncEvents(ctx, calendar, {
      syncToken: token,
      pageCursor: null,
      knownEtags: async () => new Map(),
      knownEvents: async () => new Map(),
    });
    expect(delta.full).toBe(false);
    expect(delta.events.map((event) => event.remoteId)).toEqual(["a2"]);
    expect(delta.deletedRemoteIds).toEqual(["a1"]);

    // 誕生日のカレンダーは primary を eventTypes=birthday で読む。
    const birthdays = makeCalendarRow({
      remoteId: BIRTHDAYS_REMOTE_ID,
      timeZone: "Asia/Tokyo",
    });
    const bd = await readAllPages(provider, ctx, birthdays, null);
    expect(bd.events.map((event) => [event.remoteId, event.rrule])).toEqual([
      ["bd1", "FREQ=YEARLY"],
    ]);
    const listed = server.requests.at(-1);
    expect(listed?.url.pathname).toContain(`/calendars/primary/events`);
    expect(listed?.url.searchParams.getAll("eventTypes")).toEqual(["birthday"]);
    // 誕生日のカレンダーには書き込めない。
    const write = await provider.createEvent(ctx, birthdays, {
      event: makeEventSnapshot(),
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(write.status).toBe("rejected");
  });

  it("410 なら全件から取り直し、ページの続きは同じ条件で読む", async () => {
    const { server, provider, ctx, calendar } = setup();
    for (let index = 0; index < 5; index++) {
      server.put(PRIMARY, {
        id: `ev${index}`,
        summary: `${index}`,
        start: { date: "2026-12-01" },
        end: { date: "2026-12-02" },
      });
    }
    const pages = [];
    let pageCursor: string | null = null;
    // ページを小さくするため、maxResults を書き換える fetch を挟む。
    const small = makeProviderContext({
      ...ctx,
      fetchFn: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/events"))
          url.searchParams.set("maxResults", "2");
        return server.fetch(url.toString(), init);
      },
    });
    do {
      const delta = await provider.syncEvents(small, calendar, {
        syncToken: "broken",
        pageCursor,
        knownEtags: async () => new Map(),
        knownEvents: async () => new Map(),
      });
      pages.push(delta);
      pageCursor = delta.nextPageCursor;
    } while (pageCursor);
    expect(pages).toHaveLength(3);
    expect(pages.every((page) => page.full)).toBe(true);
    expect(
      pages.slice(0, -1).every((page) => page.nextSyncToken === null),
    ).toBe(true);
    expect(pages.at(-1)?.nextSyncToken).toBe(server.syncToken());
    expect(
      pages.flatMap((page) => page.events).map((event) => event.remoteId),
    ).toEqual(["ev0", "ev1", "ev2", "ev3", "ev4"]);
    // 2 ページ目からは syncToken を付けない (全件のやり直しの続き)。
    const lists = server.requests.filter((request) =>
      request.url.pathname.endsWith("/events"),
    );
    expect(lists[0]?.url.searchParams.get("syncToken")).toBe("broken");
    expect(
      lists
        .slice(1)
        .every((request) => !request.url.searchParams.has("syncToken")),
    ).toBe(true);
  });
});

describe("Google への書き込み", () => {
  it("作成は events.id から決まる base32hex の ID で行い、本文を Google の形にする", async () => {
    const { server, provider, ctx, calendar } = setup();
    const snapshot = makeEventSnapshot({
      id: "0193a7c2-1111-7abc-8def-0123456789ab",
      summary: "打ち合わせ",
      location: "本社",
      rrule: "FREQ=DAILY;COUNT=3",
      exdates: ["2026-12-11T01:00:00Z"],
      useDefaultReminders: false,
      reminders: [{ method: "display", minutes: 15 }],
      attendees: [
        {
          id: "x",
          eventId: "y",
          email: "a@example.com",
          name: "A",
          role: "optional",
          status: "needs_action",
          self: false,
        } as never,
      ],
    });
    const result = await provider.createEvent(ctx, calendar, {
      event: snapshot,
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(result.status).toBe("ok");
    const id = googleEventIdFor(snapshot.id);
    expect(id).toMatch(/^[0-9a-v]{26}$/);
    const insert = server.requests.find((request) => request.method === "POST");
    expect(insert?.url.searchParams.get("sendUpdates")).toBe("all");
    expect(insert?.body).toMatchObject({
      id,
      summary: "打ち合わせ",
      location: "本社",
      transparency: "opaque",
      start: { dateTime: "2026-12-10T01:00:00Z", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3", "EXDATE:20261211T010000Z"],
      reminders: {
        useDefault: false,
        overrides: [{ method: "popup", minutes: 15 }],
      },
      attendees: [
        {
          email: "a@example.com",
          displayName: "A",
          optional: true,
          responseStatus: "needsAction",
        },
      ],
    });
    if (result.status === "ok") {
      expect(result.events[0]).toMatchObject({
        remoteId: id,
        uid: `${id}@google.com`,
      });
    }
  });

  it("相手側で消された予定を同じ ID で作り直すと、消した予定を戻して上書きする", async () => {
    const { server, provider, ctx, calendar } = setup();
    const snapshot = makeEventSnapshot({ summary: "戻す" });
    const id = googleEventIdFor(snapshot.id);
    server.put(PRIMARY, { id, summary: "古い", status: "cancelled" });
    const result = await provider.createEvent(ctx, calendar, {
      event: snapshot,
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(result).toMatchObject({
      status: "ok",
      events: [{ remoteId: id, summary: "戻す", status: "confirmed" }],
    });
  });

  it("変更は変えた項目だけを If-Match 付きの PATCH で送り、知らない項目は残す", async () => {
    const { server, provider, ctx, calendar } = setup();
    const put = server.put(PRIMARY, {
      id: "ev",
      summary: "元",
      colorId: "5",
      start: { dateTime: "2026-12-01T10:00:00+09:00" },
      end: { dateTime: "2026-12-01T11:00:00+09:00" },
      attendees: [
        {
          email: "a@example.com",
          comment: "遅れます",
          responseStatus: "accepted",
        },
      ],
    });
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: "ev",
        etag: put.etag ?? null,
        uid: "ev@google.com",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          remoteId: "ev",
          etag: put.etag ?? null,
          uid: "ev@google.com",
          summary: "新",
          raw: JSON.stringify(put),
          attendees: [
            {
              email: "a@example.com",
              name: null,
              role: "required",
              status: "accepted",
              self: false,
            } as never,
            {
              email: "b@example.com",
              name: null,
              role: "required",
              status: "needs_action",
              self: false,
            } as never,
          ],
        }),
        master: null,
        exceptions: [],
        fields: ["summary", "attendees"],
      },
    );
    expect(result.status).toBe("ok");
    const patch = server.requests.find((request) => request.method === "PATCH");
    expect(patch?.headers.get("if-match")).toBe(put.etag);
    expect(Object.keys(patch?.body ?? {}).sort()).toEqual([
      "attendees",
      "summary",
    ]);
    expect(patch?.body?.attendees).toEqual([
      {
        email: "a@example.com",
        comment: "遅れます",
        responseStatus: "accepted",
      },
      { email: "b@example.com", responseStatus: "needsAction" },
    ]);
    expect(server.get(PRIMARY, "ev")?.colorId).toBe("5");
  });

  it("回の削除 (原本の exdates が増えた) は、その回の取り消しにする", async () => {
    const { server, provider, ctx, calendar } = setup();
    const master = server.put(PRIMARY, {
      id: "wk",
      summary: "毎日",
      start: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-01T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: "wk",
        etag: master.etag ?? null,
        uid: "wk@google.com",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          remoteId: "wk",
          etag: master.etag ?? null,
          uid: "wk@google.com",
          rrule: "FREQ=DAILY",
          exdates: ["2026-12-03T01:00:00Z"],
          raw: JSON.stringify(master),
        }),
        master: null,
        exceptions: [],
        fields: ["recurrence"],
      },
    );
    expect(result.status).toBe("ok");
    // 原本の recurrence は書き換えない (EXDATE を足さない)。
    expect(
      server.requests.some(
        (request) =>
          request.method === "PATCH" && request.url.pathname.endsWith("/wk"),
      ),
    ).toBe(false);
    expect(server.get(PRIMARY, "wk_20261203T010000Z")).toMatchObject({
      status: "cancelled",
      recurringEventId: "wk",
    });
    if (result.status === "ok") {
      expect(
        result.events.map((event) => [
          event.remoteId,
          event.recurrenceId,
          event.status,
        ]),
      ).toEqual([
        ["wk", null, "confirmed"],
        ["wk_20261203T010000Z", "2026-12-03T01:00:00Z", "cancelled"],
      ]);
    }
  });

  it("まだ相手側に無い回の変更は、その回を上書きして例外にする", async () => {
    const { server, provider, ctx, calendar } = setup();
    const master = server.put(PRIMARY, {
      id: "wk",
      summary: "毎日",
      start: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-01T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    const masterSnapshot = makeEventSnapshot({
      remoteId: "wk",
      uid: "wk@google.com",
      rrule: "FREQ=DAILY",
      raw: JSON.stringify(master),
    });
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: "wk",
        etag: null,
        uid: "wk@google.com",
        recurrenceId: "2026-12-04T01:00:00Z",
        parentRemoteId: "wk",
      },
      {
        event: makeEventSnapshot({
          uid: "wk@google.com",
          recurrenceId: "2026-12-04T01:00:00Z",
          parentId: masterSnapshot.id,
          summary: "この回は午後",
          startAt: new Date("2026-12-04T05:00:00Z"),
          endAt: new Date("2026-12-04T06:00:00Z"),
        }),
        master: masterSnapshot,
        exceptions: [],
        fields: ["summary", "time"],
      },
    );
    expect(result).toMatchObject({
      status: "ok",
      events: [
        {
          remoteId: "wk_20261204T010000Z",
          parentRemoteId: "wk",
          recurrenceId: "2026-12-04T01:00:00Z",
          summary: "この回は午後",
          startAt: "2026-12-04T05:00:00Z",
        },
      ],
    });
  });

  it("まだ相手側に無い回が見つからなくても、原本があれば rejected にし、原本も無ければ gone", async () => {
    const { server, provider, ctx, calendar } = setup();
    const master = server.put(PRIMARY, {
      id: "wk",
      summary: "毎週",
      start: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-12-01T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    const masterSnapshot = makeEventSnapshot({
      remoteId: "wk",
      uid: "wk@google.com",
      rrule: "FREQ=WEEKLY",
      raw: JSON.stringify(master),
    });
    // 2026-12-04 は毎週の回に当たらない。
    server.missingInstances.add("wk_20261204T010000Z");
    const ref = {
      remoteId: "wk",
      etag: null,
      uid: "wk@google.com",
      recurrenceId: "2026-12-04T01:00:00Z",
      parentRemoteId: "wk",
    };
    const write = {
      event: makeEventSnapshot({
        uid: "wk@google.com",
        recurrenceId: "2026-12-04T01:00:00Z",
        parentId: masterSnapshot.id,
        summary: "この回だけ",
      }),
      master: masterSnapshot,
      exceptions: [],
      fields: ["summary"],
    };
    const result = await provider.updateEvent(ctx, calendar, ref, write);
    expect(result).toEqual({
      status: "rejected",
      reason: "その回が相手側にありません。",
    });

    // 原本が削除済み (cancelled) なら gone。
    server.put(PRIMARY, { ...master, status: "cancelled" });
    const gone = await provider.updateEvent(ctx, calendar, ref, write);
    expect(gone).toEqual({ status: "gone" });

    // 原本が 404 でも gone。
    const missing = await provider.updateEvent(
      ctx,
      calendar,
      { ...ref, remoteId: "nope", parentRemoteId: "nope" },
      write,
    );
    expect(missing).toEqual({ status: "gone" });
  });

  it("出欠は attendeesOmitted で自分の返事だけを書く", async () => {
    const { server, provider, ctx, calendar } = setup();
    server.put(PRIMARY, {
      id: "inv",
      summary: "招待",
      start: { date: "2026-12-01" },
      end: { date: "2026-12-02" },
      attendees: [
        {
          email: "boss@example.com",
          organizer: true,
          responseStatus: "accepted",
        },
        { email: "me@example.com", self: true, responseStatus: "needsAction" },
      ],
    });
    const result = await provider.respond(
      ctx,
      calendar,
      {
        remoteId: "inv",
        etag: null,
        uid: "inv@google.com",
        recurrenceId: null,
        parentRemoteId: null,
      },
      { status: "declined", comment: "出張中です" },
    );
    expect(result.status).toBe("ok");
    const patch = server.requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({
      attendeesOmitted: true,
      attendees: [
        {
          email: "me@example.com",
          responseStatus: "declined",
          comment: "出張中です",
        },
      ],
    });
    if (result.status === "ok") {
      expect(
        result.events[0]?.attendees.find((attendee) => attendee.self)?.status,
      ).toBe("declined");
    }
  });
});

describe("Google の失敗の扱い", () => {
  it("401 なら一度トークンを取り直し、それでも 401 なら再ログインを求める", async () => {
    const { server, provider, calendar } = setup();
    const forced: boolean[] = [];
    const ctx = makeProviderContext({
      fetchFn: server.fetch,
      auth: {
        type: "oauth2",
        getAccessToken: async (force) => {
          forced.push(force === true);
          return force ? "test-token" : "expired";
        },
      },
    });
    await expect(provider.listCalendars(ctx)).resolves.toHaveLength(3);
    expect(forced).toEqual([false, true]);
    const bad = makeProviderContext({
      fetchFn: server.fetch,
      auth: { type: "oauth2", getAccessToken: async () => "wrong-secret" },
    });
    const failure = await provider
      .getEvent(bad, calendar, {
        remoteId: "x",
        etag: null,
        uid: "x",
        recurrenceId: null,
        parentRemoteId: null,
      })
      .catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(CalendarAuthError);
    expect((failure as CalendarAuthError).needsReauth).toBe(true);
    expect(String((failure as Error).message)).not.toContain("wrong-secret");
  });

  it("403 のスコープ不足は同意を求め、rate limit と 429 は一時的な失敗にする", async () => {
    const { server, provider, ctx } = setup();
    server.inject(() => true, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          errors: [{ reason: "insufficientPermissions" }],
        },
      },
    });
    const scope = await provider
      .listCalendars(ctx)
      .catch((caught: unknown) => caught);
    expect(scope).toBeInstanceOf(CalendarAuthError);
    expect((scope as CalendarAuthError).consentRequired).toBe(true);

    server.inject(() => true, {
      status: 429,
      body: {
        error: {
          code: 429,
          message: "Rate Limit Exceeded",
          errors: [{ reason: "rateLimitExceeded" }],
        },
      },
      headers: { "retry-after": "12" },
    });
    const limited = await provider
      .listCalendars(ctx)
      .catch((caught: unknown) => caught);
    expect(limited).toBeInstanceOf(CalendarTransientError);
    expect((limited as CalendarTransientError).retryAfterMs).toBe(12_000);

    server.inject(() => true, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "User Rate Limit Exceeded",
          errors: [{ reason: "userRateLimitExceeded" }],
        },
      },
    });
    await expect(provider.listCalendars(ctx)).rejects.toBeInstanceOf(
      CalendarTransientError,
    );

    server.inject(() => true, {
      status: 503,
      body: { error: { code: 503, message: "Backend Error" } },
    });
    const backend = await provider
      .listCalendars(ctx)
      .catch((caught: unknown) => caught);
    expect(backend).toBeInstanceOf(Error);
    expect(backend).not.toBeInstanceOf(CalendarAuthError);
  });

  it("書き込みの 403 (権限なし) と 400 は rejected、412 は conflict にする", async () => {
    const { server, provider, ctx, calendar } = setup();
    server.put(PRIMARY, {
      id: "ev",
      summary: "元",
      start: { date: "2026-12-01" },
      end: { date: "2026-12-02" },
    });
    const ref = {
      remoteId: "ev",
      etag: null,
      uid: "ev@google.com",
      recurrenceId: null,
      parentRemoteId: null,
    };
    const write = {
      event: makeEventSnapshot({ remoteId: "ev", summary: "x" }),
      master: null,
      exceptions: [],
      fields: ["summary" as const],
    };
    server.inject((request) => request.method === "PATCH", {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Forbidden",
          errors: [{ reason: "forbiddenForNonOrganizer" }],
        },
      },
    });
    expect((await provider.updateEvent(ctx, calendar, ref, write)).status).toBe(
      "rejected",
    );
    server.inject((request) => request.method === "PATCH", {
      status: 412,
      body: {},
    });
    expect((await provider.updateEvent(ctx, calendar, ref, write)).status).toBe(
      "conflict",
    );
    server.inject((request) => request.method === "DELETE", {
      status: 410,
      body: {},
    });
    expect((await provider.deleteEvent(ctx, calendar, ref)).status).toBe(
      "gone",
    );
  });
});

describe("Google の変更通知", () => {
  const rowWith = (overrides: Partial<CalendarRow>) =>
    makeCalendarRow({ remoteId: PRIMARY, name: "個人", ...overrides });

  it("webhookBaseUrl が無ければ何もしない", async () => {
    const { server, provider, ctx } = setup();
    await provider.maintainPush?.(ctx, [rowWith({})]);
    expect(server.requests).toEqual([]);
  });

  it("watch でチャンネルを作り、鍵から作ったトークンと受け口の URL を渡す", async () => {
    const { server, provider, ctx, saved } = setup();
    const withUrl = {
      ...ctx,
      webhookBaseUrl: "https://orbit.example.com/v1/webhooks/microsoft",
    };
    const row = rowWith({});
    const birthdays = rowWith({
      remoteId: BIRTHDAYS_REMOTE_ID,
      name: "誕生日",
    });
    await provider.maintainPush?.(withUrl, [row, birthdays]);
    expect(server.watches).toHaveLength(2);
    const [watch, bd] = server.watches;
    expect(watch).toMatchObject({
      type: "web_hook",
      address: "https://orbit.example.com/v1/webhooks/google-calendar",
      params: { ttl: "604800" },
      calendarId: PRIMARY,
    });
    expect(watch?.token).toBe(
      googleCalendarChannelToken(ctx.encryptionKey, watch?.id as string),
    );
    expect(bd).toMatchObject({ calendarId: PRIMARY, eventTypes: ["birthday"] });
    expect(saved[0]).toMatchObject({
      calendarId: row.id,
      state: {
        pushChannelId: watch?.id,
        pushExpiresAt: new Date(Date.UTC(2026, 11, 4)),
        providerState: {
          pushResourceId: `res-${PRIMARY}`,
          watchFailedAt: null,
        },
      },
    });
  });

  it("期限が近ければ作り直して古いチャンネルを止め、遠ければ何もしない", async () => {
    const { server, provider, ctx } = setup();
    const withUrl = { ...ctx, webhookBaseUrl: "https://orbit.example.com/v1" };
    const fresh = rowWith({
      pushChannelId: "c-fresh",
      pushExpiresAt: new Date(Date.now() + 5 * 86_400_000),
    });
    const stale = rowWith({
      pushChannelId: "c-old",
      pushExpiresAt: new Date(Date.now() + 3_600_000),
      providerState: { pushResourceId: "res-old" },
    });
    await provider.maintainPush?.(withUrl, [fresh, stale]);
    expect(server.watches).toHaveLength(1);
    expect(server.stopped).toEqual([{ id: "c-old", resourceId: "res-old" }]);
  });

  it("watch を断られたカレンダーは、しばらく試さない", async () => {
    const { server, provider, ctx, saved } = setup();
    const withUrl = { ...ctx, webhookBaseUrl: "https://orbit.example.com/v1" };
    server.inject((request) => request.url.pathname.endsWith("/watch"), {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "Push notifications are not supported by this resource.",
          errors: [{ reason: "pushNotSupportedForRequestedResource" }],
        },
      },
    });
    const row = rowWith({
      remoteId: "ja.japanese#holiday@group.v.calendar.google.com",
    });
    await provider.maintainPush?.(withUrl, [row]);
    const failedAt = saved[0]?.state.providerState?.watchFailedAt;
    expect(typeof failedAt).toBe("string");
    await provider.maintainPush?.(withUrl, [
      { ...row, providerState: { watchFailedAt: failedAt } },
    ]);
    expect(
      server.requests.filter((request) =>
        request.url.pathname.endsWith("/watch"),
      ),
    ).toHaveLength(1);
  });

  it("stopPush は channels.stop を呼び、状態を消す", async () => {
    const { server, provider, ctx, saved } = setup();
    const row = rowWith({
      pushChannelId: "c1",
      providerState: { pushResourceId: "r1" },
    });
    await provider.stopPush?.(ctx, row);
    expect(server.stopped).toEqual([{ id: "c1", resourceId: "r1" }]);
    expect(saved).toEqual([
      {
        calendarId: row.id,
        state: {
          pushChannelId: null,
          pushExpiresAt: null,
          providerState: { pushResourceId: null },
        },
      },
    ]);
    server.inject(() => true, { status: 404, body: {} });
    await expect(provider.stopPush?.(ctx, row)).resolves.toBeUndefined();
  });
});

describe("Google の変更通知の URL とトークン (core)", () => {
  it("受け口の URL を作る", () => {
    expect(googleCalendarWebhookUrl(null)).toBeNull();
    expect(googleCalendarWebhookUrl("http://orbit.example.com/v1")).toBeNull();
    expect(
      googleCalendarWebhookUrl(
        "https://orbit.example.com/v1/webhooks/microsoft",
      ),
    ).toBe("https://orbit.example.com/v1/webhooks/google-calendar");
    expect(googleCalendarWebhookUrl("https://orbit.example.com/api/")).toBe(
      "https://orbit.example.com/api/v1/webhooks/google-calendar",
    );
  });

  it("トークンはチャンネルごとに違い、鍵が無いと作れない", () => {
    const key = Buffer.alloc(32, 7);
    const token = googleCalendarChannelToken(key, "c1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyGoogleCalendarChannelToken(key, "c1", token)).toBe(true);
    expect(verifyGoogleCalendarChannelToken(key, "c2", token)).toBe(false);
    expect(
      verifyGoogleCalendarChannelToken(Buffer.alloc(32, 8), "c1", token),
    ).toBe(false);
    expect(verifyGoogleCalendarChannelToken(key, "c1", undefined)).toBe(false);
  });

  it("error の道具が JSON の応答を作る", async () => {
    expect(
      (await error(404, "notFound", "Not Found").json()).error.errors[0].reason,
    ).toBe("notFound");
  });
});
