import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientApi } from "@/lib/calendar/offline/client";
import { OfflineCalendarClient } from "@/lib/calendar/offline/client";
import { createMemoryShareHub } from "@/lib/calendar/offline/share";
import {
  CALENDAR_ID,
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";

/** 削除の「元に戻す」(holdForUndo)。 */

const RANGE = { from: "2026-03-01", to: "2026-04-01", timeZone: "Asia/Tokyo" };
const E1 = "00000000-0000-4000-8000-000000000e01";
const HOLD = 7_000;

async function setup(
  server = new FakeCalendarServer(),
  store = persistentStore(),
) {
  const client = await OfflineCalendarClient.open({
    userId: "u1",
    store,
    api: server.api(),
    retryMs: 1_000,
  });
  client.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await client.pull();
  await client.flush();
  return { client, server, store };
}

const summaries = (client: OfflineCalendarClient) => {
  const range = client.range(RANGE);
  return range?.occurrences.map(
    (o) => range.events.find((e) => e.id === o.eventId)?.summary,
  );
};

const deletes = (server: FakeCalendarServer) =>
  server.calls.filter((call) => /^(delete|respond|occurrence)/.test(call));

const invited = () =>
  event({
    id: E1,
    organizer: { email: "boss@example.com", self: false },
    attendees: [
      {
        email: "me@example.com",
        name: null,
        role: "required",
        status: "needs_action",
        self: true,
      },
    ],
  });

describe("削除の「元に戻す」", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("待っている間は送らず、元に戻すと送らずに予定が戻る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    server.calls.length = 0;
    const pending = client.holdForUndo(() => client.deleteEvent(E1), HOLD);
    expect(summaries(client)).toEqual([]);
    await vi.advanceTimersByTimeAsync(HOLD - 1);
    await client.flush();
    expect(deletes(server)).toEqual([]);
    await expect(pending.undo()).resolves.toBe(true);
    expect(summaries(client)).toEqual(["定例"]);
    expect(client.queue()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deletes(server)).toEqual([]);
    expect(server.events.has(E1)).toBe(true);
  });

  it("release ですぐ送り、送った後の元に戻すは false で、予定を作り直さない", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const { client } = await setup(server);
    const pending = client.holdForUndo(() => client.deleteEvent(E1), HOLD);
    pending.release();
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();
    expect(server.events.has(E1)).toBe(false);
    await expect(pending.undo()).resolves.toBe(false);
    expect(summaries(client)).toEqual([]);
    expect(server.calls.filter((call) => call.startsWith("create"))).toEqual(
      [],
    );
  });

  it("送り始めた後 (送っている最中) は元に戻せず、削除はそのまま送る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const real = server.api();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const api: ClientApi = {
      ...real,
      deleteEvent: async (...args) => {
        await gate;
        return real.deleteEvent(...args);
      },
    };
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api,
    });
    client.subscribe(() => {});
    await client.pull();
    const pending = client.holdForUndo(() => client.deleteEvent(E1), HOLD);
    // release を呼ぶ前にウィンドウの処理が止まっても、時刻を過ぎたら送る。
    await vi.advanceTimersByTimeAsync(HOLD + 3_000);
    const undone = pending.undo();
    open();
    await expect(undone).resolves.toBe(false);
    await client.flush();
    expect(server.events.has(E1)).toBe(false);
    expect(client.queue()).toEqual([]);
  });

  it("繰り返しの「この回だけ」の削除を元に戻す", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(
      event({ id: "m1", rrule: "FREQ=WEEKLY;COUNT=3", summary: "週次" }),
    );
    const { client } = await setup(server);
    server.calls.length = 0;
    const pending = client.holdForUndo(
      () => client.deleteOccurrence("m1", "2026-03-09T01:00:00Z"),
      HOLD,
    );
    expect(summaries(client)).toEqual(["週次", "週次"]);
    await expect(pending.undo()).resolves.toBe(true);
    expect(summaries(client)).toEqual(["週次", "週次", "週次"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deletes(server)).toEqual([]);
  });

  it("繰り返しの「すべて」の削除を元に戻すと、前からの送信待ちの変更は残る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(
      event({ id: "m1", rrule: "FREQ=WEEKLY;COUNT=3", summary: "週次" }),
    );
    const { client } = await setup(server);
    server.online = false;
    client.updateEvent("m1", { location: "会議室" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.queue().map((op) => op.kind)).toEqual(["update"]);
    const pending = client.holdForUndo(() => client.deleteEvent("m1"), HOLD);
    expect(client.queue().map((op) => op.kind)).toEqual(["update", "delete"]);
    expect(summaries(client)).toEqual([]);
    await expect(pending.undo()).resolves.toBe(true);
    expect(client.queue().map((op) => op.kind)).toEqual(["update"]);
    expect(summaries(client)).toEqual(["週次", "週次", "週次"]);
    server.online = true;
    client.retryNow();
    await client.flush();
    expect(server.events.get("m1")).toMatchObject({ location: "会議室" });
  });

  it("まだ送っていない予定の削除を元に戻すと、作成が送信待ちに戻る", async () => {
    const server = new FakeCalendarServer();
    const { client } = await setup(server);
    server.online = false;
    const id = client.createEvent({
      calendarId: CALENDAR_ID,
      summary: "新しい予定",
      time: {
        allDay: false,
        startAt: "2026-03-03T01:00:00Z",
        endAt: "2026-03-03T02:00:00Z",
        startTimeZone: "Asia/Tokyo",
      },
    });
    const pending = client.holdForUndo(() => client.deleteEvent(id), HOLD);
    expect(client.queue()).toEqual([]);
    await expect(pending.undo()).resolves.toBe(true);
    expect(summaries(client)).toEqual(["新しい予定"]);
    server.online = true;
    client.retryNow();
    await client.flush();
    expect(server.events.get(id)?.summary).toBe("新しい予定");
  });

  it("不参加にして削除: 送る前なら返事ごと取り消す", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(invited());
    const { client } = await setup(server);
    server.calls.length = 0;
    const pending = client.holdForUndo(() => {
      client.respond(E1, "declined");
      client.deleteEvent(E1);
    }, HOLD);
    await client.flush();
    expect(deletes(server)).toEqual([]);
    await expect(pending.undo()).resolves.toBe(true);
    expect(client.queue()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deletes(server)).toEqual([]);
    expect(server.events.get(E1)?.attendees[0]?.status).toBe("needs_action");
  });

  it("不参加にして削除: 受け付けを終えたら返事を先に送り、その後は元に戻せない", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(invited());
    const { client } = await setup(server);
    server.calls.length = 0;
    const pending = client.holdForUndo(() => {
      client.respond(E1, "declined");
      client.deleteEvent(E1);
    }, HOLD);
    pending.release();
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();
    expect(deletes(server)).toEqual([`respond ${E1}`, `delete ${E1}`]);
    await expect(pending.undo()).resolves.toBe(false);
  });

  it("オフラインでも元に戻せ、戻さなければ届くようになってから送る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    server.addEvent(event({ id: "e2", summary: "別の予定" }));
    const { client } = await setup(server);
    server.online = false;
    const first = client.holdForUndo(() => client.deleteEvent(E1), HOLD);
    await expect(first.undo()).resolves.toBe(true);
    const second = client.holdForUndo(() => client.deleteEvent("e2"), HOLD);
    second.release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.queue().map((op) => [op.kind, op.eventId])).toEqual([
      ["delete", "e2"],
    ]);
    server.online = true;
    client.retryNow();
    await client.flush();
    expect(server.events.has("e2")).toBe(false);
    expect(server.events.has(E1)).toBe(true);
  });

  it("待っている削除の後ろの、同じ予定への操作も待たせる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    server.addEvent(event({ id: "e2", summary: "別の予定" }));
    const { client } = await setup(server);
    server.calls.length = 0;
    client.holdForUndo(() => client.deleteEvent(E1), HOLD);
    client.updateEvent("e2", { summary: "変更" });
    await client.flush();
    // 別の予定への操作は待たない。
    expect(server.events.get("e2")?.summary).toBe("変更");
    expect(server.events.has(E1)).toBe(true);
  });

  describe("複数のウィンドウ", () => {
    async function twoWindows() {
      const server = new FakeCalendarServer();
      server.addEvent(event({ id: E1 }));
      const store = persistentStore();
      const hub = createMemoryShareHub();
      const open = () =>
        OfflineCalendarClient.open({
          userId: "u1",
          store,
          api: server.api(),
          share: hub.create("u1"),
        });
      const a = await open();
      const b = await open();
      a.subscribe(() => {});
      b.subscribe(() => {});
      await a.pull();
      await b.pull();
      server.calls.length = 0;
      return { server, a, b };
    }

    it("ほかのウィンドウは待っている削除を送らず、元に戻すと両方で戻る", async () => {
      const { server, a, b } = await twoWindows();
      const pending = a.holdForUndo(() => a.deleteEvent(E1), HOLD);
      await vi.advanceTimersByTimeAsync(0);
      expect(b.queue()).toHaveLength(1);
      expect(summaries(b)).toEqual([]);
      await b.flush();
      expect(deletes(server)).toEqual([]);
      await expect(pending.undo()).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(b.queue()).toEqual([]);
      expect(summaries(b)).toEqual(["定例"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deletes(server)).toEqual([]);
      a.close();
      b.close();
    });

    it("release の前にウィンドウが閉じたら、時刻を過ぎてからほかのウィンドウが送る", async () => {
      const { server, a, b } = await twoWindows();
      a.holdForUndo(() => a.deleteEvent(E1), HOLD);
      await vi.advanceTimersByTimeAsync(0);
      a.close();
      await vi.advanceTimersByTimeAsync(HOLD);
      expect(deletes(server)).toEqual([]);
      await vi.advanceTimersByTimeAsync(3_000);
      await b.flush();
      expect(deletes(server)).toEqual([`delete ${E1}`]);
      expect(b.queue()).toEqual([]);
      b.close();
    });

    it("release はほかのウィンドウが送る役でも、すぐ送られる", async () => {
      const { server, a, b } = await twoWindows();
      const pending = a.holdForUndo(() => a.deleteEvent(E1), HOLD);
      await vi.advanceTimersByTimeAsync(0);
      pending.release();
      await vi.advanceTimersByTimeAsync(0);
      await a.flush();
      await b.flush();
      expect(deletes(server)).toEqual([`delete ${E1}`]);
      a.close();
      b.close();
    });
  });
});
