import {
  graphRecurrenceToRrule,
  graphTimeZoneToIana,
  ianaToGraphTimeZone,
  microsoftCalendarClientState,
  microsoftCalendarWebhookUrl,
  parseGraphEvent,
  rruleToGraphRecurrence,
  UnsupportedRecurrenceError,
  verifyMicrosoftCalendarClientState,
} from "@orbit/core";
import { describe, expect, it } from "vitest";
import { CalendarAuthError, CalendarTransientError } from "../provider.js";
import {
  calendarRowFrom,
  describeCalendarProviderContract,
  makeCalendarRow,
  makeEventSnapshot,
  makeProviderContext,
  readAllPages,
} from "../testing/provider-contract.js";
import { FakeGraph } from "./fake-graph.js";
import { createMicrosoftProvider } from "./index.js";

const NOW = new Date("2026-11-27T00:00:00Z");

function setup(graph = new FakeGraph()) {
  const provider = createMicrosoftProvider({ now: () => NOW });
  const saved: { calendarId: string; state: Record<string, unknown> }[] = [];
  const ctx = makeProviderContext({
    fetchFn: graph.fetch,
    saveCalendarState: async (calendarId, state) => {
      saved.push({ calendarId, state });
    },
  });
  ctx.account.protocol = "graph";
  ctx.account.provider = "microsoft";
  const calendar = makeCalendarRow({
    source: "microsoft",
    remoteId: "cal-1",
    accountId: ctx.account.id,
    timeZone: "Asia/Tokyo",
  });
  return { graph, provider, ctx, calendar, saved };
}

/** 毎週月曜 10:00 (東京) の原本と、その 1 回を変えた例外を入れる。 */
function seedRecurring(graph: FakeGraph) {
  const master = graph.put("cal-1", {
    id: "master-1",
    type: "seriesMaster",
    iCalUId: "series-uid",
    subject: "週次の会議",
    originalStartTimeZone: "Tokyo Standard Time",
    originalEndTimeZone: "Tokyo Standard Time",
    start: { dateTime: "2026-12-07T01:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-12-07T02:00:00.0000000", timeZone: "UTC" },
    recurrence: {
      pattern: {
        type: "weekly",
        interval: 1,
        daysOfWeek: ["monday"],
        firstDayOfWeek: "sunday",
      },
      range: {
        type: "endDate",
        startDate: "2026-12-07",
        endDate: "2027-03-29",
        recurrenceTimeZone: "Tokyo Standard Time",
      },
    },
    cancelledOccurrences: ["OID.master-1.2026-12-21"],
  });
  master._occurrences = ["2026-12-28T01:00:00Z"];
  graph.put("cal-1", {
    id: "exception-1",
    type: "exception",
    seriesMasterId: "master-1",
    iCalUId: "per-occurrence-uid",
    originalStart: "2026-12-14T01:00:00Z",
    originalStartTimeZone: "Tokyo Standard Time",
    subject: "週次の会議 (時間変更)",
    start: { dateTime: "2026-12-14T03:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-12-14T04:00:00.0000000", timeZone: "UTC" },
  });
}

describeCalendarProviderContract(
  "Microsoft Graph",
  () => {
    const { graph, provider, ctx } = setup();
    graph.put("cal-1", {
      subject: "単発の予定",
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
    });
    seedRecurring(graph);
    return { provider, ctx };
  },
  { writable: true, conflicts: true },
);

describe("Graph のタイムゾーン", () => {
  it("Windows 名と IANA 名を相互に変換する", () => {
    expect(graphTimeZoneToIana("Tokyo Standard Time")).toBe("Asia/Tokyo");
    expect(graphTimeZoneToIana("Europe/Paris")).toBe("Europe/Paris");
    expect(graphTimeZoneToIana("UTC")).toBe("Etc/UTC");
    expect(graphTimeZoneToIana("tzone://Microsoft/Custom")).toBeNull();
    expect(ianaToGraphTimeZone("Asia/Tokyo")).toBe("Tokyo Standard Time");
    expect(ianaToGraphTimeZone("Asia/Kathmandu")).toBe("Nepal Standard Time");
    expect(ianaToGraphTimeZone("America/Boise")).toBe("America/Boise");
    expect(ianaToGraphTimeZone("+09:00")).toBe("UTC");
  });
});

