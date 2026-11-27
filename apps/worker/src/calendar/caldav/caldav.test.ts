import { describe, expect, it } from "vitest";
import {
  CalendarAuthError,
  type CalendarRow,
  CalendarTransientError,
  type ProviderContext,
  type RemoteCalendar,
  toAccountCalendarInput,
} from "../provider.js";
import {
  calendarRowFrom,
  describeCalendarProviderContract,
  makeEventSnapshot,
  makeProviderContext,
  readAllPages,
} from "../testing/provider-contract.js";
import { FakeCaldavServer, vcalendar, vevent } from "./fake-server.js";
import { createCaldavProvider } from "./index.js";

const publicHosts = async () => false;

function setup(
  options: ConstructorParameters<typeof FakeCaldavServer>[0] = {},
  isPrivateHost: (host: string) => Promise<boolean> = publicHosts,
) {
  const server = new FakeCaldavServer(options);
  const provider = createCaldavProvider({ isPrivateHost });
  const base = makeProviderContext();
  const ctx: ProviderContext = {
    ...base,
    account: {
      ...base.account,
      provider: "generic",
      authType: "password",
      email: "user@example.com",
      username: "user",
      caldavUrl: `${server.origin}/`,
      mailEnabled: false,
    },
    auth: { type: "password", username: "user", password: "secret" },
    fetchFn: server.fetch,
  };
  return { server, provider, ctx };
}

async function workCalendar(
  provider: ReturnType<typeof createCaldavProvider>,
  ctx: ProviderContext,
): Promise<CalendarRow> {
  const list = await provider.listCalendars(ctx);
  const remote = list.find((entry) => entry.name === "仕事");
  if (!remote) throw new Error("仕事のカレンダーがありません");
  return calendarRowFrom(remote, {
    source: "caldav",
    providerState: remote.providerState ?? null,
  });
}

const SERIES = vcalendar(
  vevent({
    UID: "series@example.com",
    DTSTART: "20261201T010000Z",
    DTEND: "20261201T020000Z",
    RRULE: "FREQ=WEEKLY",
    SUMMARY: "週次",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI": "geo:35.6,139.7",
  }),
  vevent({
    UID: "series@example.com",
    "RECURRENCE-ID": "20261208T010000Z",
    DTSTART: "20261208T030000Z",
    DTEND: "20261208T040000Z",
    SUMMARY: "週次 (ずらした回)",
  }),
);

for (const syncCollection of [true, false]) {
  describeCalendarProviderContract(
    `CalDAV (sync-collection ${syncCollection ? "あり" : "なし"})`,
    async () => {
      const { server, provider, ctx } = setup({ syncCollection });
      server.putDirect("/cal/user/work/series.ics", SERIES);
      const calendar = await workCalendar(provider, ctx);
      return { provider, ctx, calendar };
    },
    { writable: true, conflicts: true },
  );
}

