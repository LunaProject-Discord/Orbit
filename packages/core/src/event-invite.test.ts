import { describe, expect, it } from "vitest";
import {
  calendarScheduling,
  inviteRole,
  schedulingBlocked,
} from "./event-invite.js";

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

describe("calendarScheduling の二重送信の表 (imip-design 3.1)", () => {
  type Row = {
    source: string;
    providerState?: Record<string, unknown> | null;
    readOnly?: boolean;
  };
  const cases: [
    string,
    Row,
    "server" | "mail" | "none",
    "server" | "mail" | "none",
  ][] = [
    // [説明, カレンダー, 送信元あり, 送信元なし]
    ["Google", { source: "google" }, "server", "server"],
    ["Microsoft", { source: "microsoft" }, "server", "server"],
    [
      "CalDAV autoSchedule true",
      { source: "caldav", providerState: { autoSchedule: true } },
      "server",
      "server",
    ],
    [
      "CalDAV autoSchedule false",
      { source: "caldav", providerState: { autoSchedule: false } },
      "mail",
      "none",
    ],
    [
      "CalDAV 鍵なし",
      { source: "caldav", providerState: { syncCollection: true } },
      "none",
      "none",
    ],
    [
      "CalDAV providerState null",
      { source: "caldav", providerState: null },
      "none",
      "none",
    ],
    [
      "CalDAV autoSchedule false・読み取り専用",
      {
        source: "caldav",
        providerState: { autoSchedule: false },
        readOnly: true,
      },
      "none",
      "none",
    ],
    ["Orbit 内", { source: "local" }, "mail", "none"],
    [
      "Orbit 内・読み取り専用",
      { source: "local", readOnly: true },
      "none",
      "none",
    ],
    ["ICS", { source: "ics" }, "none", "none"],
    ["祝日", { source: "holidays" }, "none", "none"],
    ["誕生日", { source: "birthdays" }, "none", "none"],
  ];
  for (const [label, row, withSender, withoutSender] of cases) {
    it(label, () => {
      expect(calendarScheduling({ ...row, imipSender: true })).toBe(withSender);
      expect(calendarScheduling({ ...row, imipSender: false })).toBe(
        withoutSender,
      );
      // 送信元を渡さない (8a までの呼び方) なら mail にならない。
      expect(calendarScheduling(row)).not.toBe("mail");
    });
  }
});

describe("schedulingBlocked", () => {
  it("送信元が無い・受信専用", () => {
    expect(schedulingBlocked({ source: "local", imipSender: false })).toBe(
      "no_sender",
    );
    expect(
      schedulingBlocked({
        source: "local",
        imipSender: false,
        senderBlocked: "receive_only",
      }),
    ).toBe("receive_only");
  });
  it("CalDAV でサーバーが送るか分からない", () => {
    expect(
      schedulingBlocked({
        source: "caldav",
        providerState: {},
        imipSender: true,
      }),
    ).toBe("unknown_server");
    expect(
      schedulingBlocked({
        source: "caldav",
        providerState: { autoSchedule: false },
        imipSender: false,
      }),
    ).toBe("no_sender");
  });
  it("送れるカレンダーと、対象外のカレンダーは null", () => {
    expect(schedulingBlocked({ source: "local", imipSender: true })).toBeNull();
    expect(schedulingBlocked({ source: "google" })).toBeNull();
    expect(
      schedulingBlocked({
        source: "caldav",
        providerState: { autoSchedule: true },
      }),
    ).toBeNull();
    expect(schedulingBlocked({ source: "ics" })).toBeNull();
    expect(schedulingBlocked({ source: "local", readOnly: true })).toBeNull();
  });
});
