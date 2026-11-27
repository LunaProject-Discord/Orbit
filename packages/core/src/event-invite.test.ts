import { describe, expect, it } from "vitest";
import { calendarScheduling, inviteRole } from "./event-invite.js";

const me = { email: "Me@example.com", self: true };
const other = { email: "other@example.com", self: false };

describe("inviteRole", () => {
  it("主催者の印があれば organizer", () => {
    expect(
      inviteRole({
        organizer: { email: "x@example.com", self: true },
        attendees: [other],
      }),
    ).toBe("organizer");
  });
  it("印が無く、自分の参加者のアドレスが主催者と同じなら organizer", () => {
    expect(
      inviteRole({
        organizer: { email: "me@example.com" },
        attendees: [me, other],
      }),
    ).toBe("organizer");
  });
  it("主催者も参加者もいなければ organizer", () => {
    expect(inviteRole({ organizer: null, attendees: [] })).toBe("organizer");
  });
  it("自分が参加者なら attendee", () => {
    expect(
      inviteRole({
        organizer: { email: "boss@example.com", self: false },
        attendees: [me],
      }),
    ).toBe("attendee");
    expect(inviteRole({ organizer: null, attendees: [me, other] })).toBe(
      "attendee",
    );
  });
  it("自分が関わらない予定は none", () => {
    expect(
      inviteRole({
        organizer: { email: "boss@example.com" },
        attendees: [other],
      }),
    ).toBe("none");
  });
});

describe("calendarScheduling", () => {
  it("Google と Microsoft はサービスが送る", () => {
    expect(calendarScheduling({ source: "google" })).toBe("server");
    expect(calendarScheduling({ source: "microsoft" })).toBe("server");
  });
  it("CalDAV は autoSchedule が true のときだけ", () => {
    expect(
      calendarScheduling({
        source: "caldav",
        providerState: { autoSchedule: true },
      }),
    ).toBe("server");
    expect(
      calendarScheduling({
        source: "caldav",
        providerState: { autoSchedule: false },
      }),
    ).toBe("none");
    expect(calendarScheduling({ source: "caldav", providerState: null })).toBe(
      "none",
    );
  });
  it("Orbit 内・購読・祝日は送れない", () => {
    for (const source of ["local", "ics", "holidays", "birthdays"]) {
      expect(calendarScheduling({ source })).toBe("none");
    }
  });
});
