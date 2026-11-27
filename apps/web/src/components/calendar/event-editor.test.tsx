// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEditor } from "@/components/calendar/event-editor";
import type { Calendar, CalendarEvent } from "@/lib/calendar/api";
import { toLocal } from "@/lib/calendar/dates";
import { type EventForm, eventFormOf } from "@/lib/calendar/event-form";
import { calendar, event } from "@/lib/calendar/offline/test-support";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getToken: () => "token",
  getContacts: () => Promise.resolve([]),
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
