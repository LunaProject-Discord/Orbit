import { describe, expect, it } from "vitest";
import {
  type GraphEvent,
  graphEventBody,
  type MicrosoftEventWriteInput,
  parseGraphEvent,
} from "./microsoft-calendar.js";

const base: GraphEvent = {
  id: "AAMk-1",
  iCalUId: "uid-1",
  subject: "定例",
  start: { dateTime: "2026-12-10T10:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-12-10T11:00:00.0000000", timeZone: "UTC" },
  organizer: { emailAddress: { address: "boss@example.com", name: "Boss" } },
  attendees: [
    {
      emailAddress: { address: "me@example.com", name: "Me" },
      type: "required",
      status: { response: "none" },
    },
    {
      emailAddress: { address: "other@example.com" },
      type: "optional",
      status: { response: "accepted" },
    },
  ],
};

describe("parseGraphEvent (招待と出欠)", () => {
  it("isOrganizer を主催者の self にする (無ければ入れない)", () => {
    const mine = parseGraphEvent(
      { ...base, isOrganizer: true },
      { selfEmail: "me@example.com" },
    );
    expect(mine?.organizer).toEqual({
      email: "boss@example.com",
      name: "Boss",
      self: true,
    });
    const theirs = parseGraphEvent(
      { ...base, isOrganizer: false },
      { selfEmail: "me@example.com" },
    );
    expect(theirs?.organizer?.self).toBe(false);
    const unknown = parseGraphEvent(base, { selfEmail: "me@example.com" });
    expect(unknown?.organizer).not.toHaveProperty("self");
  });

  it("自分の行が none なら、予定の responseStatus で補う", () => {
    const parsed = parseGraphEvent(
      {
        ...base,
        isOrganizer: false,
        responseStatus: { response: "tentativelyAccepted" },
      },
      { selfEmail: "me@example.com" },
    );
    expect(
      parsed?.attendees.map((attendee) => [
        attendee.email,
        attendee.status,
        attendee.self ?? false,
      ]),
    ).toEqual([
      ["me@example.com", "tentative", true],
      ["other@example.com", "accepted", false],
    ]);
  });

  it("自分の行に出欠があれば、それを使う。ほかの参加者は補わない", () => {
    const parsed = parseGraphEvent(
      {
        ...base,
        attendees: [
          {
            emailAddress: { address: "me@example.com" },
            status: { response: "declined" },
          },
          {
            emailAddress: { address: "other@example.com" },
            status: { response: "none" },
          },
        ],
        responseStatus: { response: "accepted" },
      },
      { selfEmail: "me@example.com" },
    );
    expect(parsed?.attendees.map((attendee) => attendee.status)).toEqual([
      "declined",
      "needs_action",
    ]);
  });
});

describe("終日の予定のリマインダー (設計 13 章の 1 の B)", () => {
  const allDayEvent: GraphEvent = {
    id: "AAMk-2",
    iCalUId: "uid-2",
    subject: "休み",
    isAllDay: true,
    start: { dateTime: "2026-12-24T00:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-12-25T00:00:00.0000000", timeZone: "UTC" },
  };

  it("Outlook の終日の通知 (1080 = 前日 6:00) は同じ「0:00 から何分前か」で読む", () => {
    const parsed = parseGraphEvent({
      ...allDayEvent,
      isReminderOn: true,
      reminderMinutesBeforeStart: 1080,
    });
    expect(parsed?.reminders).toEqual([{ method: "display", minutes: 1080 }]);
  });

  it("負の分は reminderMinutesBeforeStart に書かない (Orbit の中だけの通知)", () => {
    const input: MicrosoftEventWriteInput = {
      summary: "休み",
      location: null,
      description: null,
      status: "confirmed",
      busy: false,
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-12-24",
      endDate: "2026-12-25",
      startTimeZone: null,
      endTimeZone: null,
      rrule: null,
      rdates: null,
      useDefaultReminders: false,
      reminders: [
        { method: "display", minutes: -540 },
        { method: "display", minutes: 900 },
      ],
      attendees: [],
    };
    const options = {
      raw: null,
      fallbackTimeZone: "Asia/Tokyo",
      exception: false,
    };
    expect(graphEventBody(input, ["reminders"], options)).toEqual({
      isReminderOn: true,
      reminderMinutesBeforeStart: 900,
    });
    expect(
      graphEventBody(
        { ...input, reminders: [{ method: "display", minutes: -540 }] },
        ["reminders"],
        options,
      ),
    ).toEqual({ isReminderOn: false });
  });
});
