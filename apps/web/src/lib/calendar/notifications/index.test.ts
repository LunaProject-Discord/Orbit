// @vitest-environment happy-dom
import {
  type CalendarNotificationSettingsBody,
  type CalendarPushMessage,
  DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
} from "@orbit/core/calendar-notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/lib/calendar/api";
import type { ReminderSnapshot } from "@/lib/calendar/notifications/agent";
import type { ScheduledReminder } from "@/lib/calendar/notifications/bridge";
import { calendar, event } from "@/lib/calendar/offline/test-support";

/**
 * notifications/index.ts (予定の通知の端末側の入口) のテスト。橋・控え・通知の状態は偽物にし、
 * どの端末でいつ予約し、いつ消し、何を待つかを確かめる。
 */

type FakeBridge = {
  kind: string;
  calls: ScheduledReminder[][];
  cleared: number;
  failClear: boolean;
};

const env = vi.hoisted(() => ({
  desktop: false,
  native: false,
  windowLabel: "main",
  status: null as null | "push" | "page" | "off",
  calendarEnabled: true,
  settings: null as unknown,
  statusListeners: new Set<() => void>(),
  calendarListeners: new Set<() => void>(),
  sseListener: null as
    | null
    | ((event: { event: string; data: string }) => void),
  shown: [] as {
    message: CalendarPushMessage;
    canRespond?: (eventId: string) => boolean | Promise<boolean>;
  }[],
  bridges: [] as FakeBridge[],
  failClear: false,
  closedWebNotifications: 0,
  syncNotifications: vi.fn(async () => "page"),
  saveSettings: vi.fn(async () => {}),
  reportCover: vi.fn(async () => {}),
  opened: [] as unknown[],
  source: null as null | {
    snapshot: ReminderSnapshot | null;
    listeners: Set<() => void>;
    pull: () => Promise<void>;
  },
}));

function fakeBridge(kind: string) {
  const record: FakeBridge = {
    kind,
    calls: [],
    cleared: 0,
    failClear: env.failClear,
  };
  env.bridges.push(record);
  return {
    capabilities: async () => ({
      schedule: kind === "web" ? ("process" as const) : ("os" as const),
      exact: kind !== "native",
    }),
    replaceAll: async (items: ScheduledReminder[]) => {
      record.calls.push(items);
    },
    clear: async () => {
      record.cleared += 1;
      if (record.failClear) throw new Error("clear failed");
    },
  };
}

