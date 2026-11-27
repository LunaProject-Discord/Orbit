import { describe, expect, it } from "vitest";
import { parseICalendar } from "./icalendar.js";
import {
  buildVTimezone,
  escapeICalText,
  type ICalEventData,
  writeICalendar,
} from "./icalendar-write.js";

const NOW = new Date("2026-11-27T00:00:00Z");
const read = (text: string) =>
  parseICalendar(text, { defaultTimeZone: "Asia/Tokyo" }).events;

function event(overrides: Partial<ICalEventData> = {}): ICalEventData {
  return {
    uid: "abc@orbit",
    recurrenceId: null,
    summary: "打ち合わせ, 定例; 第1回",
    location: "会議室 A",
    // バックスラッシュは parseICalendar が戻さない (報告済み) ので、往復のテストには入れない。
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
    organizer: null,
    attendees: [],
    sequence: 0,
    conferenceUrl: null,
    reminders: null,
    ...overrides,
  };
}

const BASE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 15//EN",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:series-1",
  "DTSTAMP:20261101T000000Z",
  "DTSTART;TZID=America/New_York:20261201T090000",
  "DTEND;TZID=America/New_York:20261201T100000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU",
  "SUMMARY:週次",
  "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
  "CATEGORIES:仕事",
  "ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;SCHEDULE-STATUS=1.2:mailto:bob@example.com",
  "SEQUENCE:2",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "DESCRIPTION:x",
  "END:VALARM",
  "BEGIN:VALARM",
  "ACTION:AUDIO",
  "TRIGGER;VALUE=DATE-TIME:20261201T130000Z",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:series-1",
  "DTSTAMP:20261101T000000Z",
  "RECURRENCE-ID;TZID=America/New_York:20261208T090000",
  "DTSTART;TZID=America/New_York:20261208T110000",
  "DTEND;TZID=America/New_York:20261208T120000",
  "SUMMARY:週次 (この回だけ)",
  "X-CUSTOM:keep-me",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("escapeICalText", () => {
  it("RFC 5545 の TEXT のエスケープをする", () => {
    expect(escapeICalText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });
});

describe("writeICalendar", () => {
  it("新規の予定を書いて読み直すと同じ内容になる (往復)", () => {
    const input = event({
      reminders: [
        { method: "display", minutes: 10 },
        { method: "email", minutes: 60 },
      ],
      attendees: [
        {
          email: "a@example.com",
          name: "山田, 太郎",
          role: "required",
          status: "accepted",
        },
        {
          email: "b@example.com",
          name: null,
          role: "optional",
          status: "needs_action",
        },
      ],
      conferenceUrl: "https://meet.example.com/x",
      busy: false,
      status: "tentative",
    });
    const text = writeICalendar({
      base: null,
      entries: [{ event: input, fields: "all" }],
      defaultTimeZone: "Asia/Tokyo",
      alarmEmail: "me@example.com",
      now: NOW,
    });
    expect(text).toContain("BEGIN:VTIMEZONE\r\nTZID:Asia/Tokyo");
    expect(text).toContain("DTSTART;TZID=Asia/Tokyo:20261208T100000");
    for (const row of text.split("\r\n")) {
      expect(Buffer.byteLength(row, "utf8")).toBeLessThanOrEqual(75);
    }
    const [parsed] = read(text);
    expect(parsed).toMatchObject({
      uid: "abc@orbit",
      recurrenceId: null,
      summary: input.summary,
      location: input.location,
      description: input.description,
      status: "tentative",
      busy: false,
      allDay: false,
      startAt: "2026-12-08T01:00:00Z",
      endAt: "2026-12-08T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      conferenceUrl: "https://meet.example.com/x",
      reminders: [
        { method: "display", minutes: 10 },
        { method: "email", minutes: 60 },
      ],
      attendees: [
        {
          email: "a@example.com",
          name: "山田, 太郎",
          role: "required",
          status: "accepted",
        },
        {
          email: "b@example.com",
          name: null,
          role: "optional",
          status: "needs_action",
        },
      ],
    });
    // 書いて読んだものをもう一度書いて読んでも変わらない。
    const again = writeICalendar({
      base: text,
      entries: [{ event: parsed as ICalEventData, fields: "all" }],
      defaultTimeZone: "Asia/Tokyo",
      alarmEmail: "me@example.com",
      now: NOW,
    });
    const [reparsed] = read(again);
    const {
      raw: _a,
      sequence: _s1,
      remoteUpdatedAt: _r1,
      ...first
    } = parsed as typeof parsed & object;
    const {
      raw: _b,
      sequence: _s2,
      remoteUpdatedAt: _r2,
      ...second
    } = reparsed as typeof parsed & object;
    expect(second).toEqual(first);
  });

  it("終日、繰り返し、RDATE と EXDATE を書ける", () => {
    const text = writeICalendar({
      base: null,
      entries: [
        {
          event: event({
            allDay: true,
            startAt: null,
            endAt: null,
            startDate: "2026-12-24",
            endDate: "2026-12-26",
            startTimeZone: null,
            endTimeZone: null,
            rrule: "FREQ=YEARLY",
            exdates: ["2027-12-24"],
            rdates: ["2026-12-31"],
          }),
          fields: "all",
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    const [parsed] = read(text);
    expect(parsed).toMatchObject({
      allDay: true,
      startDate: "2026-12-24",
      endDate: "2026-12-26",
      rrule: "FREQ=YEARLY",
      exdates: ["2027-12-24"],
      rdates: ["2026-12-31"],
    });
    expect(text).not.toContain("VTIMEZONE");
  });

  it("既存のリソースは、変えた項目だけを差し替えて知らない項目を残す", () => {
    const [master, exception] = read(BASE);
    if (!master || !exception) throw new Error("読めません");
    const text = writeICalendar({
      base: BASE,
      entries: [
        {
          event: {
            ...master,
            summary: "週次 (改題)",
            exdates: ["2026-12-15T14:00:00Z"],
          },
          fields: ["summary", "recurrence"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    // 知らない項目と VTIMEZONE、例外、日時の書き方 (TZID) はそのまま。
    expect(text).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
    expect(text).toContain("CATEGORIES:仕事");
    expect(text).toContain("DTSTART;TZID=America/New_York:20261201T090000");
    expect(text).toContain("X-CUSTOM:keep-me");
    expect(text).toContain("SCHEDULE-STATUS=1.2");
    expect(text).toContain("TRIGGER;VALUE=DATE-TIME:20261201T130000Z");
    expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    // SEQUENCE は上がる (繰り返しを変えた)。
    expect(text).toMatch(/SEQUENCE:3/);
    const [after, afterException] = read(text);
    expect(after?.summary).toBe("週次 (改題)");
    expect(after?.exdates).toEqual(["2026-12-15T14:00:00Z"]);
    expect(after?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(after?.reminders).toEqual([{ method: "display", minutes: 15 }]);
    expect(afterException?.summary).toBe("週次 (この回だけ)");
    expect(afterException?.recurrenceId).toBe(exception.recurrenceId);
  });

  it("他人が主催する予定 (取り込んだ招待) は、時刻を変えても SEQUENCE を上げない", () => {
    const organizer = { email: "sato@example.com", self: false };
    const base = writeICalendar({
      base: null,
      entries: [{ event: event({ sequence: 2, organizer }), fields: "all" }],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    const moved = writeICalendar({
      base,
      entries: [
        {
          event: event({
            sequence: 2,
            organizer,
            startAt: "2026-12-09T01:00:00Z",
            endAt: "2026-12-09T02:00:00Z",
          }),
          fields: ["time"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(read(moved)[0]?.sequence).toBe(2);
  });

  it("API が先に上げた SEQUENCE を、もう 1 回上げない (二重上げの修正)", () => {
    const base = writeICalendar({
      base: null,
      entries: [{ event: event({ sequence: 0 }), fields: "all" }],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(base).toMatch(/SEQUENCE:0/);
    // API が時刻の変更で sequence を 0 → 1 にした行を書き戻す。
    const moved = writeICalendar({
      base,
      entries: [
        {
          event: event({
            sequence: 1,
            startAt: "2026-12-09T01:00:00Z",
            endAt: "2026-12-09T02:00:00Z",
          }),
          fields: ["time"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(read(moved)[0]?.sequence).toBe(1);
    // 行の値が基の値と同じ (上げていない) なら、これまでどおり 1 上げる。
    const same = writeICalendar({
      base: moved,
      entries: [
        {
          event: event({
            sequence: 1,
            startAt: "2026-12-10T01:00:00Z",
            endAt: "2026-12-10T02:00:00Z",
          }),
          fields: ["time"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(read(same)[0]?.sequence).toBe(2);
    // 時刻を変えない変更では上げない。
    const renamed = writeICalendar({
      base: same,
      entries: [
        { event: event({ sequence: 2, summary: "改題" }), fields: ["summary"] },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(read(renamed)[0]?.sequence).toBe(2);
  });

  it("例外を差し替え、足し、取り除ける", () => {
    const [master, exception] = read(BASE);
    if (!master || !exception) throw new Error("読めません");
    const changed = writeICalendar({
      base: BASE,
      entries: [
        {
          event: { ...exception, summary: "この回は中止", status: "cancelled" },
          fields: ["summary", "status"],
        },
        {
          event: {
            ...master,
            recurrenceId: "2026-12-22T14:00:00Z",
            rrule: null,
            startAt: "2026-12-22T16:00:00Z",
            endAt: "2026-12-22T17:00:00Z",
            summary: "新しい例外",
          },
          fields: "all",
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    const rows = read(changed);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      summary: "この回は中止",
      status: "cancelled",
    });
    expect(rows[1]?.raw).toContain("X-CUSTOM:keep-me");
    expect(rows[2]).toMatchObject({
      uid: "series-1",
      recurrenceId: "2026-12-22T14:00:00Z",
      summary: "新しい例外",
      rrule: null,
      startAt: "2026-12-22T16:00:00Z",
    });

    const removed = writeICalendar({
      base: changed,
      entries: [
        {
          event: { ...master, exdates: [exception.recurrenceId as string] },
          fields: ["recurrence"],
        },
      ],
      remove: [exception.recurrenceId],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    const left = read(removed);
    expect(left.map((row) => row.recurrenceId)).toEqual([
      null,
      "2026-12-22T14:00:00Z",
    ]);
    expect(left[0]?.exdates).toEqual([exception.recurrenceId]);
  });

  it("リマインダーをカレンダーの既定に戻すと、読む VALARM だけを消す", () => {
    const [master] = read(BASE);
    if (!master) throw new Error("読めません");
    const text = writeICalendar({
      base: BASE,
      entries: [
        {
          event: { ...master, reminders: null, useDefaultReminders: true },
          fields: ["useDefaultReminders", "reminders"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).not.toContain("TRIGGER:-PT15M");
    expect(text).toContain("ACTION:AUDIO");
  });

  it("参加者の出欠を変えても、知らないパラメータは残す", () => {
    const [master] = read(BASE);
    if (!master) throw new Error("読めません");
    const text = writeICalendar({
      base: BASE,
      entries: [
        {
          event: {
            ...master,
            attendees: master.attendees.map((attendee) => ({
              ...attendee,
              status: "accepted" as const,
            })),
          },
          fields: ["attendees"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text.replace(/\r\n /g, "")).toMatch(
      /ATTENDEE;CN=Bob;RSVP=TRUE;SCHEDULE-STATUS=1.2;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:bob@example.com/,
    );
    expect(read(text)[0]?.attendees[0]?.status).toBe("accepted");
  });

  it("夏時間のある地域の VTIMEZONE を作り、繰り返しが現地時刻のまま読める", () => {
    const zone = buildVTimezone(
      "America/New_York",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(zone).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    expect(zone).toContain("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    const text = writeICalendar({
      base: null,
      entries: [
        {
          event: event({
            startAt: "2026-07-01T13:00:00Z",
            endAt: "2026-07-01T14:00:00Z",
            startTimeZone: "America/New_York",
            endTimeZone: "America/New_York",
          }),
          fields: "all",
        },
      ],
      defaultTimeZone: "UTC",
      now: NOW,
    });
    expect(text).toContain("DTSTART;TZID=America/New_York:20260701T090000");
    expect(read(text)[0]).toMatchObject({
      startAt: "2026-07-01T13:00:00Z",
      startTimeZone: "America/New_York",
    });
  });

  it("オフセットだけのタイムゾーンや浮動時刻は UTC で書く", () => {
    const text = writeICalendar({
      base: null,
      entries: [
        {
          event: event({ startTimeZone: "+09:00", endTimeZone: null }),
          fields: "all",
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("DTSTART:20261208T010000Z");
    expect(text).not.toContain("VTIMEZONE");
  });
});

describe("writeICalendar (レビューの指摘)", () => {
  const simple = (lines: string[]) =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:s-1",
      ...lines,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");

  it("EXDATE と新しい RECURRENCE-ID は、原本の TZID 付きの現地時刻で書く", () => {
    const [master] = read(BASE);
    if (!master) throw new Error("読めません");
    const text = writeICalendar({
      base: BASE,
      entries: [
        {
          event: { ...master, exdates: ["2026-12-15T14:00:00Z"] },
          fields: ["recurrence"],
        },
        {
          event: {
            ...master,
            recurrenceId: "2026-12-22T14:00:00Z",
            rrule: null,
            startAt: "2026-12-22T16:00:00Z",
            endAt: "2026-12-22T17:00:00Z",
          },
          fields: "all",
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("EXDATE;TZID=America/New_York:20261215T090000");
    expect(text).toContain(
      "RECURRENCE-ID;TZID=America/New_York:20261222T090000",
    );
    expect(text).not.toMatch(/EXDATE:\d+T\d+Z/);
    const rows = read(text);
    expect(rows[0]?.exdates).toEqual(["2026-12-15T14:00:00Z"]);
    expect(rows.at(-1)?.recurrenceId).toBe("2026-12-22T14:00:00Z");
  });

  it("浮動時刻と UTC の原本では、EXDATE もその形で書く", () => {
    const floating = simple([
      "DTSTART:20261201T090000",
      "DTEND:20261201T100000",
      "RRULE:FREQ=DAILY",
    ]);
    const [floatingMaster] = read(floating);
    if (!floatingMaster) throw new Error("読めません");
    const floatingText = writeICalendar({
      base: floating,
      entries: [
        {
          // 東京の 12/8 9:00 (浮動時刻は defaultTimeZone で読む)。
          event: { ...floatingMaster, exdates: ["2026-12-08T00:00:00Z"] },
          fields: ["recurrence"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(floatingText).toContain("EXDATE:20261208T090000\r\n");
    expect(read(floatingText)[0]?.exdates).toEqual(["2026-12-08T00:00:00Z"]);

    const utc = simple([
      "DTSTART:20261201T090000Z",
      "DTEND:20261201T100000Z",
      "RRULE:FREQ=DAILY",
    ]);
    const [utcMaster] = read(utc);
    if (!utcMaster) throw new Error("読めません");
    const utcText = writeICalendar({
      base: utc,
      entries: [
        {
          event: { ...utcMaster, exdates: ["2026-12-08T09:00:00Z"] },
          fields: ["recurrence"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(utcText).toContain("EXDATE:20261208T090000Z");
  });

  it("既存の EXDATE は、残る値を元の形のまま残す", () => {
    const base = simple([
      "DTSTART;TZID=America/New_York:20261201T090000",
      "DTEND;TZID=America/New_York:20261201T100000",
      "RRULE:FREQ=WEEKLY",
      "EXDATE;TZID=America/New_York:20261208T090000,20261215T090000",
    ]);
    const [master] = read(base);
    if (!master) throw new Error("読めません");
    expect(master.exdates).toEqual([
      "2026-12-08T14:00:00Z",
      "2026-12-15T14:00:00Z",
    ]);
    const text = writeICalendar({
      base,
      entries: [
        {
          event: {
            ...master,
            exdates: ["2026-12-08T14:00:00Z", "2026-12-22T14:00:00Z"],
          },
          fields: ["recurrence"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("EXDATE;TZID=America/New_York:20261208T090000\r\n");
    expect(text).toContain("EXDATE;TZID=America/New_York:20261222T090000\r\n");
    expect(text).not.toContain("20261215T090000");
    expect(read(text)[0]?.exdates).toEqual([
      "2026-12-08T14:00:00Z",
      "2026-12-22T14:00:00Z",
    ]);
  });

  it("参加者のいる新しい予定には ORGANIZER を書き、新しい参加者に RSVP=TRUE を付ける", () => {
    const text = writeICalendar({
      base: null,
      entries: [
        {
          event: event({
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
            ],
          }),
          fields: "all",
        },
      ],
      organizer: { email: "me@example.com", name: "Me" },
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("ORGANIZER;CN=Me:mailto:me@example.com");
    const attendeeLines = text
      .replace(/\r\n /g, "")
      .split("\r\n")
      .filter((entry) => entry.startsWith("ATTENDEE"));
    expect(
      attendeeLines.find((entry) => entry.includes("bob@example.com")),
    ).toContain("RSVP=TRUE");
    expect(
      attendeeLines.find((entry) => entry.includes("me@example.com")),
    ).not.toContain("RSVP");
    expect(read(text)[0]?.organizer).toMatchObject({
      email: "me@example.com",
    });

    // 参加者がいなければ書かない。
    const alone = writeICalendar({
      base: null,
      entries: [{ event: event(), fields: "all" }],
      organizer: { email: "me@example.com" },
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(alone).not.toContain("ORGANIZER");
  });

  it("新しい例外は原本の ORGANIZER を写し、既存の ORGANIZER は変えない", () => {
    const base = simple([
      "DTSTART:20261201T090000Z",
      "DTEND:20261201T100000Z",
      "RRULE:FREQ=DAILY",
      "ORGANIZER;CN=Alice:mailto:alice@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com",
    ]);
    const [master] = read(base);
    if (!master) throw new Error("読めません");
    const text = writeICalendar({
      base,
      entries: [
        {
          event: {
            ...master,
            recurrenceId: "2026-12-03T09:00:00Z",
            rrule: null,
            startAt: "2026-12-03T10:00:00Z",
            endAt: "2026-12-03T11:00:00Z",
          },
          fields: "all",
        },
      ],
      organizer: { email: "me@example.com" },
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(
      text.match(/ORGANIZER;CN=Alice:mailto:alice@example.com/g),
    ).toHaveLength(2);
    expect(text).not.toContain("ORGANIZER:mailto:me@example.com");
    expect(text).toContain("RECURRENCE-ID:20261203T090000Z");
  });

  it("RECURRENCE-ID を読めない VEVENT は原本と取り違えず、そのまま残す", () => {
    const base = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:s-1",
      "RECURRENCE-ID:garbage",
      "DTSTART:20261203T090000Z",
      "SUMMARY:読めない例外",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:s-1",
      "DTSTART:20261201T090000Z",
      "DTEND:20261201T100000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:原本",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const master = read(base).find((row) => row.recurrenceId === null);
    if (!master) throw new Error("読めません");
    const text = writeICalendar({
      base,
      entries: [
        { event: { ...master, summary: "原本 (改題)" }, fields: ["summary"] },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("RECURRENCE-ID:garbage");
    expect(text).toContain("SUMMARY:読めない例外");
    expect(text).toContain("SUMMARY:原本 (改題)");
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it("説明を変えたら X-ALT-DESC を消し、変えなければ残す", () => {
    const base = simple([
      "DTSTART:20261201T090000Z",
      "DTEND:20261201T100000Z",
      "DESCRIPTION:古い説明",
      "X-ALT-DESC;FMTTYPE=text/html:<p>古い説明</p>",
    ]);
    const [master] = read(base);
    if (!master) throw new Error("読めません");
    const changed = writeICalendar({
      base,
      entries: [
        {
          event: { ...master, description: "新しい説明" },
          fields: ["description"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(changed).toContain("DESCRIPTION:新しい説明");
    expect(changed).not.toContain("X-ALT-DESC");
    const same = writeICalendar({
      base,
      entries: [
        {
          event: { ...master, summary: "題" },
          fields: ["summary", "description"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(same).toContain("X-ALT-DESC");
  });

  it("終日の負の分は正の TRIGGER (PT9H) で書き、読み直しても同じ値 (往復)", () => {
    const allDay = event({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-12-24",
      endDate: "2026-12-25",
      startTimeZone: null,
      endTimeZone: null,
      reminders: [
        { method: "display", minutes: -540 },
        { method: "display", minutes: -1439 },
        { method: "display", minutes: -90 },
        { method: "display", minutes: 900 },
        { method: "display", minutes: -5000 }, // -1439 に丸める (重なるので 1 つ)
      ],
    });
    const text = writeICalendar({
      base: null,
      entries: [{ event: allDay, fields: "all" }],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("TRIGGER:PT9H\r\n");
    expect(text).toContain("TRIGGER:PT23H59M\r\n");
    expect(text).toContain("TRIGGER:PT1H30M\r\n");
    expect(text).toContain("TRIGGER:-PT900M\r\n");
    const [parsed] = read(text);
    expect(parsed?.reminders?.map((item) => item.minutes)).toEqual([
      -540, -1439, -90, 900,
    ]);
    // 読んだ値でもう一度書いても変わらない (CalDAV の書き戻しの往復)。
    const again = writeICalendar({
      base: text,
      entries: [
        {
          event: parsed as ICalEventData,
          fields: ["reminders", "useDefaultReminders"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(read(again)[0]?.reminders).toEqual(parsed?.reminders);
    expect(again.match(/BEGIN:VALARM/g)).toHaveLength(4);
  });

  it("時刻のある予定の負の分は 0 (開始の時刻) に丸める", () => {
    const text = writeICalendar({
      base: null,
      entries: [
        {
          event: event({ reminders: [{ method: "display", minutes: -540 }] }),
          fields: "all",
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).toContain("TRIGGER:-PT0M\r\n");
    expect(read(text)[0]?.reminders).toEqual([
      { method: "display", minutes: 0 },
    ]);
  });

  it("終日の予定のリマインダーを変えても、読まない VALARM (RELATED=END、絶対時刻、翌日以降) は残す", () => {
    const base = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Example//EN",
      "BEGIN:VEVENT",
      "UID:d1",
      "DTSTAMP:20261101T000000Z",
      "DTSTART;VALUE=DATE:20261224",
      "DTEND;VALUE=DATE:20261225",
      "SUMMARY:休み",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:PT9H",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER;RELATED=END:-PT1H",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER;VALUE=DATE-TIME:20261223T000000Z",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:PT30H",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const [master] = read(base);
    expect(master?.reminders).toEqual([{ method: "display", minutes: -540 }]);
    const text = writeICalendar({
      base,
      entries: [
        {
          event: {
            ...(master as ICalEventData),
            reminders: [{ method: "display", minutes: -720 }],
          },
          fields: ["reminders"],
        },
      ],
      defaultTimeZone: "Asia/Tokyo",
      now: NOW,
    });
    expect(text).not.toContain("TRIGGER:PT9H\r\n");
    expect(text).toContain("TRIGGER:PT12H\r\n");
    expect(text).toContain("TRIGGER;RELATED=END:-PT1H");
    expect(text).toContain("TRIGGER;VALUE=DATE-TIME:20261223T000000Z");
    expect(text).toContain("TRIGGER:PT30H");
    expect(read(text)[0]?.reminders).toEqual([
      { method: "display", minutes: -720 },
    ]);
  });
});
