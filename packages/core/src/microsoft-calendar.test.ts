import { describe, expect, it } from "vitest";
import { type GraphEvent, parseGraphEvent } from "./microsoft-calendar.js";

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
