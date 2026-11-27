import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  OfflineCalendarClient,
  OfflineUnavailableError,
} from "@/lib/calendar/offline/client";
import {
  CALENDAR_ID,
  calendar,
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";
import { MemoryStore } from "@/lib/offline/store";

const RANGE = { from: "2026-03-01", to: "2026-04-01", timeZone: "Asia/Tokyo" };
const E1 = "00000000-0000-4000-8000-000000000e01";

async function setup(
  server = new FakeCalendarServer(),
  store = persistentStore(),
  online = () => true,
) {
  const client = await OfflineCalendarClient.open({
    userId: "u1",
    store,
    api: server.api(),
    isOnline: online,
    retryMs: 1_000,
  });
  return { client, server, store };
}

/** 画面が開いたことにして、初回の同期を終える。 */
async function activate(client: OfflineCalendarClient) {
  const unsubscribe = client.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await client.pull();
  await client.flush();
  return unsubscribe;
}

const summaries = (client: OfflineCalendarClient) =>
  client
    .range(RANGE)
    ?.occurrences.map(
      (o) =>
        client.range(RANGE)?.events.find((e) => e.id === o.eventId)?.summary,
    );

describe("OfflineCalendarClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("初回は表示中の期間を先に取り、裏で全件を同期する", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    expect(client.range(RANGE)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(summaries(client)).toEqual(["定例"]);
    expect(server.calls).toContain("events");
    await activate(client);
    expect(client.calendars()?.map((c) => c.id)).toEqual([CALENDAR_ID]);
    // 同期を終えた後は、サーバーに聞かずに端末で展開する。
    server.calls.length = 0;
    expect(
      client.range({ ...RANGE, from: "2026-02-01", to: "2026-03-01" }),
    ).toEqual({ events: [], occurrences: [] });
    expect(server.calls).toEqual([]);
  });

  it("オフラインで作った予定はすぐ出て、届くようになったら送る", async () => {
    const { client, server } = await setup();
    await activate(client);
    server.online = false;
    const listener = vi.fn();
    client.subscribe(listener);
    const id = client.createEvent({
      calendarId: CALENDAR_ID,
      summary: "オフラインで作成",
      time: {
        allDay: false,
        startAt: "2026-03-03T01:00:00Z",
        endAt: "2026-03-03T02:00:00Z",
        startTimeZone: "Asia/Tokyo",
      },
    });
    expect(listener).toHaveBeenCalled();
    expect(summaries(client)).toEqual(["オフラインで作成"]);
    expect(client.pendingFor(id)).toHaveLength(1);
    client.updateEvent(id, { location: "会議室" });
    // 未送信の作成にまとめられる。
    expect(client.queue()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);

    server.online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.queue()).toEqual([]);
    expect(server.events.get(id)).toMatchObject({
      summary: "オフラインで作成",
      location: "会議室",
    });
    // 作った時刻 (changedAt) と送った時刻 (clientNow) を添える。
    expect(server.bodies.at(-1)).toMatchObject({
      id,
      changedAt: expect.any(String),
      clientNow: expect.any(Date),
    });
    expect(summaries(client)).toEqual(["オフラインで作成"]);
  });

  it("保存先が残らない環境では、オフライン中の変更を預からない", async () => {
    const { client } = await setup(
      new FakeCalendarServer(),
      new MemoryStore(),
      () => false,
    );
    expect(() =>
      client.updateCalendar(CALENDAR_ID, { visible: false }),
    ).toThrow(OfflineUnavailableError);
  });

  it("rejected の項目は「反映されなかった変更」に控え、戻せる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    await activate(client);
    server.rejectFields.add("summary");
    client.updateEvent(E1, { summary: "自分の題名", location: "会議室" });
    await client.flush();
    expect(server.events.get(E1)).toMatchObject({
      summary: "定例",
      location: "会議室",
    });
    const [notice] = client.conflicts();
    expect(notice).toMatchObject({
      source: "local",
      kind: "rejected",
      fields: ["summary"],
      lost: { summary: "自分の題名" },
      kept: { summary: "定例" },
      actions: ["restore", "dismiss"],
    });
    server.rejectFields.clear();
    await client.resolveConflict(notice?.id ?? "", "restore");
    await client.flush();
    expect(server.events.get(E1)?.summary).toBe("自分の題名");
    expect(client.conflicts()).toEqual([]);
  });

  it("削除の後にほかの端末で変更されていたら (changed_since)、削除を取り下げて知らせる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    await activate(client);
    server.changedSince.add(E1);
    client.deleteEvent(E1);
    expect(summaries(client)).toEqual([]);
    await client.flush();
    expect(summaries(client)).toEqual(["定例"]);
    const [notice] = client.conflicts();
    expect(notice).toMatchObject({
      kind: "delete_cancelled",
      actions: ["delete", "dismiss"],
    });
    // 「やはり削除」は、いまの時刻で送り直す。
    server.changedSince.clear();
    await client.resolveConflict(notice?.id ?? "", "delete");
    await client.flush();
    expect(server.events.has(E1)).toBe(false);
    expect(summaries(client)).toEqual([]);
  });

  it("ほかの端末で削除された予定への変更は error にし、新しい ID で復元できる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    await activate(client);
    server.online = false;
    client.updateEvent(E1, { summary: "変更" });
    client.updateEvent(E1, { location: "会議室" });
    await vi.advanceTimersByTimeAsync(0);
    server.remove(E1);
    server.online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    const [op] = client.queue();
    expect(op).toMatchObject({ state: "error", error: "deleted_elsewhere" });
    const [notice] = client.conflicts();
    expect(notice).toMatchObject({
      kind: "deleted_elsewhere",
      opId: op?.id,
      snapshot: { summary: "変更", location: "会議室" },
    });
    await client.resolveConflict(notice?.id ?? "", "restore");
    await client.flush();
    expect(client.queue()).toEqual([]);
    const restored = [...server.events.values()];
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ summary: "変更", location: "会議室" });
    expect(restored[0]?.id).not.toBe(E1);
  });

  it("error の操作と同じ予定への後続は待たせ、破棄すると送る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    server.addEvent(event({ id: "e2", summary: "別" }));
    const api = server.api();
    let fail = true;
    // 1 回目の変更だけ断られる。
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: {
        ...api,
        updateEvent: async (...args) => {
          if (fail) {
            fail = false;
            throw new ApiError(409, "read_only", { error: "read_only" });
          }
          return api.updateEvent(...args);
        },
      },
      retryMs: 1_000,
    });
    await activate(client);
    client.updateEvent(E1, { summary: "1" });
    await client.flush();
    client.deleteEvent(E1);
    client.updateEvent("e2", { summary: "2" });
    await client.flush();
    expect(client.queue().map((o) => [o.kind, o.state])).toEqual([
      ["update", "error"],
      ["delete", "pending"],
    ]);
    expect(server.events.get("e2")?.summary).toBe("2");
    expect(client.conflicts()).toMatchObject([
      { kind: "failed", reason: "read_only", actions: ["retry", "dismiss"] },
    ]);
    client.discard(client.queue()[0]?.id ?? "");
    await client.flush();
    expect(client.queue()).toEqual([]);
    expect(server.events.has(E1)).toBe(false);
    expect(client.conflicts()).toEqual([]);
    client.close();
  });

  it("同期が止まったカレンダーの操作は blocked にし、カレンダーが変わったらやり直す", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    await activate(client);
    server.stopped.add(CALENDAR_ID);
    client.updateEvent(E1, { summary: "変更" });
    await client.flush();
    expect(client.queue()[0]).toMatchObject({
      state: "blocked",
      error: "calendar_sync_stopped",
    });
    // 表示は送信待ちのまま。
    expect(summaries(client)).toEqual(["変更"]);
    server.stopped.clear();
    server.addCalendar({
      ...calendar(),
      lastError: null,
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await client.pull();
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();
    expect(client.queue()).toEqual([]);
    expect(server.events.get(E1)?.summary).toBe("変更");
  });

  it("この回だけ変更・削除をオフラインで行い、後で送る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(
      event({ id: "m1", rrule: "FREQ=WEEKLY;COUNT=3", summary: "週次" }),
    );
    const { client } = await setup(server);
    await activate(client);
    server.online = false;
    client.updateOccurrence("m1", "2026-03-09T01:00:00.000Z", {
      summary: "この回だけ",
    });
    client.deleteOccurrence("m1", "2026-03-16T01:00:00Z");
    expect(summaries(client)).toEqual(["週次", "この回だけ"]);
    // 仮の例外への変更は、回の変更としてまとめる。
    const provisional = client
      .range(RANGE)
      ?.events.find((e) => e.summary === "この回だけ");
    client.updateEvent(provisional?.id ?? "", { location: "会議室" });
    expect(client.queue().map((o) => o.kind)).toEqual([
      "occurrence_update",
      "occurrence_delete",
    ]);
    expect(client.pendingFor(provisional?.id ?? "")).toHaveLength(1);
    server.online = true;
    client.retryNow();
    await client.flush();
    expect(client.queue()).toEqual([]);
    await client.pull();
    const range = client.range(RANGE);
    expect(
      range?.occurrences.map((o) => [
        o.recurrenceId,
        range.events.find((e) => e.id === o.eventId)?.location ?? null,
      ]),
    ).toEqual([
      ["2026-03-02T01:00:00Z", null],
      ["2026-03-09T01:00:00Z", "会議室"],
    ]);
  });

  it("回の変更で、その回が規則から無くなっていたら error にし、単発の予定として作れる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(
      event({ id: "m1", rrule: "FREQ=WEEKLY;COUNT=3", summary: "週次" }),
    );
    const { client } = await setup(server);
    await activate(client);
    server.invalidOccurrences.add("2026-03-09T01:00:00Z");
    client.updateOccurrence("m1", "2026-03-09T01:00:00Z", {
      summary: "この回だけ",
    });
    await client.flush();
    const [notice] = client.conflicts();
    expect(notice).toMatchObject({ kind: "occurrence_gone" });
    await client.resolveConflict(notice?.id ?? "", "restore");
    await client.flush();
    const single = [...server.events.values()].find(
      (e) => e.summary === "この回だけ",
    );
    expect(single).toMatchObject({
      parentId: null,
      rrule: null,
      startAt: "2026-03-09T01:00:00.000Z",
    });
  });

  it("送信待ちは開き直しても残り、続きから送る", async () => {
    const store = persistentStore();
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const first = await setup(server, store);
    await activate(first.client);
    server.online = false;
    first.client.updateEvent(E1, { summary: "変更" });
    await vi.advanceTimersByTimeAsync(0);
    first.client.close();

    server.online = true;
    const second = await setup(server, store);
    expect(second.client.queue()).toHaveLength(1);
    await second.client.flush();
    expect(server.events.get(E1)?.summary).toBe("変更");
    second.client.close();
  });

  it("サーバーに届かないときは、端末の控えから探す", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1, summary: "歯医者" }));
    const { client } = await setup(server);
    await activate(client);
    server.online = false;
    expect((await client.search("歯医者")).map((e) => e.id)).toEqual([E1]);
  });

  it("サーバーの競合の記録を取り込み、自分の値に戻せる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1, location: "相手側の場所" }));
    server.conflicts = [
      {
        id: "k1",
        calendarId: CALENDAR_ID,
        eventId: E1,
        kind: "field_lost",
        fields: ["location"],
        lost: { location: "自分の場所" },
        snapshot: null,
        title: "定例",
        reason: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        resolvedAt: null,
      },
    ];
    const { client } = await setup(server);
    await activate(client);
    expect(client.conflicts()).toMatchObject([
      {
        id: "k1",
        source: "server",
        kept: { location: "相手側の場所" },
        actions: ["restore", "dismiss"],
      },
    ]);
    await client.resolveConflict("k1", "restore");
    await client.flush();
    expect(server.calls).toContain("dismiss k1");
    expect(server.events.get(E1)?.location).toBe("自分の場所");
    expect(client.conflicts()).toEqual([]);
  });

  it("古いサーバー (/sync に競合の項目が無い) では、競合の一覧を取りに行かない", async () => {
    const server = new FakeCalendarServer();
    const { client } = await setup(server);
    await activate(client);
    expect(server.calls).not.toContain("conflicts");
    expect(client.conflicts()).toEqual([]);
  });
});
