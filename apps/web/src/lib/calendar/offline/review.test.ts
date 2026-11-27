import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "@/lib/api";
import { OfflineCalendarClient } from "@/lib/calendar/offline/client";
import { createMemoryShareHub } from "@/lib/calendar/offline/share";
import {
  CALENDAR_ID,
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";
import type { QueuedOp } from "@/lib/calendar/offline/types";
import type { LocalStore, WriteOp } from "@/lib/offline/store";

/**
 * 段取り 7 のレビューで見つかった、送信待ちの変更が消える筋道 (review-offline.md の端末 1〜6、低)。
 */

const RANGE = { from: "2026-03-01", to: "2026-04-01", timeZone: "Asia/Tokyo" };
const E1 = "00000000-0000-4000-8000-000000000e01";
const TIME = {
  allDay: false as const,
  startAt: "2026-03-03T01:00:00Z",
  endAt: "2026-03-03T02:00:00Z",
  startTimeZone: "Asia/Tokyo",
};

async function activate(client: OfflineCalendarClient) {
  client.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await client.pull();
  await client.flush();
}

/** 作成は届くが、最初の 1 回だけ応答が失われる API。 */
function dropFirstCreateResponse(server: FakeCalendarServer) {
  const real = server.api();
  let drop = true;
  return {
    ...real,
    createEvent: async (...args: Parameters<typeof real.createEvent>) => {
      const result = await real.createEvent(...args);
      if (drop) {
        drop = false;
        throw new NetworkError();
      }
      return result;
    },
  };
}

describe("送信待ちの変更が消えない (レビュー指摘)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("1: 応答が失われた作成の後の変更は、作成にまとめず別の変更として送る", async () => {
    const server = new FakeCalendarServer();
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: dropFirstCreateResponse(server),
      retryMs: 1000,
    });
    await activate(client);
    const id = client.createEvent({
      calendarId: CALENDAR_ID,
      summary: "作成",
      time: TIME,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(server.events.has(id)).toBe(true);
    expect(client.queue()[0]?.attempted).toBe(true);
    client.updateEvent(id, { summary: "題名を変更" });
    expect(client.queue().map((op) => op.kind)).toEqual(["create", "update"]);
    await vi.advanceTimersByTimeAsync(5000);
    await client.flush();
    expect(client.queue()).toEqual([]);
    expect(server.events.get(id)?.summary).toBe("題名を変更");
  });

  it("2: 応答が失われた作成の後の削除は、作成を残して削除を送る", async () => {
    const server = new FakeCalendarServer();
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: dropFirstCreateResponse(server),
      retryMs: 1000,
    });
    await activate(client);
    const id = client.createEvent({
      calendarId: CALENDAR_ID,
      summary: "作成",
      time: TIME,
    });
    await vi.advanceTimersByTimeAsync(10);
    client.deleteEvent(id);
    expect(client.queue().map((op) => op.kind)).toEqual(["create", "delete"]);
    expect(client.range(RANGE)?.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    await client.flush();
    expect(server.events.has(id)).toBe(false);
    expect(server.calls).toContain(`delete ${id}`);
    await client.pull();
    expect(client.range(RANGE)?.events).toEqual([]);
  });

  describe("3: 別のタブが送っている最中の操作", () => {
    async function twoTabs() {
      const server = new FakeCalendarServer();
      server.addEvent(event({ id: E1 }));
      const real = server.api();
      const gate = { hold: false, release: null as (() => void) | null };
      const slow = {
        ...real,
        updateEvent: async (...args: Parameters<typeof real.updateEvent>) => {
          if (gate.hold) {
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
          }
          return real.updateEvent(...args);
        },
      };
      const store = persistentStore();
      const hub = createMemoryShareHub();
      const open = () =>
        OfflineCalendarClient.open({
          userId: "u1",
          store,
          api: slow,
          share: hub.create("u1"),
          retryMs: 1000,
        });
      const a = await open();
      await activate(a);
      const b = await open();
      await activate(b);
      return { server, store, gate, a, b };
    }

    it("送っている最中の印を見たタブは、その操作にまとめない", async () => {
      const { server, gate, a, b } = await twoTabs();
      gate.hold = true;
      a.updateEvent(E1, { summary: "A の変更" });
      await vi.advanceTimersByTimeAsync(10);
      expect(gate.release).not.toBeNull();
      b.updateEvent(E1, { location: "B の変更" });
      expect(b.queue()).toHaveLength(2);
      gate.hold = false;
      gate.release?.();
      await vi.advanceTimersByTimeAsync(5000);
      await a.flush();
      await b.flush();
      await vi.advanceTimersByTimeAsync(40000);
      expect(server.events.get(E1)).toMatchObject({
        summary: "A の変更",
        location: "B の変更",
      });
      expect(a.queue()).toEqual([]);
      expect(b.queue()).toEqual([]);
    });

    it("印を見る前にまとめられていたら、送った後に残りを送る", async () => {
      const { server, store, gate, a, b } = await twoTabs();
      gate.hold = true;
      a.updateEvent(E1, { summary: "A の変更" });
      await vi.advanceTimersByTimeAsync(10);
      expect(gate.release).not.toBeNull();
      // 別のタブが印を見る前に、保存先の操作へまとめて書いた (印の無い版で上書き)。
      const [sending] = await store.list<QueuedOp>("calQueue");
      if (!sending) throw new Error("no op");
      await store.write([
        {
          type: "put",
          table: "calQueue",
          key: sending.id,
          value: {
            ...sending,
            attempted: false,
            body: { ...(sending.body as object), location: "B の変更" },
            changedAt: {
              ...sending.changedAt,
              location: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      ]);
      gate.hold = false;
      gate.release?.();
      await vi.advanceTimersByTimeAsync(5000);
      await a.flush();
      await b.flush();
      expect(server.events.get(E1)).toMatchObject({
        summary: "A の変更",
        location: "B の変更",
      });
      expect(a.queue()).toEqual([]);
    });
  });

  it("4: 同期が先に削除を取り込んでも、復元すると変更した予定を作る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: server.api(),
      retryMs: 1000,
    });
    await activate(client);
    server.online = false;
    client.updateEvent(E1, { summary: "変更" });
    await vi.advanceTimersByTimeAsync(0);
    server.remove(E1);
    server.online = true;
    await client.pull();
    await vi.advanceTimersByTimeAsync(1000);
    await client.flush();
    const [notice] = client.conflicts();
    expect(notice).toMatchObject({
      kind: "deleted_elsewhere",
      snapshot: { summary: "変更" },
      actions: ["restore", "dismiss"],
    });
    await client.resolveConflict(notice?.id ?? "", "restore");
    await client.flush();
    expect(client.queue()).toEqual([]);
    const restored = [...server.events.values()];
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ summary: "変更" });
    expect(restored[0]?.id).not.toBe(E1);
  });

  it("4: 予定全体が分からない記録には「復元」を出さない", async () => {
    const server = new FakeCalendarServer();
    server.conflicts = [
      {
        id: "k1",
        calendarId: CALENDAR_ID,
        eventId: E1,
        kind: "remote_deleted",
        fields: ["summary"],
        lost: { summary: "自分の題名" },
        snapshot: null,
        title: "定例",
        reason: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        resolvedAt: null,
      },
    ];
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: server.api(),
      retryMs: 1000,
    });
    await activate(client);
    expect(client.conflicts()[0]?.actions).toEqual(["dismiss"]);
  });

  it("5: 保存先に書けなくても操作は消えずに送られ、保存できなかったことが分かる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const inner = persistentStore();
    let failWrites = false;
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === "write") {
          return async (ops: WriteOp[]) => {
            if (failWrites) throw new Error("QuotaExceededError");
            return target.write(ops);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LocalStore;
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store,
      api: server.api(),
      retryMs: 1000,
    });
    await activate(client);
    expect(client.storageFailed()).toBe(false);
    failWrites = true;
    client.updateEvent(E1, { summary: "変更" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.events.get(E1)?.summary).toBe("変更");
    expect(client.storageFailed()).toBe(true);
    // 書けるようになったら、残っていた分を書いて戻る。
    failWrites = false;
    client.updateCalendar(CALENDAR_ID, { color: "#000000" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.storageFailed()).toBe(false);
    expect(await store.list("calQueue")).toEqual([]);
  });

  it("5: 保存を確かめられていない操作は、保存先から読み直しても残す", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const inner = persistentStore();
    let failWrites = false;
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === "write") {
          return async (ops: WriteOp[]) => {
            if (failWrites) throw new Error("QuotaExceededError");
            return target.write(ops);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LocalStore;
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store,
      api: server.api(),
      retryMs: 1000,
    });
    await activate(client);
    server.online = false;
    failWrites = true;
    client.updateEvent(E1, { summary: "変更" });
    await vi.advanceTimersByTimeAsync(0);
    await client.reloadFromStore();
    expect(client.queue()).toHaveLength(1);
    server.online = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.events.get(E1)?.summary).toBe("変更");
  });

  it("6: 削除の書き戻しの失敗の「もう一度試す」は、削除を送る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    server.conflicts = [
      {
        id: "k6",
        calendarId: CALENDAR_ID,
        eventId: E1,
        kind: "write_failed",
        fields: [],
        lost: null,
        snapshot: null,
        title: "定例",
        reason: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        resolvedAt: null,
      },
    ];
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: server.api(),
      retryMs: 1000,
    });
    await activate(client);
    await client.resolveConflict("k6", "retry");
    await client.flush();
    expect(server.calls).toContain(`delete ${E1}`);
    expect(server.events.has(E1)).toBe(false);
  });

  it("低: 入れ替わった後の仮の ID で呼ばれても、回の操作として送る", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(
      event({ id: "m1", rrule: "FREQ=WEEKLY;COUNT=3", summary: "週次" }),
    );
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: server.api(),
      retryMs: 1000,
    });
    await activate(client);
    server.online = false;
    client.updateOccurrence("m1", "2026-03-09T01:00:00Z", {
      summary: "この回だけ",
    });
    const provisional =
      client.range(RANGE)?.events.find((e) => e.summary === "この回だけ")?.id ??
      "";
    expect(provisional).toBe("m1:2026-03-09T01:00:00Z");
    server.online = true;
    client.retryNow();
    await client.flush();
    await client.pull();
    expect(client.range(RANGE)?.events.some((e) => e.id === provisional)).toBe(
      false,
    );
    // 画面が古い ID のまま持っていた。
    client.updateEvent(provisional, { location: "会議室" });
    client.deleteEvent(provisional);
    expect(client.queue().map((op) => op.kind)).toEqual(["occurrence_delete"]);
    await client.flush();
    expect(server.calls.filter((c) => c.includes(provisional))).toEqual([]);
    expect(server.calls).toContain("occurrence_delete m1 2026-03-09T01:00:00Z");
  });
});