describe("patternedRecurrence と RRULE", () => {
  const cases: [
    string,
    Parameters<typeof graphRecurrenceToRrule>[0],
    string,
  ][] = [
    [
      "毎日 2 日おき・回数",
      {
        pattern: { type: "daily", interval: 2 },
        range: {
          type: "numbered",
          startDate: "2026-12-01",
          numberOfOccurrences: 5,
        },
      },
      "FREQ=DAILY;INTERVAL=2;COUNT=5",
    ],
    [
      "毎週 月・水",
      {
        pattern: {
          type: "weekly",
          interval: 1,
          daysOfWeek: ["monday", "wednesday"],
          firstDayOfWeek: "monday",
        },
        range: { type: "noEnd", startDate: "2026-12-07" },
      },
      "FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO",
    ],
    [
      "毎月 15 日",
      {
        pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 15 },
        range: { type: "noEnd", startDate: "2026-12-15" },
      },
      "FREQ=MONTHLY;BYMONTHDAY=15",
    ],
    [
      "毎月 第 2 火曜",
      {
        pattern: {
          type: "relativeMonthly",
          interval: 1,
          daysOfWeek: ["tuesday"],
          index: "second",
        },
        range: { type: "noEnd", startDate: "2026-12-08" },
      },
      "FREQ=MONTHLY;BYDAY=2TU",
    ],
    [
      "毎月 最終の平日",
      {
        pattern: {
          type: "relativeMonthly",
          interval: 1,
          daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          index: "last",
        },
        range: { type: "noEnd", startDate: "2026-12-31" },
      },
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    ],
    [
      "毎年 3 月 3 日",
      {
        pattern: {
          type: "absoluteYearly",
          interval: 1,
          month: 3,
          dayOfMonth: 3,
        },
        range: { type: "noEnd", startDate: "2027-03-03" },
      },
      "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3",
    ],
    [
      "毎年 11 月 第 4 木曜",
      {
        pattern: {
          type: "relativeYearly",
          interval: 1,
          month: 11,
          daysOfWeek: ["thursday"],
          index: "fourth",
        },
        range: { type: "noEnd", startDate: "2026-11-26" },
      },
      "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
    ],
  ];

  for (const [label, recurrence, rrule] of cases) {
    it(`${label}: Graph → RRULE → Graph で同じ規則に戻る`, () => {
      expect(
        graphRecurrenceToRrule(recurrence, { allDay: true, timeZone: null }),
      ).toBe(rrule);
      const back = rruleToGraphRecurrence(rrule, {
        startDate: recurrence?.range.startDate ?? "2026-12-01",
        timeZone: "Asia/Tokyo",
      });
      expect(back.pattern.type).toBe(recurrence?.pattern.type);
      expect(back.pattern.interval).toBe(recurrence?.pattern.interval);
      expect(back.pattern.daysOfWeek ?? []).toEqual(
        recurrence?.pattern.daysOfWeek ?? back.pattern.daysOfWeek ?? [],
      );
      expect(back.range.type).toBe(recurrence?.range.type);
    });
  }

  it("終わりの日は、時刻付きならその日の終わり (繰り返しのタイムゾーン) の UTC にする", () => {
    expect(
      graphRecurrenceToRrule(
        {
          pattern: { type: "daily", interval: 1 },
          range: {
            type: "endDate",
            startDate: "2026-12-01",
            endDate: "2026-12-10",
            recurrenceTimeZone: "Tokyo Standard Time",
          },
        },
        { allDay: false, timeZone: "Asia/Tokyo" },
      ),
    ).toBe("FREQ=DAILY;UNTIL=20261210T145959Z");
    const back = rruleToGraphRecurrence("FREQ=DAILY;UNTIL=20261210T145959Z", {
      startDate: "2026-12-01",
      timeZone: "Asia/Tokyo",
    });
    expect(back.range).toEqual({
      type: "endDate",
      startDate: "2026-12-01",
      endDate: "2026-12-10",
      recurrenceTimeZone: "Tokyo Standard Time",
    });
  });

  it("曜日や日の指定が無い規則は、開始日から補う", () => {
    expect(
      rruleToGraphRecurrence("FREQ=WEEKLY", {
        startDate: "2026-12-09",
        timeZone: "Asia/Tokyo",
      }).pattern.daysOfWeek,
    ).toEqual(["wednesday"]);
    expect(
      rruleToGraphRecurrence("FREQ=YEARLY", {
        startDate: "2026-12-09",
        timeZone: null,
      }).pattern,
    ).toMatchObject({ type: "absoluteYearly", month: 12, dayOfMonth: 9 });
  });

  it("Graph で表せない規則は UnsupportedRecurrenceError", () => {
    for (const rule of [
      "FREQ=HOURLY",
      "FREQ=MONTHLY;BYMONTHDAY=1,15",
      "FREQ=MONTHLY;BYDAY=1MO,3WE",
      "FREQ=YEARLY;BYMONTH=1,7",
      "FREQ=WEEKLY;BYHOUR=9",
      "FREQ=DAILY;COUNT=3;UNTIL=20270101",
    ]) {
      expect(() =>
        rruleToGraphRecurrence(rule, {
          startDate: "2026-12-01",
          timeZone: "Asia/Tokyo",
        }),
      ).toThrow(UnsupportedRecurrenceError);
    }
  });
});

