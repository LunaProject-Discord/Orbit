// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  buildCalendarEventRoute,
  eventTargetDate,
  OPEN_CALENDAR_EVENT,
  openCalendarEvent,
  parseCalendarEventRoute,
  parseCalendarRoute,
} from "@/lib/calendar/route";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("予定の URL", () => {
  it("作って読む (回の ID は ?o=)", () => {
    const path = buildCalendarEventRoute({
      eventId: ID,
      recurrenceId: "2026-11-27T01:00:00Z",
    });
    expect(path).toBe(`/calendar/events/${ID}?o=2026-11-27T01%3A00%3A00Z`);
    const [pathname, search] = path.split("?");
    expect(parseCalendarEventRoute(pathname ?? "", `?${search}`)).toEqual({
      eventId: ID,
      recurrenceId: "2026-11-27T01:00:00Z",
    });
    expect(parseCalendarEventRoute(`/calendar/events/${ID}`)).toEqual({
      eventId: ID,
      recurrenceId: null,
    });
  });

  it("UUID でない ID、ほかのパスは受け付けない", () => {
    expect(parseCalendarEventRoute("/calendar/events/abc")).toBeNull();
    expect(parseCalendarEventRoute("/calendar/week/2026-11-27")).toBeNull();
    expect(parseCalendarEventRoute(`/calendar/events/${ID}/x`)).toBeNull();
    expect(
      parseCalendarEventRoute(`/calendar/events/${ID}`, "?o=<script>"),
    ).toEqual({ eventId: ID, recurrenceId: null });
  });

  it("表示の URL の読み方は変わらない", () => {
    expect(parseCalendarRoute(`/calendar/events/${ID}`)).toEqual({
      view: null,
      date: null,
    });
  });
});

describe("eventTargetDate", () => {
  const base = {
    id: ID,
    parentId: null,
    allDay: false,
    startAt: "2026-11-26T16:00:00.000Z",
    startDate: null,
  };
  it("時刻のある予定はそのタイムゾーンの日付", () => {
    expect(eventTargetDate(base, null, "Asia/Tokyo")?.toString()).toBe(
      "2026-11-27",
    );
    expect(eventTargetDate(base, null, "UTC")?.toString()).toBe("2026-11-26");
  });
  it("原本に回の ID が付けば、その回の日", () => {
    expect(
      eventTargetDate(base, "2026-12-03T16:00:00Z", "Asia/Tokyo")?.toString(),
    ).toBe("2026-12-04");
    expect(
      eventTargetDate(
        { ...base, allDay: true, startAt: null, startDate: "2026-11-27" },
        "2026-12-04",
        "Asia/Tokyo",
      )?.toString(),
    ).toBe("2026-12-04");
  });
  it("例外の行は自分の開始", () => {
    expect(
      eventTargetDate(
        { ...base, parentId: "x" },
        "2026-12-03T16:00:00Z",
        "Asia/Tokyo",
      )?.toString(),
    ).toBe("2026-11-27");
  });
});

describe("openCalendarEvent", () => {
  it("予定の URL へ移り、開いている画面へ知らせる", () => {
    window.history.replaceState(null, "", "/");
    const listener = vi.fn();
    window.addEventListener(OPEN_CALENDAR_EVENT, listener);
    openCalendarEvent({ eventId: ID, recurrenceId: null });
    expect(window.location.pathname).toBe(`/calendar/events/${ID}`);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      eventId: ID,
      recurrenceId: null,
    });
    window.removeEventListener(OPEN_CALENDAR_EVENT, listener);
  });

  it("予定が決まらなければカレンダーを開く", () => {
    window.history.replaceState(null, "", "/messages/x");
    openCalendarEvent(null);
    expect(window.location.pathname).toBe("/calendar");
  });
});