describe("CalDAV の探索", () => {
  it("well-known から principal、calendar-home-set (別のホスト) をたどり、予定のカレンダーだけを返す", async () => {
    // iCloud は caldav.icloud.com から pNN-caldav.icloud.com へ移る (icloud.com の下には認証情報を送る)。
    const { server, provider, ctx } = setup({
      origin: "https://caldav.icloud.com",
      homeOrigin: "https://p01-caldav.icloud.com",
    });
    const list = await provider.listCalendars(ctx);
    expect(list).toEqual([
      {
        remoteId: "https://p01-caldav.icloud.com/cal/user/work/",
        name: "仕事",
        description: null,
        color: "#ff2968",
        timeZone: null,
        readOnly: false,
        url: "https://p01-caldav.icloud.com/cal/user/work/",
        defaultReminders: null,
        kind: "normal",
        providerState: { syncCollection: false, autoSchedule: false },
      },
    ]);
    expect(server.requests[0]?.url).toBe(`${server.origin}/.well-known/caldav`);
  });

  it("内部ネットワークを指す起点、リダイレクト先、href の先には接続しない", async () => {
    // 起点そのもの。
    const first = setup({}, async (host) => host === "dav.example.com");
    await expect(
      first.provider.listCalendars(first.ctx),
    ).rejects.toBeInstanceOf(CalendarAuthError);
    expect(first.server.requests).toHaveLength(0);
    // サーバーが返した calendar-home-set の先。
    const second = setup(
      { homeOrigin: "https://internal.example.com" },
      async (host) => host === "internal.example.com",
    );
    await expect(second.provider.listCalendars(second.ctx)).rejects.toThrow(
      /内部ネットワーク/,
    );
    expect(
      second.server.requests.some((request) =>
        request.url.includes("internal"),
      ),
    ).toBe(false);
    // allowPrivateHosts なら検査しない。
    const third = setup({}, async () => true);
    const list = await third.provider.listCalendars({
      ...third.ctx,
      allowPrivateHosts: true,
    });
    expect(list).toHaveLength(1);
  });

  it("リダイレクト先が内部ネットワークなら追わない", async () => {
    const { provider, ctx } = setup();
    const fetchFn: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/dav/" },
      });
    const check = async (host: string) => host === "10.0.0.1";
    const guarded = createCaldavProvider({ isPrivateHost: check });
    await expect(guarded.listCalendars({ ...ctx, fetchFn })).rejects.toThrow(
      /内部ネットワーク/,
    );
    void provider;
  });

  it("別のサイトへのリダイレクトには認証情報を送らない", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.startsWith("https://dav.example.com")) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://evil.example.net/dav/" },
        });
      }
      return new Response(null, { status: 401 });
    };
    const { ctx } = setup();
    const provider = createCaldavProvider({ isPrivateHost: publicHosts });
    await expect(
      provider.listCalendars({ ...ctx, fetchFn }),
    ).rejects.toBeInstanceOf(CalendarAuthError);
    expect(seen[0]?.auth).toMatch(/^Basic /);
    expect(seen.find((entry) => entry.url.includes("evil"))?.auth).toBeNull();
  });

  it("パスワードの誤りは CalendarAuthError (needsReauth)、503 の Retry-After は CalendarTransientError", async () => {
    const { provider, ctx } = setup({ password: "other" });
    const error = await provider.listCalendars(ctx).catch((value) => value);
    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as CalendarAuthError).needsReauth).toBe(true);
    expect(String(error.message)).not.toContain("secret");

    const busy: typeof fetch = async () =>
      new Response("busy", { status: 503, headers: { "retry-after": "120" } });
    const transient = await createCaldavProvider({ isPrivateHost: publicHosts })
      .getEvent(
        { ...ctx, fetchFn: busy },
        calendarRowFrom({
          remoteId: "https://dav.example.com/cal/user/work/",
          name: "x",
          description: null,
          color: null,
          timeZone: null,
          readOnly: false,
          url: "https://dav.example.com/cal/user/work/",
          defaultReminders: null,
          kind: "normal",
        }),
        {
          remoteId: "/cal/user/work/a.ics",
          etag: null,
          uid: "a",
          recurrenceId: null,
          parentRemoteId: null,
        },
      )
      .catch((value) => value);
    expect(transient).toBeInstanceOf(CalendarTransientError);
    expect((transient as CalendarTransientError).retryAfterMs).toBe(120_000);
  });
});