describe("Graph の予定の読み取り", () => {
  it("例外は uid を省き、原本の ID と元の回を持つ", () => {
    const parsed = parseGraphEvent({
      id: "ex",
      type: "exception",
      seriesMasterId: "m",
      iCalUId: "other",
      originalStart: "2026-12-14T01:00:00.0000000Z",
      originalStartTimeZone: "Tokyo Standard Time",
      start: { dateTime: "2026-12-14T03:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-14T04:00:00.0000000", timeZone: "UTC" },
    });
    expect(parsed).toMatchObject({
      uid: null,
      parentRemoteId: "m",
      recurrenceId: "2026-12-14T01:00:00Z",
      startAt: "2026-12-14T03:00:00Z",
      startTimeZone: "Asia/Tokyo",
    });
  });

  it("終日の予定は、元のタイムゾーンの日付にする (UTC で返っても日がずれない)", () => {
    const parsed = parseGraphEvent({
      id: "a",
      isAllDay: true,
      originalStartTimeZone: "Tokyo Standard Time",
      originalEndTimeZone: "Tokyo Standard Time",
      start: { dateTime: "2026-12-09T15:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-10T15:00:00.0000000", timeZone: "UTC" },
    });
    expect(parsed).toMatchObject({
      allDay: true,
      startDate: "2026-12-10",
      endDate: "2026-12-11",
      startAt: null,
      startTimeZone: null,
    });
  });

  it("原本の取り消された回を exdates にし、出欠と自分の印を読む", () => {
    const parsed = parseGraphEvent(
      {
        id: "m",
        type: "seriesMaster",
        iCalUId: "u",
        originalStartTimeZone: "Tokyo Standard Time",
        start: { dateTime: "2026-12-07T01:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-12-07T02:00:00.0000000", timeZone: "UTC" },
        recurrence: {
          pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
          range: { type: "noEnd", startDate: "2026-12-07" },
        },
        cancelledOccurrences: ["OID.m.2026-12-21", "OID.m.2026-12-14"],
        showAs: "free",
        isReminderOn: false,
        organizer: {
          emailAddress: { address: "boss@example.com", name: "上司" },
        },
        attendees: [
          {
            type: "required",
            status: { response: "tentativelyAccepted" },
            emailAddress: { address: "Me@Example.com", name: "自分" },
          },
          {
            type: "optional",
            status: { response: "none" },
            emailAddress: { address: "x@example.com" },
          },
        ],
        onlineMeeting: { joinUrl: "https://teams.example/join" },
      },
      { selfEmail: "me@example.com" },
    );
    expect(parsed).toMatchObject({
      uid: "u",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      exdates: ["2026-12-14T01:00:00Z", "2026-12-21T01:00:00Z"],
      busy: false,
      reminders: [],
      organizer: { email: "boss@example.com", name: "上司" },
      conferenceUrl: "https://teams.example/join",
    });
    expect(parsed?.attendees).toEqual([
      {
        email: "Me@Example.com",
        name: "自分",
        role: "required",
        status: "tentative",
        self: true,
      },
      {
        email: "x@example.com",
        name: null,
        role: "optional",
        status: "needs_action",
      },
    ]);
  });
});

