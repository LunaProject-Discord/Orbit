import { describe, expect, it } from "vitest";
import { parseICalendar } from "./icalendar.js";
import type { ICalEventData } from "./icalendar-write.js";
import { buildItip } from "./itip.js";

const STAMP = new Date("2026-11-27T03:04:05Z");
const read = (text: string) =>
  parseICalendar(text, { defaultTimeZone: "Asia/Tokyo" });

function event(overrides: Partial<ICalEventData> = {}): ICalEventData {
  return {
    uid: "e1@orbit",
    recurrenceId: null,
    summary: "定例, 第1回; 確認",
    location: "会議室 A",
    description: "1 行目\n2 行目",
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: "2026-12-08T01:00:00Z",
    endAt: "2026-12-08T02:00:00Z",
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    endTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: null,
    exdates: null,
    organizer: { email: "me@example.com", name: "Me" },
    attendees: [
      {
        email: "me@example.com",
        name: "Me",
        role: "chair",
        status: "accepted",
      },
      {
        email: "bob@example.com",
        name: "Bob",
        role: "required",
        status: "needs_action",
      },
      {
        email: "carol@example.com",
        name: null,
        role: "optional",
        status: "tentative",
      },
    ],
    sequence: 2,
    conferenceUrl: "https://meet.example.com/abc",
    reminders: [{ method: "display", minutes: 10 }],
    useDefaultReminders: false,
    ...overrides,
  };
}

/** 折り返しを戻した行。 */
const unfolded = (text: string) => text.replace(/\r\n[ \t]/g, "").split("\r\n");