describe("CalDAV の差分", () => {
  it("原本と例外を同じページで返し、raw はリソース全体、例外の parentRemoteId は自分の href", async () => {
    const { server, provider, ctx } = setup();
    for (let index = 0; index < 150; index++) {
      server.putDirect(
        `/cal/user/work/e${index}.ics`,
        vcalendar(
          vevent({
            UID: `e${index}`,
            DTSTART: "20261201T010000Z",
            SUMMARY: `予定 ${index}`,
          }),
        ),
      );
    }
    server.putDirect("/cal/user/work/series.ics", SERIES);
    const calendar = await workCalendar(provider, ctx);
    const { pages, events } = await readAllPages(provider, ctx, calendar, null);
    expect(pages).toHaveLength(2);
    expect(events).toHaveLength(152);
    const series = pages.filter((page) =>
      page.events.some(
        (event) => event.remoteId === "/cal/user/work/series.ics",
      ),
    );
    expect(series).toHaveLength(1);
    const rows = series[0]?.events.filter(
      (event) => event.remoteId === "/cal/user/work/series.ics",
    );
    expect(rows?.map((row) => [row.recurrenceId, row.parentRemoteId])).toEqual([
      [null, null],
      ["2026-12-08T01:00:00Z", "/cal/user/work/series.ics"],
    ]);
    expect(rows?.[0]?.raw).toBe(SERIES);
    expect(pages.at(-1)?.nextSyncToken).toMatch(/^ctag:/);
    expect(pages.at(-1)?.nextEtag).toMatch(/^ctag-/);
  });

  it("getctag が同じなら一覧を取らず、変われば ETag の違うものだけを取って、消えたものを返す", async () => {
    const { server, provider, ctx } = setup();
    server.putDirect(
      "/cal/user/work/a.ics",
      vcalendar(vevent({ UID: "a", DTSTART: "20261201", SUMMARY: "A" })),
    );
    server.putDirect(
      "/cal/user/work/b.ics",
      vcalendar(vevent({ UID: "b", DTSTART: "20261202", SUMMARY: "B" })),
    );
    const calendar = await workCalendar(provider, ctx);
    const first = await readAllPages(provider, ctx, calendar, null);
    const token = first.pages.at(-1)?.nextSyncToken ?? null;
    const known = new Map(
      first.events.map((event) => [event.remoteId, event.etag]),
    );
    const sync = (syncToken: string | null) =>
      provider.syncEvents(ctx, calendar, {
        syncToken,
        pageCursor: null,
        knownEtags: async () => known,
        knownEvents: async () => new Map(),
      });

    server.requests.length = 0;
    const same = await sync(token);
    expect(same).toMatchObject({
      events: [],
      deletedRemoteIds: [],
      full: false,
      nextSyncToken: token,
    });
    expect(server.requests.map((request) => request.method)).toEqual([
      "PROPFIND",
    ]);

    server.putDirect(
      "/cal/user/work/a.ics",
      vcalendar(vevent({ UID: "a", DTSTART: "20261201", SUMMARY: "A2" })),
    );
    server.deleteDirect("/cal/user/work/b.ics");
    server.requests.length = 0;
    const changed = await sync(token);
    expect(changed.full).toBe(false);
    expect(changed.events.map((event) => event.summary)).toEqual(["A2"]);
    expect(changed.deletedRemoteIds).toEqual(["/cal/user/work/b.ics"]);
    expect(changed.nextSyncToken).not.toBe(token);
    const multiget = server.requests.find((request) =>
      request.body.includes("calendar-multiget"),
    );
    expect(multiget?.body).not.toContain("b.ics");
  });

  it("sync-collection の差分を使い、同期の位置が無効なら ETag の比較に戻る", async () => {
    const { server, provider, ctx } = setup({ syncCollection: true });
    server.putDirect(
      "/cal/user/work/a.ics",
      vcalendar(vevent({ UID: "a", DTSTART: "20261201", SUMMARY: "A" })),
    );
    server.putDirect(
      "/cal/user/work/b.ics",
      vcalendar(vevent({ UID: "b", DTSTART: "20261202", SUMMARY: "B" })),
    );
    const calendar = await workCalendar(provider, ctx);
    expect(calendar.providerState).toEqual({
      syncCollection: true,
      autoSchedule: false,
    });
    const first = await readAllPages(provider, ctx, calendar, null);
    const token = first.pages.at(-1)?.nextSyncToken ?? null;
    expect(token).toMatch(/^sync:/);
    const known = new Map(
      first.events.map((event) => [event.remoteId, event.etag]),
    );
    const sync = (syncToken: string | null) =>
      provider.syncEvents(ctx, calendar, {
        syncToken,
        pageCursor: null,
        knownEtags: async () => known,
        knownEvents: async () => new Map(),
      });

    server.putDirect(
      "/cal/user/work/c.ics",
      vcalendar(vevent({ UID: "c", DTSTART: "20261203", SUMMARY: "C" })),
    );
    server.deleteDirect("/cal/user/work/a.ics");
    const delta = await sync(token);
    expect(delta.events.map((event) => event.summary)).toEqual(["C"]);
    expect(delta.deletedRemoteIds).toEqual(["/cal/user/work/a.ics"]);
    expect(
      server.requests.some((request) =>
        request.body.includes("sync-collection"),
      ),
    ).toBe(true);

    server.invalidateTokens = true;
    known.delete("/cal/user/work/a.ics");
    const fallback = await sync(delta.nextSyncToken);
    expect(fallback.full).toBe(false);
    expect(fallback.events.map((event) => event.summary)).toEqual(["C"]);
    expect(fallback.nextSyncToken).toMatch(/^sync:/);
  });
});