describe("Microsoft のカレンダーの一覧", () => {
  it("色、書き込めるか、誕生日のカレンダーを読む", async () => {
    const { provider, ctx } = setup();
    const list = await provider.listCalendars(ctx);
    expect(list).toEqual([
      expect.objectContaining({
        remoteId: "cal-1",
        name: "予定表",
        color: "#3366ff",
        readOnly: false,
        kind: "normal",
      }),
      expect.objectContaining({
        remoteId: "cal-bd",
        readOnly: true,
        kind: "birthdays",
        color: "#87d28e",
      }),
    ]);
  });

  it("権限が足りなければ、カレンダーの同意を求める", async () => {
    const graph = new FakeGraph();
    const { provider, ctx } = setup(graph);
    ctx.fetchFn = async () =>
      new Response(JSON.stringify({ error: { code: "ErrorAccessDenied" } }), {
        status: 403,
      });
    await expect(provider.listCalendars(ctx)).rejects.toMatchObject({
      name: "CalendarAuthError",
      consentRequired: true,
    });
  });

  it("トークンを取り直しても 401 なら再ログインを求める", async () => {
    const { provider, ctx } = setup();
    const forced: boolean[] = [];
    ctx.auth = {
      type: "oauth2",
      getAccessToken: async (force) => {
        forced.push(force === true);
        return "t";
      },
    };
    ctx.fetchFn = async () => new Response(null, { status: 401 });
    await expect(provider.listCalendars(ctx)).rejects.toBeInstanceOf(
      CalendarAuthError,
    );
    expect(forced).toEqual([false, true]);
  });

  it("429 と Retry-After は CalendarTransientError にする", async () => {
    const { provider, ctx } = setup();
    ctx.fetchFn = async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "7" } });
    const error = await provider.listCalendars(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarTransientError);
    expect((error as CalendarTransientError).retryAfterMs).toBe(7000);
  });
});

