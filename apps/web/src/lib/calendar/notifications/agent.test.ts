import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDeviceReminders,
  type HandedReminders,
  ReminderAgent,
  type ReminderAgentSettings,
  type ReminderSnapshot,
} from "@/lib/calendar/notifications/agent";
import type {
  ReminderBridge,
  ScheduledReminder,
} from "@/lib/calendar/notifications/bridge";
import { calendar, event } from "@/lib/calendar/offline/test-support";

const NOW = Date.parse("2026-03-02T00:00:00.000Z"); // 東京 9:00
const SETTINGS: ReminderAgentSettings = {
  timeZone: "Asia/Tokyo",
  allDay: { minutes: -540 },
  detail: "full",
};

function snapshot(overrides: Partial<ReminderSnapshot> = {}): ReminderSnapshot {
  return {
    calendars: [
      calendar({ defaultReminders: [{ method: "display", minutes: 10 }] }),
    ],
    events: [event({ location: "会議室 A" })],
    cursor: "42",
    ...overrides,
  };
}

describe("buildDeviceReminders", () => {
  it("カレンダーの既定で、開始の 10 分前に予約し、文言まで作る", () => {
    const { items, coverUntil } = buildDeviceReminders(
      snapshot(),
      SETTINGS,
      NOW,
    );
    expect(items).toEqual([
      {
        tag: "cal-rem:00000000-0000-4000-8000-000000000e01:-:10",
        fireAt: Date.parse("2026-03-02T00:50:00.000Z"),
        expiresAt: Date.parse("2026-03-02T02:00:00.000Z"),
        title: "定例",
        body: "10:00〜11:00 · 会議室 A",
        eventId: "00000000-0000-4000-8000-000000000e01",
        recurrenceId: null,
      },
    ]);
    expect(coverUntil).toBe(NOW + 7 * 24 * 60 * 60_000);
  });

  it("通知オフのカレンダー・不参加・取り消しは予約しない", () => {
    const off = (notify: boolean | null, source = "local") =>
      buildDeviceReminders(
        snapshot({
          calendars: [
            {
              ...calendar({
                source: source as "local",
                defaultReminders: [{ method: "display", minutes: 10 }],
              }),
              notify,
            } as never,
          ],
        }),
        SETTINGS,
        NOW,
      ).items.length;
    expect(off(false)).toBe(0);
    expect(off(null)).toBe(1);
    // 応答に notify が無ければ種類ごとの既定 (購読はオフ)。
    expect(off(null, "ics")).toBe(0);
    const declined = buildDeviceReminders(
      snapshot({
        events: [
          event({
            attendees: [
              {
                email: "me@example.com",
                self: true,
                status: "declined",
              } as never,
            ],
          }),
        ],
      }),
      SETTINGS,
      NOW,
    );
    expect(declined.items).toEqual([]);
    const cancelled = buildDeviceReminders(
      snapshot({ events: [event({ status: "cancelled" })] }),
      SETTINGS,
      NOW,
    );
    expect(cancelled.items).toEqual([]);
  });

  it("終日の予定は利用者の既定 (当日 9:00)。文言の「今日」は鳴らす時刻で決める", () => {
    const { items } = buildDeviceReminders(
      snapshot({
        events: [
          event({
            allDay: true,
            startAt: null,
            endAt: null,
            startDate: "2026-03-03",
            endDate: "2026-03-04",
            summary: "棚卸し",
          }),
        ],
      }),
      SETTINGS,
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.fireAt).toBe(Date.parse("2026-03-03T00:00:00.000Z"));
    expect(items[0]?.body).toBe("今日 (終日)");
  });

  it("64 件を超えたら早い順に切り、範囲を縮める", () => {
    const events = Array.from({ length: 70 }, (_, index) =>
      event({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        startAt: new Date(NOW + (index + 1) * 3_600_000).toISOString(),
        endAt: new Date(NOW + (index + 2) * 3_600_000).toISOString(),
      }),
    );
    const { items, coverUntil } = buildDeviceReminders(
      snapshot({ events }),
      SETTINGS,
      NOW,
    );
    expect(items).toHaveLength(64);
    expect(coverUntil).toBeLessThan(NOW + 7 * 24 * 60 * 60_000);
    expect(items.every((item) => item.fireAt <= coverUntil)).toBe(true);
  });

  it("private なら題名を伏せる", () => {
    const { items } = buildDeviceReminders(
      snapshot(),
      { ...SETTINGS, detail: "private" },
      NOW,
    );
    expect(items[0]?.title).toBe("予定のリマインダー");
  });
});

function fakeBridge(schedule: "os" | "process" | "none" = "os") {
  const calls: ScheduledReminder[][] = [];
  const bridge: ReminderBridge & { cleared: number } = {
    cleared: 0,
    capabilities: async () => ({ schedule, exact: true }),
    replaceAll: async (items) => {
      calls.push(items);
    },
    clear: async () => {
      bridge.cleared += 1;
    },
  };
  return { bridge, calls };
}

