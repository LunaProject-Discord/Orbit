import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledReminder } from "@/lib/calendar/notifications/bridge";
import {
  createSharedShownReminders,
  createWebReminderBridge,
  dueReminders,
  reminderFireKey,
  WEB_REMINDER_SHOWN_STORAGE_KEY,
  webReminderNotification,
} from "@/lib/calendar/notifications/web-bridge";

/** localStorage の代わり (タブどうしで分け合う置き場)。 */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

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
    const { due, skip } = dueReminders(
      items,
      new Set([`shown@${NOW - 60_000}`]),
      NOW,
    );
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

  it("出したあと同じ tag で時刻が動いたら、もう一度出す (H1)", async () => {
    let now = NOW;
    const shown: string[] = [];
    const bridge = createWebReminderBridge(null, {
      now: () => now,
      show: async (item) => {
        shown.push(reminderFireKey(item));
      },
    });
    const tag = "cal-rem:m1:-:10";
    await bridge.replaceAll([reminder(tag, NOW + 10_000)]);
    now = NOW + 10_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown).toEqual([`${tag}@${NOW + 10_000}`]);
    // 会議が 5 時間後へ延期された。同じ tag のまま、鳴らす時刻だけが動く。
    const moved = NOW + 5 * 3_600_000;
    await bridge.replaceAll([reminder(tag, moved)]);
    now = moved;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown).toEqual([`${tag}@${NOW + 10_000}`, `${tag}@${moved}`]);
    // 同じ時刻のままなら、組み直しても出し直さない。
    await bridge.replaceAll([reminder(tag, moved)]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shown).toHaveLength(2);
    await bridge.clear();
  });

  it("過ぎたが未表示のものは組み直しをまたいで残し、tag が新しい一覧にあれば新しいほうを使う", async () => {
    let now = NOW;
    const shown: string[] = [];
    const bridge = createWebReminderBridge(null, {
      now: () => now,
      checkMs: 60_000,
      show: async (item) => {
        shown.push(reminderFireKey(item));
      },
    });
    await bridge.replaceAll([
      reminder("kept", NOW + 10_000),
      reminder("moved", NOW + 10_000),
    ]);
    now = NOW + 20_000;
    // 確かめる前に組み直された。kept は一覧から消え、moved は先へ動いた。
    await bridge.replaceAll([reminder("moved", NOW + 600_000)]);
    expect(shown).toEqual([`kept@${NOW + 10_000}`]);
    now = NOW + 600_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shown).toEqual([`kept@${NOW + 10_000}`, `moved@${NOW + 600_000}`]);
    await bridge.clear();
  });

  it("同じ端末のほかのタブが出したものは出さない (L2)", async () => {
    let now = NOW;
    const storage = memoryStorage();
    const shownA: string[] = [];
    const shownB: string[] = [];
    const tabA = createWebReminderBridge(null, {
      now: () => now,
      shown: createSharedShownReminders(() => now, storage),
      show: async (item) => void shownA.push(item.tag),
    });
    const tabB = createWebReminderBridge(null, {
      now: () => now,
      shown: createSharedShownReminders(() => now, storage),
      show: async (item) => void shownB.push(item.tag),
    });
    await tabA.replaceAll([reminder("a", NOW + 10_000)]);
    await tabB.replaceAll([reminder("a", NOW + 10_000)]);
    now = NOW + 10_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect([...shownA, ...shownB]).toEqual(["a"]);
    expect(storage.values.has(WEB_REMINDER_SHOWN_STORAGE_KEY)).toBe(true);
    await tabA.clear();
    await tabB.clear();
    expect(storage.values.has(WEB_REMINDER_SHOWN_STORAGE_KEY)).toBe(false);
  });

  it("出した印は 15 分を過ぎたら捨てる", () => {
    let now = NOW;
    const storage = memoryStorage();
    const store = createSharedShownReminders(() => now, storage);
    store.add("old", NOW + 1_000);
    expect(store.has("old")).toBe(true);
    now = NOW + 2_000;
    expect(store.has("old")).toBe(false);
    store.add("new", NOW + 60_000);
    expect(
      Object.keys(
        JSON.parse(storage.getItem(WEB_REMINDER_SHOWN_STORAGE_KEY) ?? "{}"),
      ),
    ).toEqual(["new"]);
  });
});
