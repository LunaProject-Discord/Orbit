import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledReminder } from "@/lib/calendar/notifications/bridge";
import {
  createWebReminderBridge,
  dueReminders,
  webReminderNotification,
} from "@/lib/calendar/notifications/web-bridge";

const NOW = Date.parse("2026-03-02T00:00:00.000Z");

function reminder(
  tag: string,
  fireAt: number,
  expiresAt = fireAt + 3_600_000,
): ScheduledReminder {
  return {
    tag,
    fireAt,
    expiresAt,
    title: "定例",
    body: "10:00〜11:00",
    eventId: "00000000-0000-4000-8000-000000000e01",
    recurrenceId: null,
  };
}

describe("dueReminders", () => {
  it("時刻の来たものだけ出し、15 分過ぎたものと終わったものは出さない", () => {
    const items = [
      reminder("future", NOW + 1),
      reminder("now", NOW),
      reminder("late", NOW - 16 * 60_000),
      reminder("ended", NOW - 60_000, NOW - 1),
      reminder("shown", NOW - 60_000),
    ];
    const { due, skip } = dueReminders(items, new Set(["shown"]), NOW);
    expect(due.map((item) => item.tag)).toEqual(["now"]);
    expect(skip.map((item) => item.tag)).toEqual(["late", "ended"]);
  });
});

describe("webReminderNotification", () => {
  it("サービスワーカーが読む data を付ける (renotify は付けない)", () => {
    expect(webReminderNotification(reminder("cal-rem:x:-:10", NOW))).toEqual({
      title: "定例",
      options: {
        body: "10:00〜11:00",
        tag: "cal-rem:x:-:10",
        icon: "/icons/icon-192.png",
        data: {
          kind: "event-reminder",
          eventId: "00000000-0000-4000-8000-000000000e01",
          recurrenceId: null,
        },
      },
    });
  });
});

describe("createWebReminderBridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("30 秒ごとに一覧を見て、時刻の来たものを 1 回だけ出す", async () => {
    let now = NOW;
    const shown: string[] = [];
    const bridge = createWebReminderBridge(null, {
      now: () => now,
      show: async (item) => {
        shown.push(item.tag);
      },
    });
    expect(await bridge.capabilities()).toEqual({
      schedule: "process",
      exact: false,
    });
    await bridge.replaceAll([
      reminder("a", NOW + 40_000),
      reminder("b", NOW + 90_000),
    ]);
    expect(shown).toEqual([]);
    now = NOW + 45_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown).toEqual(["a"]);
    // 時刻を過ぎて出す前に組み直されても (Agent は今から先だけを渡す)、落とさない。
    now = NOW + 95_000;
    await bridge.replaceAll([]);
    expect(shown).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shown).toEqual(["a", "b"]);
    await bridge.clear();
  });

  it("スリープ明けに 15 分以上過ぎていたものは出さない", async () => {
    let now = NOW;
    const shown: string[] = [];
    const bridge = createWebReminderBridge(null, {
      now: () => now,
      show: async (item) => {
        shown.push(item.tag);
      },
    });
    await bridge.replaceAll([reminder("a", NOW + 60_000)]);
    now = NOW + 60_000 + 20 * 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown).toEqual([]);
    await bridge.clear();
  });

  it("clear のあとは出さない", async () => {
    let now = NOW;
    const shown: string[] = [];
    const bridge = createWebReminderBridge(null, {
      now: () => now,
      show: async (item) => {
        shown.push(item.tag);
      },
    });
    await bridge.replaceAll([reminder("a", NOW + 60_000)]);
    await bridge.clear();
    now = NOW + 61_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shown).toEqual([]);
  });
});
