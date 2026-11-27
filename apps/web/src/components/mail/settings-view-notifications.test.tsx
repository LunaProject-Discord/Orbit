// @vitest-environment happy-dom
import { DEFAULT_CALENDAR_NOTIFICATION_SETTINGS } from "@orbit/core/calendar-notifications";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/mail/settings-view";
import type { Calendar } from "@/lib/calendar/api";
import { resetCalendarNotificationSettingsForTest } from "@/lib/calendar/notification-settings";
import { CALENDAR_NOTIFICATIONS_STORAGE_KEY } from "@/lib/calendar/notifications/bridge";
import { calendar } from "@/lib/calendar/offline/test-support";
import type { NotificationStatus } from "@/lib/notifications";

const api = vi.hoisted(() => ({
  settings: null as unknown,
  calendars: [] as Calendar[],
  saveSettings: vi.fn(),
  updateCalendar: vi.fn(),
}));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getSettings: () => Promise.reject(new Error("offline")),
}));

vi.mock("@/lib/calendar/api", async (original) => ({
  ...(await original<typeof import("@/lib/calendar/api")>()),
  getCalendarNotificationSettings: () => Promise.resolve(api.settings),
  saveCalendarNotificationSettings: api.saveSettings,
  listCalendars: () => Promise.resolve(api.calendars),
  updateCalendar: api.updateCalendar,
}));

const READY = {
  calendarNotifications: DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
  timeZone: "Asia/Tokyo",
};

describe("設定 → 通知 の予定の通知", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.settings = READY;
    api.calendars = [
      calendar({ id: "c1", name: "個人", notify: true, notifyDefault: true }),
      calendar({
        id: "c2",
        name: "日本の祝日",
        source: "ics",
        notify: false,
        notifyDefault: false,
        visible: false,
      }),
    ];
    api.saveSettings.mockReset().mockResolvedValue(undefined);
    api.updateCalendar.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCalendarNotificationSettingsForTest();
  });

  async function render(status: NotificationStatus = "push") {
    await act(async () => {
      root.render(
        <SettingsView
          user={{ id: "u1", email: "aoi@example.com", name: "あおい" }}
          accounts={[]}
          category="notifications"
          onCategoryChange={() => {}}
          onMenu={() => {}}
          notificationStatus={status}
          notificationBusy={false}
          onNotificationChange={() => {}}
          syncStatus={{ state: "synced" } as never}
          devices={1}
          onAdd={() => {}}
          onDelete={() => {}}
          onEditSignature={() => {}}
          onReauth={() => {}}
          onAccountUpdated={() => {}}
          onSignOut={() => {}}
          sidebarItems={null}
          signatureRules={null}
        />,
      );
    });
    // 設定とカレンダーの取得を待つ。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const text = () => container.textContent ?? "";
  const switchOf = (label: string) => {
    const id = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === label,
    )?.id;
    return container.querySelector<HTMLElement>(`[aria-labelledby="${id}"]`);
  };

  it("この端末・共通の設定・カレンダーごとの通知を出す", async () => {
    await render();
    expect(text()).toContain("新着メール: オン");
    expect(text()).toContain("予定: オン");
    expect(text()).toContain("この画面を閉じていても届きます");
    expect(text()).toContain("終日の予定の通知");
    expect(text()).toContain("当日 9:00");
    expect(text()).toContain("カレンダーごとの通知");
    expect(text()).toContain("非表示のため、通知しません");
    expect(switchOf("個人")?.getAttribute("aria-checked")).toBe("true");
    expect(switchOf("日本の祝日")?.getAttribute("aria-checked")).toBe("false");
  });

  it("この端末の予定の通知を切り替えて保存し、知らせる", async () => {
    const listener = vi.fn();
    window.addEventListener("orbit:calendar-notifications-change", listener);
    await render();
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "[data-device-calendar-notifications] button",
      ),
    ][0];
    await act(async () => button?.click());
    expect(
      window.localStorage.getItem(CALENDAR_NOTIFICATIONS_STORAGE_KEY),
    ).toBe("off");
    expect(text()).toContain("予定: オフ");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("orbit:calendar-notifications-change", listener);
  });

  it("共通の設定を変えると全体を保存する", async () => {
    await render();
    await act(async () => switchOf("新しい招待")?.click());
    expect(api.saveSettings).toHaveBeenCalledWith({
      calendarNotifications: {
        ...DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
        invites: false,
      },
      timeZone: "Asia/Tokyo",
    });
  });

  it("カレンダーの通知を切り替え、保存できなければ戻す", async () => {
    api.updateCalendar.mockRejectedValue(new Error("offline"));
    await render();
    await act(async () => switchOf("個人")?.click());
    expect(api.updateCalendar).toHaveBeenCalledWith("c1", { notify: false });
    expect(switchOf("個人")?.getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("変更を保存できませんでした");
  });

  it("古いサーバーでは予定の通知の項目を出さない", async () => {
    api.settings = null;
    const { notify: _a, notifyDefault: _b, ...old } = calendar();
    api.calendars = [old];
    await render();
    expect(text()).toContain("この端末の通知: オン");
    expect(text()).not.toContain("予定: ");
    expect(text()).not.toContain("終日の予定の通知");
    const headings = [...container.querySelectorAll("h3")].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["新着メールの通知", "通知に付けるボタン"]);
  });

  it("この端末の通知がオフなら、予定は選べない", async () => {
    await render("off");
    expect(text()).toContain("予定: オフ");
    expect(
      container.querySelector("[data-device-calendar-notifications] button"),
    ).toBeNull();
  });
});
