import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientApi } from "@/lib/calendar/offline/client";
import { OfflineCalendarClient } from "@/lib/calendar/offline/client";
import { createMemoryShareHub } from "@/lib/calendar/offline/share";
import {
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";

const RANGE = { from: "2026-03-01", to: "2026-04-01", timeZone: "Asia/Tokyo" };
const E1 = "00000000-0000-4000-8000-000000000e01";

describe("複数のウィンドウ", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("1 つの保存先につないだ 2 つの client: 片方の操作がもう片方に出て、送る役は 1 つだけ", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const store = persistentStore();
    const hub = createMemoryShareHub();
    const real = server.api();
    let release: () => void = () => {};
    let gate: Promise<void> | null = null;
    const api: ClientApi = {
      ...real,
      updateEvent: async (...args) => {
        await gate;
        return real.updateEvent(...args);
      },
    };
    const open = () =>
      OfflineCalendarClient.open({
        userId: "u1",
        store,
        api,
        share: hub.create("u1"),
      });
    const a = await open();
    const b = await open();
    a.subscribe(() => {});
    const seenByB = vi.fn();
    b.subscribe(seenByB);
    await a.pull();
    await b.pull();

    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    a.updateEvent(E1, { summary: "A で変更" });
    await vi.advanceTimersByTimeAsync(0);
    // B は合図を受けて保存先から読み直し、送信待ちを重ねて表示する。
    expect(seenByB).toHaveBeenCalled();
    const shown = b.range(RANGE);
    expect(shown?.events[0]?.summary).toBe("A で変更");
    expect(b.queue()).toHaveLength(1);
    // B も送ろうとするが、A が送っている間は送る役を取れない。
    await b.flush();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await a.flush();
    await b.flush();
    expect(server.calls.filter((call) => call === `update ${E1}`)).toHaveLength(
      1,
    );
    expect(a.queue()).toEqual([]);
    expect(b.queue()).toEqual([]);
    expect(b.range(RANGE)?.events[0]?.summary).toBe("A で変更");
    a.close();
    b.close();
  });

  it("別の利用者の合図は受けない", async () => {
    const hub = createMemoryShareHub();
    const mine = hub.create("u1");
    const other = hub.create("u2");
    const received = vi.fn();
    mine.onMessage(received);
    other.post({ events: [], calendars: true, queue: true, notices: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).not.toHaveBeenCalled();
  });
});
