// @vitest-environment happy-dom

import { DEFAULT_CALENDAR_NOTIFICATION_SETTINGS } from "@orbit/core/calendar-notifications";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventEditor,
  switchedReminders,
} from "@/components/calendar/event-editor";
import type { Calendar, CalendarEvent } from "@/lib/calendar/api";
import { toLocal } from "@/lib/calendar/dates";
import { type EventForm, eventFormOf } from "@/lib/calendar/event-form";
import { resetCalendarNotificationSettingsForTest } from "@/lib/calendar/notification-settings";
import { calendar, event } from "@/lib/calendar/offline/test-support";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getToken: () => "token",
  getContacts: () => Promise.resolve([]),
}));

// 予定の通知の設定はサーバーから取らない (古いサーバーと同じ扱い)。
vi.mock("@/lib/calendar/api", async (original) => ({
  ...(await original<typeof import("@/lib/calendar/api")>()),
  getCalendarNotificationSettings: () => Promise.resolve(null),
}));

function formOf(value: CalendarEvent): EventForm {
  const local = toLocal(
    {
      eventId: value.id,
      masterId: value.id,
      recurrenceId: null,
      allDay: false,
      startAt: value.startAt,
      endAt: value.endAt,
      startDate: null,
      endDate: null,
    },
    "Asia/Tokyo",
  );
  if (!local) throw new Error("local");
  return eventFormOf(value, local);
}

const attendees = [
  {
    email: "me@example.com",
    name: null,
    role: "required" as const,
    status: "accepted" as const,
    self: true,
  },
  {
    email: "tanaka@example.com",
    name: "田中 美咲",
    role: "required" as const,
    status: "needs_action" as const,
    self: false,
  },
];

describe("編集画面の参加者の欄", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const text = () => document.body.textContent ?? "";
  const input = (label: string) =>
    document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  const submit = () =>
    document.body.querySelector<HTMLButtonElement>('button[type="submit"]');

  function renderEditor(
    value: CalendarEvent,
    cal: Calendar,
    role: "organizer" | "attendee",
    onSave = vi.fn(),
  ) {
    act(() =>
      root.render(
        <EventEditor
          open
          title="予定を編集"
          initial={formOf(value)}
          existing
          role={role}
          calendars={[cal]}
          colorOf={() => "#4f46e5"}
          timeZone="Asia/Tokyo"
          busy={false}
          error={null}
          onSave={onSave}
          onClose={() => {}}
        />,
      ),
    );
  }

  it("主催者で招待を送れるカレンダーでは、参加者を入力できる", () => {
    renderEditor(
      event({ organizer: { email: "me@example.com", self: true }, attendees }),
      calendar({ source: "google", scheduling: "server" }),
      "organizer",
    );
    expect(text()).toContain("田中 美咲");
    const field = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="参加者を追加"], input[inputmode="email"]',
    );
    expect(field?.disabled).toBe(false);
    expect(submit()?.textContent).toBe("保存");
  });

  it("招待を送れないカレンダーでは理由を出し、参加者は外すだけにする", () => {
    renderEditor(
      event({ organizer: { email: "me@example.com", self: true }, attendees }),
      calendar({ source: "caldav", scheduling: "none" }),
      "organizer",
    );
    expect(text()).toContain("このカレンダーからは招待を送れません");
    expect(document.body.querySelector('input[inputmode="email"]')).toBeNull();
    const remove = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="田中 美咲 を参加者から外す"]',
    );
    act(() => remove?.click());
    expect(text()).not.toContain("田中 美咲");
    expect(submit()?.disabled).toBe(false);
  });

  it("招待された予定では、通知と予定あり / 空き以外を無効にする", () => {
    const onSave = vi.fn();
    renderEditor(
      event({
        organizer: { email: "boss@example.com", self: false },
        attendees,
      }),
      calendar({ source: "google", scheduling: "server" }),
      "attendee",
      onSave,
    );
    expect(text()).toContain("主催者の予定です");
    expect(input("タイトル")?.disabled).toBe(true);
    expect(input("場所")?.disabled).toBe(true);
    expect(input("開始日")?.disabled).toBe(true);
    expect(
      document.body
        .querySelector<HTMLElement>('[aria-label="予定あり / 空き"]')
        ?.getAttribute("data-disabled"),
    ).toBeNull();
    expect(submit()?.textContent).toBe("保存");
  });
});