describe("Microsoft の予定の同期", () => {
  it("全件: 原本を取り直して規則と取り消しを得て、例外は原本の ID を指し、回は保存しない", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    graph.put("cal-1", {
      id: "single",
      subject: "単発",
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
    });
    const { pages, events } = await readAllPages(provider, ctx, calendar, null);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.full)).toBe(true);
    const byId = new Map(events.map((event) => [event.remoteId, event]));
    expect([...byId.keys()].sort()).toEqual([
      "exception-1",
      "master-1",
      "single",
    ]);
    expect(byId.get("master-1")).toMatchObject({
      uid: "series-uid",
      rrule: "FREQ=WEEKLY;BYDAY=MO;WKST=SU;UNTIL=20270329T145959Z",
      exdates: ["2026-12-21T01:00:00Z"],
      startTimeZone: "Asia/Tokyo",
    });
    const exception = byId.get("exception-1");
    expect(exception?.uid).toBeUndefined();
    expect(exception).toMatchObject({
      parentRemoteId: "master-1",
      recurrenceId: "2026-12-14T01:00:00Z",
    });
    // 期間付きの calendarView/delta を、選んだカレンダーについて呼ぶ。
    const first = graph.requests.find((r) => r.url.includes("calendarView"));
    expect(first?.url).toContain("/me/calendars/cal-1/calendarView/delta");
    expect(first?.url).toContain("startDateTime=2025-11-27T00%3A00%3A00Z");
    expect(first?.url).toContain("endDateTime=2028-11-26T00%3A00%3A00Z");
    expect(first?.headers.prefer).toContain('outlook.body-content-type="text"');
    // 原本は 1 回だけ取る。
    expect(
      graph.requests.filter((r) => r.url.includes("/me/events/master-1?")),
    ).toHaveLength(1);
  });

  it("差分: 原本ごと消えたら (回の @removed だけが届く)、原本を確かめて消す", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    const first = await readAllPages(provider, ctx, calendar, null);
    const token = first.pages.at(-1)?.nextSyncToken ?? null;
    expect(token).not.toBeNull();
    graph.remove("master-1");
    const known = new Map([
      ["master-1", { uid: "series-uid", etag: null }],
      ["exception-1", { uid: "series-uid", etag: null }],
    ]);
    const delta = await provider.syncEvents(ctx, calendar, {
      syncToken: token,
      pageCursor: null,
      knownEtags: async () => new Map(),
      knownEvents: async () => known,
    });
    expect(delta.full).toBe(false);
    expect(delta.deletedRemoteIds).toEqual(
      expect.arrayContaining(["master-1", "exception-1"]),
    );
  });

  it("差分: 回の取り消しは、原本の exdates の変化として届く", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    const first = await readAllPages(provider, ctx, calendar, null);
    const token = first.pages.at(-1)?.nextSyncToken ?? null;
    graph.update("master-1", {
      cancelledOccurrences: [
        "OID.master-1.2026-12-21",
        "OID.master-1.2026-12-28",
      ],
    });
    const { events } = await readAllPages(provider, ctx, calendar, token);
    expect(events.find((e) => e.remoteId === "master-1")?.exdates).toEqual([
      "2026-12-21T01:00:00Z",
      "2026-12-28T01:00:00Z",
    ]);
  });

  it("差分の位置が無効 (410) なら全件を取り直す", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    const first = await readAllPages(provider, ctx, calendar, null);
    graph.invalidateTokens = true;
    const delta = await provider.syncEvents(ctx, calendar, {
      syncToken: first.pages.at(-1)?.nextSyncToken ?? null,
      pageCursor: null,
      knownEtags: async () => new Map(),
      knownEvents: async () => new Map(),
    });
    expect(delta.full).toBe(true);
  });

  it("期間が 30 日以上古ければ、新しい期間で全件を取り直す", async () => {
    const graph = new FakeGraph();
    const { ctx, calendar } = setup(graph);
    const old = createMicrosoftProvider({ now: () => new Date("2026-09-01Z") });
    const first = await readAllPages(old, ctx, calendar, null);
    const later = createMicrosoftProvider({ now: () => NOW });
    const delta = await later.syncEvents(ctx, calendar, {
      syncToken: first.pages.at(-1)?.nextSyncToken ?? null,
      pageCursor: null,
      knownEtags: async () => new Map(),
      knownEvents: async () => new Map(),
    });
    expect(delta.full).toBe(true);
  });

  it("$select が拒まれたら、cancelledOccurrences 無しで原本を取る", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    graph.rejectSelect = true;
    const { events } = await readAllPages(provider, ctx, calendar, null);
    expect(events.find((e) => e.remoteId === "master-1")).toMatchObject({
      rrule: expect.stringContaining("FREQ=WEEKLY"),
      exdates: null,
    });
  });
});

