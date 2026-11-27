// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarSidebar } from "@/components/calendar/calendar-sidebar";
import type { Calendar } from "@/lib/calendar/api";
import { calendar } from "@/lib/calendar/offline/test-support";

const api = vi.hoisted(() => ({ updateCalendar: vi.fn() }));

vi.mock("@/lib/calendar/api", async (original) => ({
  ...(await original<typeof import("@/lib/calendar/api")>()),
  updateCalendar: api.updateCalendar,
}));

describe("サイドバーのカレンダーごとの通知", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.updateCalendar.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(calendars: Calendar[]) {
    const today = Temporal.PlainDate.from("2026-11-27");
    act(() =>
      root.render(
        <CalendarSidebar
          user={{ id: "u1", email: "aoi@example.com", name: "あおい" }}
          groups={[
            {
              key: "orbit",
              name: "Orbit",
              sub: null,
              error: null,
              calendars,
            },
          ]}
          colorOf={() => "#4f46e5"}
          today={today}
          selected={today}
          selectedRange={{ from: today, to: today }}
          busyDays={new Set()}
          canCreate
          onSelectDate={() => {}}
          onCreateEvent={() => {}}
          onToggleCalendar={() => {}}
          onAddCalendar={() => {}}
          onRefreshCalendar={() => {}}
          onRemoveCalendar={() => {}}
          onOpenSettings={() => {}}
          onToggleSidebar={null}
        />,
      ),
    );
  }

  const openMenu = async (name: string) => {
    const trigger = document.body.querySelector<HTMLElement>(
      `[aria-label="「${name}」のメニュー"]`,
    );
    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      trigger?.click();
    });
  };
  const item = (label: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
      (element) => element.textContent?.includes(label),
    );

  it("古いサーバー (notify が無い) では、通知の項目を出さない", async () => {
    const {
      notify: _a,
      notifyDefault: _b,
      ...old
    } = calendar({
      name: "マイカレンダー",
    });
    render([old]);
    // Orbit 内のカレンダーは削除があるのでメニューは出る。
    await openMenu("マイカレンダー");
    expect(item("削除")).toBeDefined();
    expect(item("通知")).toBeUndefined();
    expect(item("既定の通知")).toBeUndefined();
  });

  it("通知を切り替えてサーバーへ保存し、オフの印を出す", async () => {
    const listed = calendar({
      name: "マイカレンダー",
      notify: true,
      notifyDefault: true,
      defaultRemindersEditable: true,
    });
    api.updateCalendar.mockImplementation(
      async (_id: string, changes: Partial<Calendar>) => ({
        ...listed,
        ...changes,
        updatedAt: "2026-11-27T10:00:00.000Z",
      }),
    );
    render([listed]);
    await openMenu("マイカレンダー");
    expect(item("既定の通知")).toBeDefined();
    const toggle = item("通知");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle?.click());
    expect(api.updateCalendar).toHaveBeenCalledWith(listed.id, {
      notify: false,
    });
    expect(
      document.body.querySelector('[aria-label="通知オフ"]'),
    ).not.toBeNull();
  });

  it("既定の通知を変えられないカレンダーでは出さない", async () => {
    render([
      calendar({
        name: "ホーム",
        source: "caldav",
        notify: true,
        notifyDefault: true,
        defaultRemindersEditable: false,
      }),
    ]);
    await openMenu("ホーム");
    expect(item("通知")).toBeDefined();
    expect(item("既定の通知")).toBeUndefined();
  });
});
