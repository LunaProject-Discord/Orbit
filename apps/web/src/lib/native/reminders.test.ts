import { describe, expect, it } from "vitest";
import {
  parseNativeCalendarUrl,
  parseNativeCapabilities,
  toNativeReminder,
} from "./reminders";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("parseNativeCapabilities", () => {
  it("端末の値をそのまま受け取る", () => {
    expect(parseNativeCapabilities({ schedule: "os", exact: false })).toEqual({
      schedule: "os",
      exact: false,
    });
    expect(parseNativeCapabilities({ schedule: "os", exact: true })).toEqual({
      schedule: "os",
      exact: true,
    });
  });

  it("形が違えば予約できない扱い。none のとき exact は常に false", () => {
    expect(parseNativeCapabilities(undefined)).toEqual({
      schedule: "none",
      exact: false,
    });
    expect(parseNativeCapabilities({ schedule: "alarm", exact: true })).toEqual(
      { schedule: "none", exact: false },
    );
    expect(parseNativeCapabilities({ schedule: "none", exact: true })).toEqual({
      schedule: "none",
      exact: false,
    });
  });
});

describe("toNativeReminder", () => {
  it("約束の項目だけを渡し、時刻は整数にする", () => {
    const item = {
      tag: `cal-rem:${ID}:-:10`,
      fireAt: 1_800_000_000_000.5,
      expiresAt: 1_800_003_600_000,
      title: "定例会議",
      body: "10:00〜11:00",
      eventId: ID,
      recurrenceId: null,
      extra: "渡さない",
    };
    expect(toNativeReminder(item)).toEqual({
      tag: `cal-rem:${ID}:-:10`,
      fireAt: 1_800_000_000_000,
      expiresAt: 1_800_003_600_000,
      title: "定例会議",
      body: "10:00〜11:00",
      eventId: ID,
      recurrenceId: null,
    });
  });
});

describe("parseNativeCalendarUrl", () => {
  it("予定の URL (回つき) を読む", () => {
    expect(
      parseNativeCalendarUrl(
        `jp.lunaproject.orbit.mail://calendar/events/${ID}?o=2026-11-28T01%3A00%3A00Z`,
      ),
    ).toEqual({
      type: "open-event",
      eventId: ID,
      recurrenceId: "2026-11-28T01:00:00Z",
    });
    expect(
      parseNativeCalendarUrl(
        `jp.lunaproject.orbit.mail://calendar/events/${ID}`,
      ),
    ).toEqual({ type: "open-event", eventId: ID, recurrenceId: null });
  });

  it("予定が決まらない通知はカレンダーを開く", () => {
    expect(
      parseNativeCalendarUrl("jp.lunaproject.orbit.mail://calendar"),
    ).toEqual({ type: "open-calendar" });
  });

  it("UUID でない ID、ほかの URL は受け付けない", () => {
    expect(
      parseNativeCalendarUrl(
        "jp.lunaproject.orbit.mail://calendar/events/../../settings",
      ),
    ).toBeNull();
    expect(
      parseNativeCalendarUrl("jp.lunaproject.orbit.mail://oauth/google?code=x"),
    ).toBeNull();
    expect(
      parseNativeCalendarUrl(`https://example.com/calendar/events/${ID}`),
    ).toBeNull();
  });
});