describe("CalDAV の書き込み", () => {
  it("作成は events.id の href に If-None-Match: * で、更新は If-Match で書く。知らない項目は残る", async () => {
    const { server, provider, ctx } = setup();
    server.putDirect("/cal/user/work/series.ics", SERIES);
    const calendar = await workCalendar(provider, ctx);
    const snapshot = makeEventSnapshot();
    const created = await provider.createEvent(ctx, calendar, {
      event: snapshot,
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(created.status).toBe("ok");
    const put = server.requests.find((request) => request.method === "PUT");
    expect(put?.url).toBe(`${server.origin}/cal/user/work/${snapshot.id}.ics`);
    expect(put?.headers.get("if-none-match")).toBe("*");
    expect(put?.body).toContain(`UID:${snapshot.id}@orbit`);

    const { events } = await readAllPages(provider, ctx, calendar, null);
    const master = events.find(
      (event) => event.uid === "series@example.com" && !event.recurrenceId,
    );
    if (!master) throw new Error("原本がありません");
    server.requests.length = 0;
    const updated = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: master.remoteId,
        etag: master.etag,
        uid: "series@example.com",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          uid: "series@example.com",
          remoteId: master.remoteId,
          etag: master.etag,
          raw: master.raw,
          summary: "週次 (改題)",
          rrule: "FREQ=WEEKLY",
        }),
        master: null,
        exceptions: [],
        fields: ["summary"],
      },
    );
    expect(updated.status).toBe("ok");
    const update = server.requests.find((request) => request.method === "PUT");
    expect(update?.headers.get("if-match")).toBe(master.etag);
    const stored =
      server.resources.get("/cal/user/work/series.ics")?.data ?? "";
    expect(stored).toContain(
      "X-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:35.6,139.7",
    );
    expect(stored).toContain("SUMMARY:週次 (改題)");
    expect(stored).toContain("SUMMARY:週次 (ずらした回)");
    // 原本と例外の両方を、新しい etag で返す。
    if (updated.status === "ok") {
      expect(updated.events).toHaveLength(2);
      expect(new Set(updated.events.map((event) => event.etag)).size).toBe(1);
    }
  });

  it("回の削除は EXDATE を足して書き直し、その回の例外を取り除く。新しい回の例外は原本の ETag で足す", async () => {
    const { server, provider, ctx } = setup({ omitEtagOnPut: true });
    server.putDirect("/cal/user/work/series.ics", SERIES);
    const calendar = await workCalendar(provider, ctx);
    const { events } = await readAllPages(provider, ctx, calendar, null);
    const master = events.find((event) => !event.recurrenceId);
    if (!master) throw new Error("原本がありません");
    const masterSnapshot = makeEventSnapshot({
      uid: "series@example.com",
      remoteId: master.remoteId,
      etag: master.etag,
      raw: master.raw,
      summary: "週次",
      startAt: new Date("2026-12-01T01:00:00Z"),
      endAt: new Date("2026-12-01T02:00:00Z"),
      startTimeZone: null,
      endTimeZone: null,
      rrule: "FREQ=WEEKLY",
      exdates: ["2026-12-08T01:00:00Z"],
    });
    const removed = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: master.remoteId,
        etag: master.etag,
        uid: "series@example.com",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: masterSnapshot,
        master: null,
        exceptions: [],
        fields: ["recurrence"],
      },
    );
    expect(removed.status).toBe("ok");
    if (removed.status !== "ok") return;
    // ETag が返らなかったので取り直している。
    expect(server.requests.at(-1)?.method).toBe("GET");
    expect(removed.events.map((event) => event.recurrenceId)).toEqual([null]);
    expect(removed.events[0]?.exdates).toEqual(["2026-12-08T01:00:00Z"]);

    const after = removed.events[0];
    if (!after) throw new Error("原本がありません");
    const exception = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: after.remoteId,
        etag: null,
        uid: "series@example.com",
        recurrenceId: "2026-12-15T01:00:00Z",
        parentRemoteId: after.remoteId,
      },
      {
        event: makeEventSnapshot({
          uid: "series@example.com",
          recurrenceId: "2026-12-15T01:00:00Z",
          summary: "この回だけ午後",
          startAt: new Date("2026-12-15T05:00:00Z"),
          endAt: new Date("2026-12-15T06:00:00Z"),
        }),
        master: {
          ...masterSnapshot,
          etag: after.etag,
          raw: after.raw,
          exdates: after.exdates,
        },
        exceptions: [],
        fields: ["summary", "time"],
      },
    );
    expect(exception.status).toBe("ok");
    const put = server.requests
      .filter((request) => request.method === "PUT")
      .at(-1);
    expect(put?.headers.get("if-match")).toBe(after.etag);
    if (exception.status === "ok") {
      expect(
        exception.events.map((event) => [event.recurrenceId, event.summary]),
      ).toEqual([
        [null, "週次"],
        ["2026-12-15T01:00:00Z", "この回だけ午後"],
      ]);
    }
  });

  it("例外の行の削除と出欠の返事も、リソースを書き直して行う", async () => {
    const { server, provider, ctx } = setup();
    server.putDirect(
      "/cal/user/work/invite.ics",
      vcalendar(
        vevent([
          "UID:invite",
          "DTSTART:20261201T010000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
          "SUMMARY:招待",
          "ORGANIZER:mailto:boss@example.com",
          "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:user@example.com",
        ]),
        vevent({
          UID: "invite",
          "RECURRENCE-ID": "20261202T010000Z",
          DTSTART: "20261202T020000Z",
          SUMMARY: "招待 (2 日目)",
        }),
      ),
    );
    const calendar = await workCalendar(provider, ctx);
    const { events } = await readAllPages(provider, ctx, calendar, null);
    expect(events[0]?.attendees[0]?.self).toBe(true);
    const ref = {
      remoteId: "/cal/user/work/invite.ics",
      etag: events[0]?.etag ?? null,
      uid: "invite",
      recurrenceId: null,
      parentRemoteId: null,
    };
    const replied = await provider.respond(ctx, calendar, ref, {
      status: "accepted",
      comment: null,
    });
    expect(replied.status).toBe("ok");
    if (replied.status !== "ok") return;
    expect(replied.events[0]?.attendees[0]?.status).toBe("accepted");
    expect(server.resources.get(ref.remoteId)?.data).toContain("RSVP=TRUE");

    const deleted = await provider.deleteEvent(ctx, calendar, {
      ...ref,
      etag: replied.events[0]?.etag ?? null,
      recurrenceId: "2026-12-02T01:00:00Z",
      parentRemoteId: ref.remoteId,
    });
    expect(deleted.status).toBe("ok");
    const left = await provider.getEvent(ctx, calendar, ref);
    expect(left?.map((event) => event.recurrenceId)).toEqual([null]);
    expect(left?.[0]?.exdates).toEqual(["2026-12-02T01:00:00Z"]);
  });

  it("読み取り専用のカレンダーへの書き込みは rejected", async () => {
    const { provider, ctx } = setup({
      calendars: [
        { path: "/cal/user/work/", displayName: "仕事", readOnly: true },
      ],
    });
    const calendar = await workCalendar(provider, ctx);
    expect(calendar.readOnly).toBe(true);
    const result = await provider.createEvent(ctx, calendar, {
      event: makeEventSnapshot(),
      master: null,
      exceptions: [],
      fields: [],
    });
    expect(result.status).toBe("rejected");
  });
});