vi.mock("@/lib/desktop/app", () => ({
  isDesktopApp: () => env.desktop,
  listenDesktop: () => () => {},
  invokeDesktop: async () => null,
}));
vi.mock("@/lib/native/app", () => ({ isNativeApp: () => env.native }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: env.windowLabel }),
}));
vi.mock("@/lib/sync-status", () => ({ deviceId: () => "device-1" }));
vi.mock("@/lib/calendar/rsvp", () => ({ canRespondTo: () => true }));
vi.mock("@/lib/calendar/route", () => ({
  openCalendarEvent: (target: unknown) => env.opened.push(target),
  toCalendarEventTarget: (eventId: unknown, recurrenceId: unknown) =>
    typeof eventId === "string"
      ? {
          eventId,
          recurrenceId: typeof recurrenceId === "string" ? recurrenceId : null,
        }
      : null,
}));
vi.mock("@/lib/api", () => ({ reportReminderCover: env.reportCover }));
vi.mock("@/lib/calendar/api", () => ({
  getCalendarNotificationSettings: async () => env.settings,
  saveCalendarNotificationSettings: env.saveSettings,
  calendarNotifySupported: () => true,
  updateCalendar: async () => {
    throw new Error("unused");
  },
}));
vi.mock("@/lib/events", () => ({
  subscribeEvents: (
    listener: (event: { event: string; data: string }) => void,
  ) => {
    env.sseListener = listener;
    return () => {
      env.sseListener = null;
    };
  },
}));
vi.mock("@/lib/notifications", () => ({
  calendarNotificationsEnabled: () => env.calendarEnabled,
  currentNotificationStatus: () => env.status,
  onNotificationStatusChange: (listener: () => void) => {
    env.statusListeners.add(listener);
    return () => env.statusListeners.delete(listener);
  },
  onCalendarNotificationsChange: (listener: () => void) => {
    env.calendarListeners.add(listener);
    return () => env.calendarListeners.delete(listener);
  },
  parseCalendarEvent: (data: string) =>
    (JSON.parse(data) as { notifications: CalendarPushMessage[] })
      .notifications,
  setCalendarHandledElsewhere: () => {},
  setCalendarNotificationsEnabled: async () => "page",
  showCalendarNotification: async (
    message: CalendarPushMessage,
    canRespond?: (eventId: string) => boolean | Promise<boolean>,
  ) => {
    env.shown.push({ message, canRespond });
  },
  syncNotifications: env.syncNotifications,
}));
vi.mock("@/lib/calendar/offline", () => {
  class OfflineCalendarClient {
    reminderSnapshot() {
      return env.source?.snapshot ?? null;
    }
    subscribe(listener: () => void) {
      env.source?.listeners.add(listener);
      return () => env.source?.listeners.delete(listener);
    }
    pull() {
      return env.source?.pull() ?? Promise.resolve();
    }
    respond() {}
  }
  const client = new OfflineCalendarClient();
  return {
    OfflineCalendarClient,
    openCalendarOffline: async () => {},
    getCalendarClient: () => client,
  };
});
vi.mock("@/lib/calendar/notifications/web-bridge", () => ({
  createWebReminderBridge: () => fakeBridge("web"),
  createSharedShownReminders: () => ({ clear: () => {} }),
  closeCalendarNotifications: async () => {
    env.closedWebNotifications += 1;
  },
}));
vi.mock("@/lib/desktop/reminders", () => ({
  createDesktopReminderBridge: () => fakeBridge("desktop"),
  listenDesktopOpenEvent: () => () => {},
  listenDesktopCalendarAction: () => () => {},
}));
vi.mock("@/lib/native/reminders", () => ({
  createNativeReminderBridge: () => fakeBridge("native"),
  listenNativeCalendarOpen: () => () => {},
}));

const {
  clearCalendarReminders,
  createCoverReporter,
  currentCalendarNotificationRuntime,
  startCalendarNotifications,
} = await import("@/lib/calendar/notifications/index");
const {
  changeCalendarNotificationSettings,
  resetCalendarNotificationSettingsForTest,
} = await import("@/lib/calendar/notification-settings");

const OWNER_KEY = "calendar.reminders.owner";
const READY: CalendarNotificationSettingsBody = {
  calendarNotifications: DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
  timeZone: "Asia/Tokyo",
};
const EVENT_ID = "00000000-0000-4000-8000-000000000e01";

/** 1 時間後に始まる予定 (10 分前に通知)。 */
function upcoming(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = Date.now() + 3_600_000;
  return event({
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 3_600_000).toISOString(),
    ...overrides,
  });
}

function snapshot(events: CalendarEvent[] = [upcoming()]): ReminderSnapshot {
  return {
    calendars: [
      calendar({ defaultReminders: [{ method: "display", minutes: 10 }] }),
    ],
    events,
    cursor: "1",
  };
}

function bridgesOf(kind: string) {
  return env.bridges.filter((bridge) => bridge.kind === kind);
}

/** 起動して、組み直しが落ち着くまで待つ。 */
async function start(userId = "u1") {
  const stop = startCalendarNotifications(userId);
  await vi.waitFor(() => {
    expect(currentCalendarNotificationRuntime()).not.toBeNull();
  });
  await settle();
  return stop;
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await currentCalendarNotificationRuntime()?.settled();
  }
}

function publishStatus(status: typeof env.status) {
  env.status = status;
  for (const listener of env.statusListeners) listener();
}

