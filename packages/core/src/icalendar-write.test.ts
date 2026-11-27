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