function fakeSource(initial: ReminderSnapshot | null) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    reminderSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: ReminderSnapshot) {
      current = next;
      for (const listener of listeners) listener();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

describe("ReminderAgent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("開始時に組み直し、控えが変わったら 500 ms でまとめて組み直す", async () => {
    const { bridge, calls } = fakeBridge();
    const source = fakeSource(snapshot());
    const covers: unknown[] = [];
    const agent = new ReminderAgent({
      source,
      bridge,
      settings: () => SETTINGS,
      now: () => NOW,
      onScheduled: (result) => covers.push(result),
    });
    expect(await agent.start()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(covers).toEqual([
      {
        coverUntil: NOW + 7 * 24 * 60 * 60_000,
        coverSeq: "42",
        exact: true,
        count: 1,
      },
    ]);
    source.set(snapshot({ events: [], cursor: "43" }));
    source.set(snapshot({ events: [], cursor: "44" }));
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([expect.any(Array), []]);
    // 中身が同じなら橋は呼ばない (報告だけ)。
    source.set(snapshot({ events: [], cursor: "45" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    expect(covers).toHaveLength(3);
    agent.stop();
  });

  it("6 時間ごとに組み直す", async () => {
    const { bridge, calls } = fakeBridge();
    let now = NOW;
    const agent = new ReminderAgent({
      source: fakeSource(snapshot({ events: [] })),
      bridge,
      settings: () => SETTINGS,
      now: () => now,
    });
    await agent.start();
    // 6 時間後の予定が窓に入る。
    const source = agent as unknown as {
      options: { source: ReturnType<typeof fakeSource> };
    };
    source.options.source.set(
      snapshot({
        events: [
          event({
            startAt: new Date(NOW + 8 * 24 * 3_600_000).toISOString(),
            endAt: new Date(NOW + 8 * 24 * 3_600_000 + 3_600_000).toISOString(),
          }),
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.at(-1)).toEqual([]);
    now = NOW + 2 * 24 * 3_600_000;
    await vi.advanceTimersByTimeAsync(6 * 3_600_000);
    expect(calls.at(-1)).toHaveLength(1);
    agent.stop();
  });

  it("予約できない橋 (none) では動かない", async () => {
    const { bridge, calls } = fakeBridge("none");
    const source = fakeSource(snapshot());
    const agent = new ReminderAgent({
      source,
      bridge,
      settings: () => SETTINGS,
    });
    expect(await agent.start()).toBe(false);
    expect(calls).toEqual([]);
    expect(source.listeners).toBe(0);
  });

  it("控えの初回の同期が済むまでは橋を呼ばない", async () => {
    const { bridge, calls } = fakeBridge();
    const source = fakeSource(null);
    const agent = new ReminderAgent({
      source,
      bridge,
      settings: () => SETTINGS,
      now: () => NOW,
    });
    await agent.start();
    expect(calls).toEqual([]);
    source.set(snapshot());
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    agent.stop();
  });

  it("clear で購読をやめ、予約を消す。その後は組み直さない", async () => {
    const { bridge, calls } = fakeBridge();
    const source = fakeSource(snapshot());
    const agent = new ReminderAgent({
      source,
      bridge,
      settings: () => SETTINGS,
      now: () => NOW,
    });
    await agent.start();
    await agent.clear();
    expect(bridge.cleared).toBe(1);
    expect(source.listeners).toBe(0);
    source.set(snapshot({ events: [] }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
  });

  it("作った時点で時刻を過ぎていた (15 分以内) ものは 1 度だけ渡す。起動し直しても渡さない (L12)", async () => {
    // 9:55 に「10:00 開始・10 分前に通知」を作った (鳴らす時刻 9:50 を過ぎている)。
    const at = Date.parse("2026-03-02T00:55:00.000Z");
    let stored = new Map<string, number>();
    const handed: HandedReminders = {
      load: () => new Map(stored),
      save: (value) => {
        stored = new Map(value);
      },
      clear: () => {
        stored = new Map();
      },
    };
    const { bridge, calls } = fakeBridge();
    const source = fakeSource(snapshot());
    const agent = new ReminderAgent({
      source,
      bridge,
      settings: () => SETTINGS,
      now: () => at,
      handed,
    });
    await agent.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((item) => item.fireAt)).toEqual([
      Date.parse("2026-03-02T00:50:00.000Z"),
    ]);
    // 次の組み直しでは渡さない (橋が「過ぎたが未表示」を自分で残す)。
    source.set(snapshot({ cursor: "43" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.at(-1)).toEqual([]);
    agent.stop();
    // アプリを起動し直した (橋の印は消えている)。もう渡さないので二重に鳴らない。
    const again = fakeBridge();
    const restarted = new ReminderAgent({
      source: fakeSource(snapshot()),
      bridge: again.bridge,
      settings: () => SETTINGS,
      now: () => at,
      handed,
    });
    await restarted.start();
    expect(again.calls).toEqual([[]]);
    restarted.stop();
    // 15 分を過ぎたものは、渡したことが無くても渡さない。
    stored = new Map();
    const late = fakeBridge();
    const lateAgent = new ReminderAgent({
      source: fakeSource(snapshot()),
      bridge: late.bridge,
      settings: () => SETTINGS,
      now: () => Date.parse("2026-03-02T01:06:00.000Z"),
      handed,
    });
    await lateAgent.start();
    expect(late.calls).toEqual([[]]);
    lateAgent.stop();
  });
});