beforeEach(() => {
  env.desktop = false;
  env.native = false;
  env.windowLabel = "main";
  env.status = null;
  env.calendarEnabled = true;
  env.settings = READY;
  env.statusListeners.clear();
  env.calendarListeners.clear();
  env.sseListener = null;
  env.shown = [];
  env.bridges = [];
  env.failClear = false;
  env.closedWebNotifications = 0;
  env.opened = [];
  env.syncNotifications.mockClear();
  env.saveSettings.mockClear();
  env.reportCover.mockClear();
  env.source = {
    snapshot: snapshot(),
    listeners: new Set(),
    pull: async () => {},
  };
  window.localStorage.clear();
  resetCalendarNotificationSettingsForTest();
});

afterEach(async () => {
  await clearCalendarReminders();
});

describe("notifications/index.ts (予定の通知の入口)", () => {
  it("通知の状態が決まっていなければ (/calendar を直接開いた) 状態を決め、page なら予約する (M2)", async () => {
    await start();
    expect(env.syncNotifications).toHaveBeenCalledTimes(1);
    // 状態がまだ null なので、Web では予約しない。
    expect(bridgesOf("web")).toHaveLength(0);
    publishStatus("page");
    await settle();
    expect(bridgesOf("web")).toHaveLength(1);
    expect(bridgesOf("web")[0]?.calls[0]?.map((item) => item.tag)).toEqual([
      `cal-rem:${EVENT_ID}:-:10`,
    ]);
    // 招待・変更の SSE も受ける。
    expect(env.sseListener).not.toBeNull();
  });

  it("状態が決まっていれば、改めて登録しに行かない。push なら Web は予約しない", async () => {
    env.status = "push";
    await start();
    expect(env.syncNotifications).not.toHaveBeenCalled();
    expect(bridgesOf("web")).toHaveLength(0);
    expect(env.sseListener).toBeNull();
  });

  it("Desktop: 前の利用者の予約を消してから、自分の分を予約する", async () => {
    env.desktop = true;
    window.localStorage.setItem(OWNER_KEY, "someone-else");
    await start("u1");
    const desktop = bridgesOf("desktop");
    expect(desktop[0]?.cleared).toBe(1);
    expect(desktop.at(-1)?.calls).toHaveLength(1);
    expect(window.localStorage.getItem(OWNER_KEY)).toBe("u1");
  });

  it("Desktop のメインウィンドウ以外では何もしない", async () => {
    env.desktop = true;
    env.windowLabel = "compose-1";
    startCalendarNotifications("u1");
    await settle();
    expect(env.bridges).toEqual([]);
    expect(env.syncNotifications).not.toHaveBeenCalled();
  });

  it("予定の通知がオフの端末は、起動時に 1 度だけ残った予約を消す (L4)", async () => {
    env.desktop = true;
    env.calendarEnabled = false;
    await start();
    expect(env.bridges.map((bridge) => [bridge.kind, bridge.cleared])).toEqual([
      ["desktop", 1],
    ]);
    // ほかの理由で組み直しても、消し直さない。
    publishStatus("page");
    await settle();
    expect(env.bridges).toHaveLength(1);
  });

  it("端末の予定の通知をオフにしたら Agent を止めて予約を消し、オンで組み直す", async () => {
    env.desktop = true;
    await start();
    expect(bridgesOf("desktop").at(-1)?.calls).toHaveLength(1);
    env.calendarEnabled = false;
    for (const listener of env.calendarListeners) listener();
    await settle();
    expect(bridgesOf("desktop")[0]?.cleared).toBeGreaterThanOrEqual(1);
    expect(env.sseListener).toBeNull();
    env.calendarEnabled = true;
    for (const listener of env.calendarListeners) listener();
    await settle();
    expect(bridgesOf("desktop").at(-1)?.calls).toHaveLength(1);
    expect(env.sseListener).not.toBeNull();
  });

  it("設定画面で内容を伏せる設定にしたら、すぐに組み直す (M3)", async () => {
    env.desktop = true;
    await start();
    const bridge = bridgesOf("desktop").at(-1);
    expect(bridge?.calls[0]?.[0]?.title).toBe("定例");
    await changeCalendarNotificationSettings({ detail: "private" });
    await vi.waitFor(() => expect(bridge?.calls).toHaveLength(2), {
      timeout: 2_000,
    });
    expect(bridge?.calls[1]?.[0]?.title).not.toBe("定例");
  });

  it("古いサーバー (設定の項目が無い) では予約せず、残った予約を消す (L11)", async () => {
    env.desktop = true;
    env.settings = null;
    await start();
    expect(env.bridges.every((bridge) => bridge.calls.length === 0)).toBe(true);
    expect(bridgesOf("desktop")[0]?.cleared).toBe(1);
  });

  it("タイムゾーンが未設定なら、この端末のタイムゾーンを保存する", async () => {
    env.desktop = true;
    env.settings = { ...READY, timeZone: null };
    await start();
    expect(env.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: expect.any(String) }),
    );
  });

  it("Desktop: 新しい招待が控えに無ければ pull を待ってから出欠のボタンを決める (M6)", async () => {
    env.desktop = true;
    const invite = upcoming({ id: "00000000-0000-4000-8000-0000000000aa" });
    const source = env.source;
    if (!source) throw new Error("no source");
    source.snapshot = snapshot([]);
    source.pull = async () => {
      if (source.snapshot) source.snapshot = snapshot([invite]);
    };
    await start();
    env.sseListener?.({
      event: "calendar",
      data: JSON.stringify({
        notifications: [
          {
            kind: "event-invite",
            title: "招待: 定例",
            body: "",
            tag: `cal-inv:${invite.id}`,
            eventId: invite.id,
          },
        ],
      }),
    });
    await vi.waitFor(() => expect(env.shown).toHaveLength(1));
    expect(await env.shown[0]?.canRespond?.(invite.id)).toBe(true);
    // 取り込みが遅く、待ちきれなければボタン無し。
    source.pull = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const pending = env.shown[0]?.canRespond?.(
        "00000000-0000-4000-8000-0000000000bb",
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ログアウト: 予約を消し、Web は出ている予定の通知を閉じる (L3)", async () => {
    env.status = "push";
    window.localStorage.setItem(OWNER_KEY, "u1");
    await start();
    await clearCalendarReminders();
    expect(env.closedWebNotifications).toBe(1);
    expect(window.localStorage.getItem(OWNER_KEY)).toBeNull();
  });

  it("ログアウトで予約を消せなかったら、予約した利用者の印を残す (L4)", async () => {
    env.desktop = true;
    await start("u1");
    for (const bridge of env.bridges) bridge.failClear = true;
    env.failClear = true;
    await clearCalendarReminders();
    expect(window.localStorage.getItem(OWNER_KEY)).toBe("u1");
  });
});

describe("createCoverReporter (Android の予約の範囲の報告)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const result = (coverSeq: string) => ({
    coverUntil: 1,
    coverSeq,
    exact: false,
    count: 1,
  });

  it("1 分に 1 回まで。続けて来たら最後の値を送る", async () => {
    const reporter = createCoverReporter(() => "token");
    reporter.report(result("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(env.reportCover).toHaveBeenCalledTimes(1);
    reporter.report(result("2"));
    reporter.report(result("3"));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(env.reportCover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.reportCover).toHaveBeenLastCalledWith(
      expect.objectContaining({ coverSeq: "3", token: "token" }),
    );
    reporter.stop();
  });

  it("送り先のトークンがまだ無ければ捨てずに、入ってから送る (L13)", async () => {
    let token: string | null = null;
    const reporter = createCoverReporter(() => token);
    reporter.report(result("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(env.reportCover).not.toHaveBeenCalled();
    token = "token";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.reportCover).toHaveBeenCalledWith(
      expect.objectContaining({ coverSeq: "1", token: "token" }),
    );
    reporter.stop();
  });
});