describe("CalDAV (レビューの指摘)", () => {
  /** VCALENDAR が無いので parseICalendar が ICalendarError を投げる (calendar-query には残る)。 */
  const BROKEN = "BEGIN:VEVENT\r\nUID:broken@example.com\r\nEND:VEVENT\r\n";

  for (const syncCollection of [true, false]) {
    it(`全件同期で読めないリソースは keptRemoteIds で返す (sync-collection ${syncCollection ? "あり" : "なし"})`, async () => {
      const { server, provider, ctx } = setup({ syncCollection });
      server.putDirect("/cal/user/work/series.ics", SERIES);
      server.putDirect("/cal/user/work/broken.ics", BROKEN);
      const calendar = await workCalendar(provider, ctx);
      const delta = await provider.syncEvents(ctx, calendar, {
        syncToken: null,
        pageCursor: null,
        knownEtags: async () => new Map(),
        knownEvents: async () => new Map(),
      });
      expect(delta.full).toBe(true);
      expect(delta.keptRemoteIds).toEqual(["/cal/user/work/broken.ics"]);
      expect(
        delta.events.some(
          (event) => event.remoteId === "/cal/user/work/broken.ics",
        ),
      ).toBe(false);
      expect(
        delta.events.filter(
          (event) => event.remoteId === "/cal/user/work/series.ics",
        ),
      ).toHaveLength(2);
    });
  }

  it("etag の無い行の書き換えは、いまの内容を GET してその ETag で PUT する (If-Match: * で古い raw を基にしない)", async () => {
    const { server, provider, ctx } = setup();
    server.putDirect("/cal/user/work/series.ics", SERIES);
    const calendar = await workCalendar(provider, ctx);
    const { events } = await readAllPages(provider, ctx, calendar, null);
    const master = events.find(
      (event) => event.uid === "series@example.com" && !event.recurrenceId,
    );
    if (!master) throw new Error("原本がありません");
    // 相手側で項目が足された (手元の raw は古い)。
    server.putDirect(
      "/cal/user/work/series.ics",
      SERIES.replace(
        "SUMMARY:週次\r\n",
        "SUMMARY:週次\r\nX-NEW-ON-SERVER:1\r\n",
      ),
    );
    const current = server.resources.get("/cal/user/work/series.ics");
    server.requests.length = 0;
    const result = await provider.updateEvent(
      ctx,
      calendar,
      {
        remoteId: master.remoteId,
        etag: null,
        uid: "series@example.com",
        recurrenceId: null,
        parentRemoteId: null,
      },
      {
        event: makeEventSnapshot({
          uid: "series@example.com",
          remoteId: master.remoteId,
          etag: null,
          raw: master.raw,
          summary: "週次 (改題)",
          rrule: "FREQ=WEEKLY",
        }),
        master: null,
        exceptions: [],
        fields: ["summary"],
      },
    );
    expect(result.status).toBe("ok");
    const methods = server.requests.map((request) => request.method);
    expect(methods.indexOf("GET")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("GET")).toBeLessThan(methods.indexOf("PUT"));
    const put = server.requests.find((request) => request.method === "PUT");
    expect(put?.headers.get("if-match")).toBe(current?.etag);
    expect(put?.body).toContain("X-NEW-ON-SERVER:1");
    expect(put?.body).toContain("SUMMARY:週次 (改題)");
  });

  it("参加者のいる予定を作ると、アカウントのアドレスを ORGANIZER に書く", async () => {
    const { server, provider, ctx } = setup();
    const calendar = await workCalendar(provider, ctx);
    const snapshot = makeEventSnapshot({
      organizer: null,
      attendees: [
        {
          email: "bob@example.com",
          name: "Bob",
          role: "required",
          status: "needs_action",
          self: false,
        },
      ] as ReturnType<typeof makeEventSnapshot>["attendees"],
    });
    const created = await provider.createEvent(
      { ...ctx, account: { ...ctx.account, displayName: "User" } },
      calendar,
      { event: snapshot, master: null, exceptions: [], fields: [] },
    );
    expect(created.status).toBe("ok");
    const put = server.requests.find((request) => request.method === "PUT");
    const body = put?.body.replace(/\r\n /g, "") ?? "";
    expect(body).toContain("ORGANIZER;CN=User:mailto:user@example.com");
    expect(body).toMatch(
      /ATTENDEE[^\r\n]*RSVP=TRUE[^\r\n]*:mailto:bob@example\.com/,
    );
  });
});