describe("Microsoft への書き戻し", () => {
  it("作成は transactionId に events.id を入れ、時刻は Windows 名のタイムゾーンで送る", async () => {
    const { graph, provider, ctx, calendar } = setup();
    const snapshot = makeEventSnapshot({
      rrule: "FREQ=WEEKLY;BYDAY=TH",
    });
    const result = await provider.createEvent(ctx, calendar, {
      event: snapshot,
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(result.status).toBe("ok");
    const post = graph.requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(
      "https://graph.microsoft.com/v1.0/me/calendars/cal-1/events",
    );
    expect(post?.body).toMatchObject({
      transactionId: snapshot.id,
      subject: "契約テストの予定",
      isAllDay: false,
      start: {
        dateTime: "2026-12-10T10:00:00",
        timeZone: "Tokyo Standard Time",
      },
      end: { dateTime: "2026-12-10T11:00:00", timeZone: "Tokyo Standard Time" },
      recurrence: {
        pattern: { type: "weekly", interval: 1, daysOfWeek: ["thursday"] },
        range: {
          type: "noEnd",
          startDate: "2026-12-10",
          recurrenceTimeZone: "Tokyo Standard Time",
        },
      },
    });
  });

  it("表せない繰り返しの作成は rejected", async () => {
    const { provider, ctx, calendar } = setup();
    const result = await provider.createEvent(ctx, calendar, {
      event: makeEventSnapshot({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15" }),
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(result.status).toBe("rejected");
  });

  it("更新には If-Match を付け、変えた項目だけを送る", async () => {
    const { graph, provider, ctx, calendar } = setup();
    const stored = graph.put("cal-1", {
      subject: "前",
      location: { displayName: "会議室" },
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
    });
    const etag = stored["@odata.etag"] ?? null;
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: stored.id,
        etag,
        uid: "ical",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          remoteId: stored.id,
          summary: "後",
          raw: JSON.stringify(graph.view(stored)),
        }),
        master: null,
        exceptions: [],
        fields: ["summary"],
      },
    );
    expect(result.status).toBe("ok");
    const patch = graph.requests.find((r) => r.method === "PATCH");
    expect(patch?.headers["if-match"]).toBe(etag);
    expect(patch?.body).toEqual({ subject: "後" });
    expect(graph.events.get(stored.id)?.location).toEqual({
      displayName: "会議室",
    });
  });

  it("回の削除 (exdates の追加) は、その回を消す。規則が同じなら recurrence は送らない", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    const { events } = await readAllPages(provider, ctx, calendar, null);
    const master = events.find((e) => e.remoteId === "master-1");
    if (!master) throw new Error("原本がありません");
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: "master-1",
        etag: master.etag,
        uid: "series-uid",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          remoteId: "master-1",
          etag: master.etag,
          rrule: master.rrule,
          exdates: ["2026-12-21T01:00:00Z", "2026-12-28T01:00:00Z"],
          raw: master.raw,
        }),
        master: null,
        exceptions: [],
        fields: ["recurrence"],
      },
    );
    expect(result.status).toBe("ok");
    expect(graph.requests.some((r) => r.method === "PATCH")).toBe(false);
    const removed = graph.requests.filter((r) => r.method === "DELETE");
    expect(removed.map((r) => r.url)).toEqual([
      "https://graph.microsoft.com/v1.0/me/events/master-1.occ.2026-12-28",
    ]);
    if (result.status === "ok") {
      expect(result.events[0]?.exdates).toEqual([
        "2026-12-21T01:00:00Z",
        "2026-12-28T01:00:00Z",
      ]);
    }
  });

  it("まだ相手側に無い回の例外は、回を探してその回を書き換える", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    const master = makeEventSnapshot({
      remoteId: "master-1",
      uid: "series-uid",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    const exception = makeEventSnapshot({
      uid: "series-uid",
      recurrenceId: "2026-12-28T01:00:00Z",
      summary: "この回だけ",
    });
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: "master-1",
        etag: null,
        uid: "series-uid",
        recurrenceId: "2026-12-28T01:00:00Z",
        parentRemoteId: "master-1",
      },
      { event: exception, master, exceptions: [], fields: ["summary"] },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.events[0]).toMatchObject({
      remoteId: "master-1.occ.2026-12-28",
      parentRemoteId: "master-1",
      recurrenceId: "2026-12-28T01:00:00Z",
      summary: "この回だけ",
    });
    expect(result.events[0]?.uid).toBeUndefined();
  });

  it("まだ相手側に無い回の例外で、回が無くても原本があれば rejected (原本を消させない)", async () => {
    const { graph, provider, ctx, calendar } = setup();
    seedRecurring(graph);
    const master = makeEventSnapshot({
      remoteId: "master-1",
      uid: "series-uid",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    // 2026-12-21 の回は相手側で取り消し済み。
    const exception = makeEventSnapshot({
      uid: "series-uid",
      recurrenceId: "2026-12-21T01:00:00Z",
      summary: "この回だけ",
    });
    const ref = {
      remoteId: "master-1",
      etag: null,
      uid: "series-uid",
      recurrenceId: "2026-12-21T01:00:00Z",
      parentRemoteId: "master-1",
    };
    const write = {
      event: exception,
      master,
      exceptions: [],
      fields: ["summary"],
    };
    const result = await provider.updateEvent(ctx, calendar, ref, write);
    expect(result).toEqual({
      status: "rejected",
      reason: "その回が相手側にありません。",
    });
    expect(graph.requests.some((r) => r.method === "PATCH")).toBe(false);

    // 原本も消えていれば gone。
    graph.remove("master-1");
    const gone = await provider.updateEvent(ctx, calendar, ref, write);
    expect(gone).toEqual({ status: "gone" });
  });

  it("断ったあと Outlook が予定を消しても (404)、返事は成功にする", async () => {
    const { graph, provider, ctx, calendar } = setup();
    graph.removeOnDecline = true;
    const stored = graph.put("cal-1", {
      subject: "招待",
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
    });
    const ref = {
      remoteId: stored.id,
      etag: null,
      uid: "u",
      recurrenceId: null,
      parentRemoteId: null,
    };
    const result = await provider.respond(ctx, calendar, ref, {
      status: "declined",
      comment: null,
    });
    expect(result).toEqual({ status: "ok", events: [] });
    expect(graph.events.has(stored.id)).toBe(false);

    // 承諾のあとに消えていれば、これまでどおり gone。
    const other = graph.put("cal-1", {
      subject: "招待 2",
      start: { dateTime: "2026-12-02T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-02T02:00:00.0000000", timeZone: "UTC" },
    });
    graph.removeOnDecline = false;
    const accepted = await provider.respond(
      ctx,
      calendar,
      { ...ref, remoteId: other.id },
      { status: "accepted", comment: null },
    );
    expect(accepted.status).toBe("ok");
  });

  it("会議室など (non_participant) の参加者は resource で送る", async () => {
    const { graph, provider, ctx, calendar } = setup();
    const stored = graph.put("cal-1", {
      subject: "会議",
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
      attendees: [
        {
          emailAddress: { address: "room@example.com", name: "会議室 A" },
          type: "resource",
        },
      ],
    });
    const attendee = (email: string, role: string) =>
      ({
        id: email,
        eventId: "e",
        email,
        name: null,
        role,
        status: "needs_action",
        self: false,
      }) as never;
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: stored.id,
        etag: stored["@odata.etag"] ?? null,
        uid: "ical",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          remoteId: stored.id,
          raw: JSON.stringify(graph.view(stored)),
          attendees: [
            attendee("room@example.com", "non_participant"),
            attendee("a@example.com", "required"),
            attendee("b@example.com", "optional"),
          ],
        }),
        master: null,
        exceptions: [],
        fields: ["attendees"],
      },
    );
    expect(result.status).toBe("ok");
    const patch = graph.requests.find((r) => r.method === "PATCH");
    expect(
      (patch?.body as { attendees: { type: string }[] }).attendees.map(
        (item) => item.type,
      ),
    ).toEqual(["resource", "required", "optional"]);
    if (result.status === "ok") {
      expect(
        result.events[0]?.attendees.find((a) => a.email === "room@example.com")
          ?.role,
      ).toBe("non_participant");
    }
  });

  it("出欠を返し、返したあとの姿を返す", async () => {
    const { graph, provider, ctx, calendar } = setup();
    const stored = graph.put("cal-1", {
      subject: "招待",
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
    });
    const result = await provider.respond(
      ctx,
      calendar,
      {
        remoteId: stored.id,
        etag: null,
        uid: "u",
        recurrenceId: null,
        parentRemoteId: null,
      },
      { status: "tentative", comment: "たぶん" },
    );
    expect(result.status).toBe("ok");
    const post = graph.requests.find((r) => r.method === "POST");
    expect(post?.url).toContain(`/me/events/${stored.id}/tentativelyAccept`);
    expect(post?.body).toEqual({ comment: "たぶん", sendResponse: true });
  });

  it("isOrganizer を主催者の印にし、一覧の自分の行が none なら responseStatus で補う", async () => {
    const { graph, provider, ctx, calendar } = setup();
    const self = ctx.account.email;
    const stored = graph.put("cal-1", {
      subject: "招待",
      start: { dateTime: "2026-12-01T01:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T02:00:00.0000000", timeZone: "UTC" },
      isOrganizer: false,
      organizer: { emailAddress: { address: "boss@example.com" } },
      attendees: [
        {
          emailAddress: { address: self },
          type: "required",
          status: { response: "none" },
        },
      ],
    });
    const result = await provider.respond(
      ctx,
      calendar,
      {
        remoteId: stored.id,
        etag: null,
        uid: "u",
        recurrenceId: null,
        parentRemoteId: null,
      },
      { status: "accepted", comment: null },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.events[0]?.organizer).toMatchObject({
      email: "boss@example.com",
      self: false,
    });
    // 偽の Graph は返事で responseStatus だけを変える (一覧の自分の行は none のまま)。
    expect(
      result.events[0]?.attendees.find((attendee) => attendee.self)?.status,
    ).toBe("accepted");
  });
});

