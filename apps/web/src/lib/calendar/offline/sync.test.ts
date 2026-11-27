import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSyncPage } from "@/lib/calendar/api";
import { OfflineCalendarClient } from "@/lib/calendar/offline/client";
import { pullChanges } from "@/lib/calendar/offline/sync";
import {
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";

const page = (overrides: Partial<CalendarSyncPage>): CalendarSyncPage => ({
  calendars: [],
  events: [],
  deleted: { calendars: [], events: [] },
  latestSeq: "0",
  hasMore: false,
  ...overrides,
});

describe("pullChanges", () => {
  it("hasMore の間ページを送り、ページごとに保存する", async () => {
    const pages = [
      page({ latestSeq: "2", hasMore: true }),
      page({ latestSeq: "4", hasMore: true }),
      page({ latestSeq: "5", openConflicts: 1, conflictsAt: "t" }),
    ];
    const asked: string[] = [];
    const applied: string[] = [];
    const result = await pullChanges("0", {
      fetchPage: async (since) => {
        asked.push(since);
        return pages.shift() ?? page({ latestSeq: since });
      },
      apply: async (p) => {
        applied.push(p.latestSeq);
      },
    });
    expect(asked).toEqual(["0", "2", "4"]);
    expect(applied).toEqual(["2", "4", "5"]);
    expect(result).toEqual({
      cursor: "5",
      pages: 3,
      openConflicts: 1,
      conflictsAt: "t",
    });
  });

  it("位置が進まないページで止まる (無限に回らない)", async () => {
    const fetchPage = vi.fn(async () =>
      page({ latestSeq: "3", hasMore: true }),
    );
    const result = await pullChanges("3", { fetchPage, apply: async () => {} });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.cursor).toBe("3");
  });
});

describe("client の同期", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("削除を反映し、途中で失敗しても保存した位置から続ける", async () => {
    const server = new FakeCalendarServer();
    server.pageSize = 2;
    for (const id of ["a", "b", "c", "d"]) {
      server.addEvent(event({ id, summary: id }));
    }
    const store = persistentStore();
    const api = server.api();
    // 2 ページ目で届かなくなる。
    let calls = 0;
    const flaky = await OfflineCalendarClient.open({
      userId: "u1",
      store,
      api: {
        ...api,
        syncCalendars: async (since) => {
          calls += 1;
          if (calls === 2) throw new Error("network");
          return api.syncCalendars(since);
        },
      },
    });
    await flaky.pull();
    expect(await store.get("calMeta", "cursor")).toBe("2");
    expect(await store.get("calMeta", "initialSyncDone")).toBeUndefined();

    server.calls.length = 0;
    await flaky.pull();
    expect(server.calls.filter((c) => c.startsWith("sync"))).toEqual([
      "sync 2",
      "sync 4",
    ]);
    expect(await store.get("calMeta", "initialSyncDone")).toBe(true);
    expect((await store.keys("calEvents")).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);

    server.remove("b");
    server.change("c", { summary: "変更" });
    await flaky.pull();
    expect((await store.keys("calEvents")).sort()).toEqual(["a", "c", "d"]);
    const range = flaky.range({
      from: "2026-03-01",
      to: "2026-04-01",
      timeZone: "Asia/Tokyo",
    });
    expect(range?.events.map((e) => e.summary).sort()).toEqual([
      "a",
      "d",
      "変更",
    ]);
    flaky.close();
  });

  it("送信の応答で入れた新しい値を、古いページで戻さない", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: "a", summary: "古い" }));
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: server.api(),
    });
    await client.pull();
    const stale = server.events.get("a");
    client.updateEvent("a", { summary: "新しい" });
    await client.flush();
    // 先に取り始めていたページ (変更の前の行) が後から届いた。
    await (
      client as unknown as {
        applyPage: (p: CalendarSyncPage) => Promise<void>;
      }
    ).applyPage(page({ events: stale ? [stale] : [], latestSeq: "1" }));
    const range = client.range({
      from: "2026-03-01",
      to: "2026-04-01",
      timeZone: "Asia/Tokyo",
    });
    expect(range?.events[0]?.summary).toBe("新しい");
    client.close();
  });

  it("同期し直すと、端末の控えを消して since=0 から取り直す (送信待ちは残す)", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: "a" }));
    const store = persistentStore();
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store,
      api: server.api(),
    });
    await client.pull();
    await store.write([
      {
        type: "put",
        table: "calEvents",
        key: "ghost",
        value: event({ id: "ghost" }),
      },
    ]);
    server.online = false;
    client.updateEvent("a", { summary: "変更" });
    await vi.advanceTimersByTimeAsync(0);
    server.online = true;
    server.calls.length = 0;
    await client.resync();
    expect(server.calls).toContain("sync 0");
    expect((await store.keys("calEvents")).sort()).toEqual(["a"]);
    expect(client.queue()).toHaveLength(1);
    expect(
      client.range({ from: "2026-03-01", to: "2026-04-01", timeZone: "UTC" })
        ?.events[0]?.summary,
    ).toBe("変更");
    client.close();
  });
});