describe("編集画面の終日の予定の通知", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCalendarNotificationSettingsForTest();
  });

  const ready = (allDay: { minutes: number } | null = { minutes: -540 }) =>
    resetCalendarNotificationSettingsForTest({
      status: "ready",
      value: {
        calendarNotifications: {
          ...DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
          allDay,
        },
        timeZone: "Asia/Tokyo",
      },
    });

  function renderAllDay(
    changes: Partial<EventForm>,
    onSave: (form: EventForm) => void = vi.fn(),
    cal: Calendar = calendar(),
  ) {
    const form: EventForm = {
      ...formOf(event()),
      allDay: true,
      ...changes,
    };
    act(() =>
      root.render(
        <EventEditor
          open
          title="予定を編集"
          initial={form}
          existing
          calendars={[cal]}
          colorOf={() => "#4f46e5"}
          timeZone="Asia/Tokyo"
          busy={false}
          error={null}
          onSave={onSave}
          onClose={() => {}}
        />,
      ),
    );
  }

  const text = () => document.body.textContent ?? "";
  const days = () =>
    [
      ...document.body.querySelectorAll<HTMLElement>('[aria-label="通知の日"]'),
    ].map((element) => element.textContent?.replace("▼", ""));
  const times = () => [
    ...document.body.querySelectorAll<HTMLInputElement>(
      'input[aria-label="通知の時刻"]',
    ),
  ];

  it("時刻あり → 終日に切り替えると、10 分前は終日の既定に置き換わる (L10)", () => {
    ready({ minutes: 900 });
    renderAllDay({
      allDay: false,
      useDefaultReminders: false,
      reminders: [
        { method: "display", minutes: 10 },
        { method: "display", minutes: 60 },
      ],
    });
    const allDayBox = [
      ...document.body.querySelectorAll<HTMLElement>('[role="checkbox"]'),
    ].find((element) => element.closest("label")?.textContent === "終日");
    // Base UI の Checkbox は、隠れた input を押すと切り替わる。
    const input = allDayBox?.closest("label")?.querySelector("input");
    if (!input) throw new Error("終日の欄が無い");
    act(() => input.click());
    // 「1 日前 23:50」(10 分) ではなく、終日の既定 (前日 9:00)。同じ値は 1 つにまとめる。
    expect(days()).toEqual(["1 日前"]);
    expect(times().map((element) => element.value)).toEqual(["09:00"]);
  });

  it("既定の通知は、利用者ごとの終日の既定を指す", () => {
    ready({ minutes: 900 });
    renderAllDay({ useDefaultReminders: true, reminders: [] });
    expect(text()).toContain("終日の予定の既定の通知を使う");
    expect(text()).toContain("(1 日前 9:00)");
  });

  it("予定ごとの通知は、何日前と時刻で選び、分に直して保存する", () => {
    ready();
    const onSave = vi.fn();
    renderAllDay(
      {
        useDefaultReminders: false,
        reminders: [
          { method: "display", minutes: -540 },
          { method: "display", minutes: 9540 },
        ],
      },
      onSave,
    );
    expect(days()).toEqual(["当日", "1 週間前"]);
    expect(times().map((element) => element.value)).toEqual(["09:00", "09:00"]);
    const first = times()[0];
    if (!first) throw new Error("time");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(first, "07:30");
      first.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.click(),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].reminders).toEqual([
      { method: "display", minutes: -450 },
      { method: "display", minutes: 9540 },
    ]);
  });

  it("通知を足すと、当日 9:00 から始める", () => {
    ready();
    renderAllDay({ useDefaultReminders: false, reminders: [] });
    act(() =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "通知を追加")
        ?.click(),
    );
    expect(days()).toEqual(["当日"]);
    expect(times()[0]?.value).toBe("09:00");
  });

  it("古いサーバーでは、カレンダーの既定と、前日より前の通知だけにする", () => {
    resetCalendarNotificationSettingsForTest({
      status: "unsupported",
      value: null,
    });
    renderAllDay({ useDefaultReminders: true, reminders: [] });
    expect(text()).toContain("カレンダーの既定の通知を使う");
    act(() => root.unmount());
    root = createRoot(container);
    renderAllDay({ useDefaultReminders: false, reminders: [] });
    act(() =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "通知を追加")
        ?.click(),
    );
    expect(days()).toEqual(["1 日前"]);
  });

  it("Google のカレンダーで当日の時刻を選ぶと、Orbit だけで通知すると添える", () => {
    ready();
    renderAllDay(
      {
        useDefaultReminders: false,
        reminders: [{ method: "display", minutes: -540 }],
      },
      vi.fn(),
      calendar({ source: "google" }),
    );
    expect(text()).toContain(
      "当日の時刻の通知は Google カレンダー には登録されず、Orbit だけで通知します。",
    );
    act(() => root.unmount());
    root = createRoot(container);
    renderAllDay(
      {
        useDefaultReminders: false,
        reminders: [{ method: "display", minutes: 900 }],
      },
      vi.fn(),
      calendar({ source: "google" }),
    );
    expect(text()).not.toContain("Orbit だけで通知します");
  });
});

describe("switchedReminders (終日 ⇄ 時刻ありの切り替え)", () => {
  const display = (minutes: number) => ({
    method: "display" as const,
    minutes,
  });

  it("終日へは終日の既定、時刻ありへは 10 分前に置き換える", () => {
    expect(switchedReminders([display(10)], false, true, -540)).toEqual([
      display(-540),
    ]);
    // 逆 (前日 9:00 = 900) は「15 時間前」にせず 10 分前にする。
    expect(switchedReminders([display(900)], true, false, -540)).toEqual([
      display(10),
    ]);
    // メールの通知は種類を残す。
    expect(
      switchedReminders(
        [display(10), { method: "email", minutes: 30 }],
        false,
        true,
        900,
      ),
    ).toEqual([display(900), { method: "email", minutes: 900 }]);
    // 切り替えていなければそのまま。
    expect(switchedReminders([display(10)], false, false, 900)).toEqual([
      display(10),
    ]);
  });
});