describe("buildItip REQUEST", () => {
  it("読み戻すと同じ予定になる (タイムゾーン付き)", () => {
    const text = buildItip({
      method: "REQUEST",
      events: [event()],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    const calendar = read(text);
    expect(calendar.method).toBe("REQUEST");
    const [parsed] = calendar.events;
    expect(parsed).toMatchObject({
      uid: "e1@orbit",
      recurrenceId: null,
      summary: "定例, 第1回; 確認",
      location: "会議室 A",
      description: "1 行目\n2 行目",
      status: "confirmed",
      busy: true,
      allDay: false,
      startAt: "2026-12-08T01:00:00Z",
      endAt: "2026-12-08T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      sequence: 2,
      dtstamp: "2026-11-27T03:04:05Z",
      conferenceUrl: "https://meet.example.com/abc",
      organizer: { email: "me@example.com", name: "Me" },
    });
    expect(parsed?.attendees).toEqual([
      {
        email: "me@example.com",
        name: "Me",
        role: "chair",
        status: "accepted",
        sentBy: null,
        rsvp: false,
      },
      {
        email: "bob@example.com",
        name: "Bob",
        role: "required",
        status: "needs_action",
        sentBy: null,
        rsvp: true,
      },
      {
        email: "carol@example.com",
        name: null,
        role: "optional",
        status: "tentative",
        sentBy: null,
        rsvp: false,
      },
    ]);
    expect(text).toContain("DTSTART;TZID=Asia/Tokyo:20261208T100000");
    expect(text).toContain("BEGIN:VTIMEZONE\r\nTZID:Asia/Tokyo");
    expect(text).toContain("STATUS:CONFIRMED");
    expect(text).toContain("CALSCALE:GREGORIAN");
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("VALARM、X- や未知のプロパティを書かない", () => {
    const text = buildItip({
      method: "REQUEST",
      events: [event({ conferenceUrl: null })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text).not.toContain("VALARM");
    expect(text).not.toMatch(/^X-/m);
    const names = new Set(
      unfolded(text)
        .filter((row) => row.length > 0)
        .map((row) => /^[A-Z-]+/.exec(row)?.[0]),
    );
    for (const name of names) {
      expect([
        "BEGIN",
        "END",
        "PRODID",
        "VERSION",
        "CALSCALE",
        "METHOD",
        "TZID",
        "DTSTART",
        "TZOFFSETFROM",
        "TZOFFSETTO",
        "RRULE",
        "UID",
        "DTSTAMP",
        "SEQUENCE",
        "ORGANIZER",
        "ATTENDEE",
        "DTEND",
        "SUMMARY",
        "LOCATION",
        "DESCRIPTION",
        "STATUS",
        "TRANSP",
      ]).toContain(name);
    }
  });

  it("終日の予定は VALUE=DATE で書き、タイムゾーンを書かない", () => {
    const text = buildItip({
      method: "REQUEST",
      events: [
        event({
          allDay: true,
          startAt: null,
          endAt: null,
          startDate: "2026-12-24",
          endDate: "2026-12-26",
          startTimeZone: null,
          endTimeZone: null,
          busy: false,
        }),
      ],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text).toContain("DTSTART;VALUE=DATE:20261224");
    expect(text).toContain("DTEND;VALUE=DATE:20261226");
    expect(text).toContain("TRANSP:TRANSPARENT");
    expect(text).not.toContain("VTIMEZONE");
    expect(read(text).events[0]).toMatchObject({
      allDay: true,
      startDate: "2026-12-24",
      endDate: "2026-12-26",
      busy: false,
    });
  });

  it("タイムゾーンの無い予定は UTC で書く", () => {
    const text = buildItip({
      method: "REQUEST",
      events: [event({ startTimeZone: null, endTimeZone: null })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text).toContain("DTSTART:20261208T010000Z");
    expect(text).not.toContain("VTIMEZONE");
  });

  it("繰り返しの原本と例外を 1 つの VCALENDAR に入れ、RECURRENCE-ID を原本の形 (TZID) で書く", () => {
    const master = event({
      rrule: "FREQ=WEEKLY;BYDAY=TU",
      exdates: ["2026-12-22T01:00:00Z"],
      rdates: ["2026-12-31T01:00:00Z"],
      reminders: null,
    });
    const exception = event({
      recurrenceId: "2026-12-15T01:00:00Z",
      startAt: "2026-12-15T05:00:00Z",
      endAt: "2026-12-15T06:00:00Z",
      summary: "定例 (この回だけ)",
      sequence: 3,
    });
    const cancelled = event({
      recurrenceId: "2026-12-29T01:00:00Z",
      startAt: "2026-12-29T01:00:00Z",
      endAt: "2026-12-29T02:00:00Z",
      status: "cancelled",
    });
    const text = buildItip({
      method: "REQUEST",
      events: [master, exception, cancelled],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    expect(text).toContain("RECURRENCE-ID;TZID=Asia/Tokyo:20261215T100000");
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
    const [parsedMaster, parsedException] = read(text).events;
    expect(parsedMaster?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(parsedMaster?.rdates).toEqual(["2026-12-31T01:00:00Z"]);
    // 取り消した例外の回は EXDATE に入る。
    expect(parsedMaster?.exdates).toEqual([
      "2026-12-22T01:00:00Z",
      "2026-12-29T01:00:00Z",
    ]);
    expect(parsedException).toMatchObject({
      recurrenceId: "2026-12-15T01:00:00Z",
      startAt: "2026-12-15T05:00:00Z",
      summary: "定例 (この回だけ)",
      sequence: 3,
      rrule: null,
    });
  });

  it("RECURRENCE-ID は原本が UTC なら UTC、終日なら日付で書く", () => {
    const utcMaster = event({
      rrule: "FREQ=DAILY",
      startTimeZone: null,
      endTimeZone: null,
    });
    const utcException = event({
      recurrenceId: "2026-12-09T01:00:00Z",
      startAt: "2026-12-09T03:00:00Z",
      endAt: "2026-12-09T04:00:00Z",
      startTimeZone: null,
      endTimeZone: null,
    });
    const utc = buildItip({
      method: "REQUEST",
      events: [utcMaster, utcException],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(utc).toContain("RECURRENCE-ID:20261209T010000Z");
    expect(read(utc).events[1]?.recurrenceId).toBe("2026-12-09T01:00:00Z");

    const dayMaster = event({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-12-08",
      endDate: "2026-12-09",
      startTimeZone: null,
      endTimeZone: null,
      rrule: "FREQ=DAILY;COUNT=5",
    });
    const dayException = {
      ...dayMaster,
      rrule: null,
      recurrenceId: "2026-12-10",
      startDate: "2026-12-11",
      endDate: "2026-12-12",
    };
    const day = buildItip({
      method: "REQUEST",
      events: [dayMaster, dayException],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(day).toContain("RECURRENCE-ID;VALUE=DATE:20261210");
    expect(read(day).events[1]?.recurrenceId).toBe("2026-12-10");
  });

  it("長い行を 75 オクテットで折り返し、読み戻すと同じ", () => {
    const summary = `${"長い題名の予定".repeat(20)}, 終わり`;
    const text = buildItip({
      method: "REQUEST",
      events: [event({ summary, attendees: [] })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    const encoder = new TextEncoder();
    for (const row of text.split("\r\n")) {
      expect(encoder.encode(row).length).toBeLessThanOrEqual(75);
    }
    expect(read(text).events[0]?.summary).toBe(summary);
  });

  it("名前の区切り文字と改行を逃がす", () => {
    const text = buildItip({
      method: "REQUEST",
      events: [
        event({
          organizer: { email: "me@example.com", name: 'Me "Boss"; Tokyo' },
          attendees: [
            {
              email: "bob@example.com",
              name: "Bob:\nSmith",
              role: "required",
              status: "needs_action",
            },
          ],
        }),
      ],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    const [parsed] = read(text).events;
    expect(parsed?.organizer).toEqual({
      email: "me@example.com",
      name: "Me Boss; Tokyo",
    });
    expect(parsed?.attendees[0]?.email).toBe("bob@example.com");
    expect(parsed?.attendees[0]?.name).toBe("Bob: Smith");
  });
});

describe("buildItip CANCEL", () => {
  it("全体の取り消しは SEQUENCE を 1 上げ、原本だけを書く", () => {
    const master = event({ rrule: "FREQ=DAILY" });
    const exception = event({ recurrenceId: "2026-12-09T01:00:00Z" });
    const text = buildItip({
      method: "CANCEL",
      events: [master, exception],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text).toContain("METHOD:CANCEL");
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain("STATUS:CANCELLED");
    expect(text).not.toContain("DTEND");
    expect(text).not.toContain("LOCATION");
    expect(text).not.toContain("DESCRIPTION");
    expect(text).not.toContain("RRULE");
    expect(text).not.toContain("PARTSTAT");
    const [parsed] = read(text).events;
    expect(parsed).toMatchObject({
      uid: "e1@orbit",
      sequence: 3,
      status: "cancelled",
      summary: "定例, 第1回; 確認",
    });
    expect(parsed?.attendees.map((attendee) => attendee.email)).toEqual([
      "me@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
  });

  it("参加者を外す CANCEL は、外した人だけを書き、SEQUENCE は上げない", () => {
    const text = buildItip({
      method: "CANCEL",
      events: [event()],
      attendees: ["Dave@example.com", "bob@example.com"],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    const [parsed] = read(text).events;
    expect(parsed?.sequence).toBe(2);
    expect(parsed?.attendees.map((attendee) => attendee.email)).toEqual([
      "Dave@example.com",
      "bob@example.com",
    ]);
    expect(parsed?.attendees[1]?.name).toBe("Bob");
  });

  it("1 回だけの取り消しは RECURRENCE-ID を書き、SEQUENCE は行の値", () => {
    const text = buildItip({
      method: "CANCEL",
      events: [event({ recurrenceId: "2026-12-08T01:00:00Z", sequence: 4 })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text).toContain("RECURRENCE-ID;TZID=Asia/Tokyo:20261208T100000");
    const [parsed] = read(text).events;
    expect(parsed?.recurrenceId).toBe("2026-12-08T01:00:00Z");
    expect(parsed?.sequence).toBe(4);
  });
});

describe("buildItip REPLY", () => {
  it("自分の ATTENDEE 1 行だけ、SEQUENCE は受け取った値のまま、コメント付き", () => {
    const text = buildItip({
      method: "REPLY",
      events: [
        event({
          organizer: { email: "boss@example.com", name: "Boss" },
          attendees: [
            {
              email: "boss@example.com",
              name: "Boss",
              role: "chair",
              status: "accepted",
            },
            {
              email: "me@example.com",
              name: "Me",
              role: "required",
              status: "accepted",
            },
          ],
          sequence: 5,
        }),
      ],
      attendees: ["me@example.com"],
      comment: "少し遅れます, よろしく",
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(text).toContain("METHOD:REPLY");
    expect(text).not.toContain("RSVP");
    expect(text).not.toContain("ROLE");
    expect(text).not.toContain("LOCATION");
    expect(text).not.toContain("STATUS:");
    const [parsed] = read(text).events;
    expect(parsed?.sequence).toBe(5);
    expect(parsed?.comment).toBe("少し遅れます, よろしく");
    expect(parsed?.organizer).toEqual({
      email: "boss@example.com",
      name: "Boss",
    });
    expect(parsed?.attendees).toEqual([
      {
        email: "me@example.com",
        name: "Me",
        role: "required",
        status: "accepted",
        sentBy: null,
        rsvp: false,
      },
    ]);
    expect(parsed?.startAt).toBe("2026-12-08T01:00:00Z");
    expect(parsed?.endAt).toBe("2026-12-08T02:00:00Z");
  });

  it("例外の行への返事は RECURRENCE-ID を書く", () => {
    const text = buildItip({
      method: "REPLY",
      events: [event({ recurrenceId: "2026-12-08T01:00:00Z" })],
      attendees: ["bob@example.com"],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(read(text).events[0]?.recurrenceId).toBe("2026-12-08T01:00:00Z");
    expect(text).not.toContain("COMMENT");
  });
});

describe("buildItip の入力の誤り", () => {
  it("予定が無い・日時が読めないなら投げる", () => {
    expect(() =>
      buildItip({
        method: "REQUEST",
        events: [],
        dtstamp: STAMP,
        defaultTimeZone: "Asia/Tokyo",
      }),
    ).toThrow();
    expect(() =>
      buildItip({
        method: "REQUEST",
        events: [event()],
        dtstamp: new Date("x"),
        defaultTimeZone: "Asia/Tokyo",
      }),
    ).toThrow();
  });
});

describe("buildItip の行の差し込み (imip レビュー M5)", () => {
  const props = (text: string) =>
    unfolded(text).filter((entry) => entry.length > 0);

  it("CR / LF・制御文字を含む rrule・会議 URL・UID・CN で行が増えない", () => {
    const base = buildItip({
      method: "REQUEST",
      events: [event({ rrule: "FREQ=DAILY", uid: "e1@orbit" })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    const text = buildItip({
      method: "REQUEST",
      events: [
        event({
          uid: "e1@orbit\rX-UID:1",
          rrule: "FREQ=DAILY\r\nATTENDEE:mailto:victim@example.net\r\nX-EVIL:1",
          conferenceUrl:
            "https://meet.example.com/abc\r\nATTACH:https://evil.example/x",
          organizer: { email: "me@example.com", name: "Me\r\nX-NAME:1" },
          summary: "題名\u0007\r\nX-SUMMARY:1",
        }),
      ],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(props(text)).toHaveLength(props(base).length);
    expect(text).not.toMatch(
      /\r\n(ATTENDEE:mailto:victim|X-EVIL|ATTACH|X-UID|X-NAME)/,
    );
    // CRLF 以外の CR・LF が残っていない。
    expect(text.replace(/\r\n/g, "")).not.toMatch(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字が残っていないことを確かめる
      /[\r\n\u0000-\u0008\u000b-\u001f]/,
    );
    const parsed = read(text).events;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.attendees.map((a) => a.email)).toEqual([
      "me@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
  });
});

describe("buildItip の STATUS と RECURRENCE-ID の形", () => {
  it("未定 (tentative) の予定は STATUS:TENTATIVE (L9)", () => {
    const text = buildItip({
      method: "REQUEST",
      events: [event({ status: "tentative" })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(unfolded(text)).toContain("STATUS:TENTATIVE");
  });

  it("取り消し済みの行の CANCEL は行の SEQUENCE のまま (L2)", () => {
    const text = buildItip({
      method: "CANCEL",
      events: [event({ status: "cancelled", sequence: 4 })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(unfolded(text)).toContain("SEQUENCE:4");
    const deleted = buildItip({
      method: "CANCEL",
      events: [event({ sequence: 4 })],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(unfolded(deleted)).toContain("SEQUENCE:5");
  });

  it("原本の形を渡すと、終日に変えた回の RECURRENCE-ID も原本の形で書く (L8)", () => {
    const exception = event({
      recurrenceId: "2026-12-08T01:00:00Z",
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-12-08",
      endDate: "2026-12-09",
      startTimeZone: null,
      endTimeZone: null,
    });
    const text = buildItip({
      method: "REQUEST",
      events: [exception],
      dtstamp: STAMP,
      defaultTimeZone: "Asia/Tokyo",
      masterTiming: { allDay: false, startTimeZone: "Asia/Tokyo" },
    });
    expect(unfolded(text)).toContain(
      "RECURRENCE-ID;TZID=Asia/Tokyo:20261208T100000",
    );
  });
});