describe("Microsoft の変更通知", () => {
  it("webhookBaseUrl が null なら何もしない", async () => {
    const { graph, provider, ctx, calendar } = setup();
    await provider.maintainPush?.(ctx, [calendar]);
    expect(graph.requests).toEqual([]);
  });

  it("購読を作り、期限が近づいたら延ばし、止めるときは消す", async () => {
    const { graph, provider, ctx, calendar, saved } = setup();
    ctx.webhookBaseUrl = "https://orbit.example/v1/webhooks/microsoft";
    await provider.maintainPush?.(ctx, [calendar]);
    const post = graph.requests.find((r) => r.method === "POST");
    expect(post?.body).toMatchObject({
      changeType: "created,updated,deleted",
      resource: "me/calendars/cal-1/events",
      notificationUrl: `https://orbit.example/v1/webhooks/microsoft-calendar?account=${ctx.account.id}&calendar=${calendar.id}`,
      clientState: microsoftCalendarClientState(
        ctx.encryptionKey,
        ctx.account.id,
        calendar.id,
      ),
    });
    const state = saved.at(-1)?.state;
    expect(state?.pushChannelId).toMatch(/^sub-/);

    // 期限の近い購読は PATCH で延ばす。
    const near = {
      ...calendar,
      pushChannelId: state?.pushChannelId as string,
      pushExpiresAt: new Date(Date.now() + 60_000),
    };
    graph.requests = [];
    await provider.maintainPush?.(ctx, [near]);
    expect(graph.requests.map((r) => r.method)).toEqual(["PATCH"]);

    // 期限に余裕があれば何もしない。
    graph.requests = [];
    await provider.maintainPush?.(ctx, [
      { ...near, pushExpiresAt: new Date(Date.now() + 5 * 86_400_000) },
    ]);
    expect(graph.requests).toEqual([]);

    await provider.stopPush?.(ctx, near);
    expect(graph.subscriptions.size).toBe(0);
    expect(saved.at(-1)?.state).toEqual({
      pushChannelId: null,
      pushExpiresAt: null,
    });
  });

  it("Graph 側で消えていた購読は作り直す。誕生日のカレンダーは購読しない", async () => {
    const { graph, provider, ctx, calendar } = setup();
    ctx.webhookBaseUrl = "https://orbit.example/v1";
    const birthdays = calendarRowFrom(
      {
        remoteId: "cal-bd",
        name: "Birthdays",
        description: null,
        color: null,
        timeZone: null,
        readOnly: true,
        url: null,
        defaultReminders: null,
        kind: "birthdays",
      },
      { providerState: { kind: "birthdays" } },
    );
    await provider.maintainPush?.(ctx, [
      { ...calendar, pushChannelId: "gone", pushExpiresAt: null },
      birthdays,
    ]);
    expect(graph.requests.map((r) => r.method)).toEqual(["PATCH", "POST"]);
    expect(graph.requests[1]?.body).toMatchObject({
      notificationUrl: expect.stringMatching(
        /^https:\/\/orbit\.example\/v1\/webhooks\/microsoft-calendar\?/,
      ),
    });
  });

  it("clientState はアカウントとカレンダーごとに違い、メールの合言葉とも違う", () => {
    const key = Buffer.alloc(32, 3);
    const a = microsoftCalendarClientState(key, "acc", "cal-a");
    expect(a).not.toBe(microsoftCalendarClientState(key, "acc", "cal-b"));
    expect(verifyMicrosoftCalendarClientState(key, "acc", "cal-a", a)).toBe(
      true,
    );
    expect(verifyMicrosoftCalendarClientState(key, "acc", "cal-b", a)).toBe(
      false,
    );
    expect(microsoftCalendarWebhookUrl("https://x.example/v1/", "a", "c")).toBe(
      "https://x.example/v1/webhooks/microsoft-calendar?account=a&calendar=c",
    );
  });
});