describe("CalDAV の招待と出欠 (段取り 8)", () => {
  it("calendar-auto-schedule を返すサーバーなら providerState.autoSchedule が true", async () => {
    const { server, provider, ctx } = setup({ autoSchedule: true });
    const calendar = await workCalendar(provider, ctx);
    expect(calendar.providerState).toMatchObject({ autoSchedule: true });
    // アカウント単位で 1 回だけ尋ねる。
    expect(
      server.requests.filter((request) => request.method === "OPTIONS"),
    ).toHaveLength(1);
  });

  it("返さないサーバーと、OPTIONS に対応しない (405) サーバーは false", async () => {
    const plain = setup();
    expect(
      (await workCalendar(plain.provider, plain.ctx)).providerState,
    ).toMatchObject({ autoSchedule: false });
    const unsupported = setup({ optionsStatus: 405 });
    expect(
      (await workCalendar(unsupported.provider, unsupported.ctx)).providerState,
    ).toMatchObject({ autoSchedule: false });
    // コレクションで失敗したら、ホームでも尋ねる。
    expect(
      unsupported.server.requests.filter(
        (request) => request.method === "OPTIONS",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("レビュー 8: OPTIONS が一時的に失敗 (5xx) したら autoSchedule を書かず、前の値を残す", async () => {
    const failing = setup({ optionsStatus: 503 });
    const list = await failing.provider.listCalendars(failing.ctx);
    const remote = list.find((entry) => entry.name === "仕事");
    expect(remote?.providerState).toBeDefined();
    expect(remote?.providerState).not.toHaveProperty("autoSchedule");
    // 保存は providerState に浅く重ねる (upsertAccountCalendars) ので、前の true が残る。
    const input = toAccountCalendarInput(remote as RemoteCalendar);
    expect({
      autoSchedule: true,
      ...(input.providerState ?? {}),
    }).toMatchObject({ autoSchedule: true });
  });

  it("ORGANIZER がアカウントのアドレスなら主催者の印を付ける", async () => {
    const { server, provider, ctx } = setup();
    server.putDirect(
      "/cal/user/work/mine.ics",
      vcalendar(
        vevent([
          "UID:mine",
          "DTSTART:20261201T010000Z",
          "SUMMARY:自分の会議",
          "ORGANIZER:mailto:User@Example.com",
          "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com",
        ]),
      ),
    );
    server.putDirect(
      "/cal/user/work/theirs.ics",
      vcalendar(
        vevent([
          "UID:theirs",
          "DTSTART:20261201T010000Z",
          "SUMMARY:招待",
          "ORGANIZER:mailto:boss@example.com",
          "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user@example.com",
        ]),
      ),
    );
    const calendar = await workCalendar(provider, ctx);
    const { events } = await readAllPages(provider, ctx, calendar, null);
    const byUid = new Map(events.map((event) => [event.uid, event]));
    expect(byUid.get("mine")?.organizer).toMatchObject({ self: true });
    expect(byUid.get("theirs")?.organizer).toMatchObject({
      email: "boss@example.com",
      self: false,
    });
  });

  it("返事は自分の PARTSTAT だけを変え、SEQUENCE とほかの参加者の行は変えない", async () => {
    const { server, provider, ctx } = setup();
    server.putDirect(
      "/cal/user/work/invite.ics",
      vcalendar(
        vevent([
          "UID:invite",
          "SEQUENCE:4",
          "DTSTART:20261201T010000Z",
          "SUMMARY:招待",
          "ORGANIZER:mailto:boss@example.com",
          "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:user@example.com",
          "ATTENDEE;PARTSTAT=ACCEPTED;SCHEDULE-STATUS=2.0;X-CUSTOM=1:mailto:carol@example.com",
        ]),
      ),
    );
    const calendar = await workCalendar(provider, ctx);
    const { events } = await readAllPages(provider, ctx, calendar, null);
    const replied = await provider.respond(
      ctx,
      calendar,
      {
        remoteId: "/cal/user/work/invite.ics",
        etag: events[0]?.etag ?? null,
        uid: "invite",
        recurrenceId: null,
        parentRemoteId: null,
      },
      { status: "declined", comment: null },
    );
    expect(replied.status).toBe("ok");
    const data = (
      server.resources.get("/cal/user/work/invite.ics")?.data ?? ""
    ).replace(/\r\n /g, "");
    expect(data).toContain("SEQUENCE:4");
    expect(data).toMatch(
      /ATTENDEE[^\r\n]*PARTSTAT=DECLINED[^\r\n]*:mailto:user@example\.com/,
    );
    // ほかの参加者の出欠と、知らないパラメータは残る (並び順は変わってよい)。
    const carol = data
      .split("\r\n")
      .find((line) => line.endsWith(":mailto:carol@example.com"));
    expect(carol).toContain("PARTSTAT=ACCEPTED");
    expect(carol).toContain("SCHEDULE-STATUS=2.0");
    expect(carol).toContain("X-CUSTOM=1");
  });
});
