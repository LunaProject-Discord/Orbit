import { describe, expect, it } from "vitest";
import { ICalendarError, parseICalendar } from "./icalendar.js";

const options = { defaultTimeZone: "Asia/Tokyo" };

const crlf = (lines: string[]) => lines.join("\r\n");

describe("parseICalendar", () => {
  it("エスケープされたバックスラッシュを 1 つに戻す", () => {
    const calendar = parseICalendar(
      crlf([
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:c@example.com",
        "DTSTART:20261201T000000Z",
        "SUMMARY:C:\\\\temp\\, 共有",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
      options,
    );
    expect(calendar.events[0]?.summary).toBe("C:\\temp, 共有");
  });

  it("カレンダーの名前と色、時刻付き・終日の予定を読む", () => {
    const calendar = parseICalendar(
      crlf([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "X-WR-CALNAME:チーム\\, 共有",
        "X-WR-TIMEZONE:Asia/Tokyo",
        "X-APPLE-CALENDAR-COLOR:#1BADF8FF",
        "BEGIN:VEVENT",
        "UID:a@example.com",
        "DTSTART;TZID=Asia/Tokyo:20261201T100000",
        "DTEND;TZID=Asia/Tokyo:20261201T113000",
        "SUMMARY:定例\\, 第 1 回",
        "DESCRIPTION:1 行目\\n2 行目",
        "LOCATION:会議室 A",
        "TRANSP:TRANSPARENT",
        "STATUS:TENTATIVE",
        "SEQUENCE:2",
        "LAST-MODIFIED:20261120T010203Z",
        'ORGANIZER;CN="Sato, Taro":mailto:sato@example.com',
        "ATTENDEE;CN=Suzuki;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:suzuki@example.com",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:b@example.com",
        "DTSTART;VALUE=DATE:20261224",
        "DTEND;VALUE=DATE:20261226",
        "SUMMARY:休み",
        "END:VEVENT",
        "BEGIN:VTODO",
        "UID:todo",
        "DTSTART:20261201T000000Z",
        "END:VTODO",
        "END:VCALENDAR",
      ]),
      options,
    );
    expect(calendar).toMatchObject({
      name: "チーム, 共有",
      color: "#1badf8",
      timeZone: "Asia/Tokyo",
    });
    expect(calendar.events).toHaveLength(2);
    expect(calendar.events[0]).toMatchObject({
      uid: "a@example.com",
      recurrenceId: null,
      summary: "定例, 第 1 回",
      description: "1 行目\n2 行目",
      location: "会議室 A",
      busy: false,
      status: "tentative",
      sequence: 2,
      allDay: false,
      startAt: "2026-12-01T01:00:00Z",
      endAt: "2026-12-01T02:30:00Z",
      startTimeZone: "Asia/Tokyo",
      remoteUpdatedAt: "2026-11-20T01:02:03Z",
      organizer: { email: "sato@example.com", name: "Sato, Taro" },
      attendees: [
        {
          email: "suzuki@example.com",
          name: "Suzuki",
          role: "optional",
          status: "accepted",
        },
      ],
      reminders: null,
    });
    expect(calendar.events[1]).toMatchObject({
      allDay: true,
      startDate: "2026-12-24",
      endDate: "2026-12-26",
      startAt: null,
    });
  });

  it("繰り返しと例外、Windows のタイムゾーン名、折り返しを読む", () => {
    const calendar = parseICalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTIMEZONE",
        "TZID:Tokyo Standard Time",
        "BEGIN:STANDARD",
        "DTSTART:16010101T000000",
        "TZOFFSETFROM:+0900",
        "TZOFFSETTO:+0900",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:r1",
        "DTSTART;TZID=Tokyo Standard Time:20261201T100000",
        "DURATION:PT1H",
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
        "EXDATE;TZID=Tokyo Standard Time:20261208T100000,20261222T100000",
        "SUMMARY:長いタイトルを",
        " 折り返したもの",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "END:VALARM",
        "BEGIN:VALARM",
        "ACTION:EMAIL",
        "TRIGGER:-P1D",
        "END:VALARM",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:r1",
        "RECURRENCE-ID;TZID=Tokyo Standard Time:20261215T100000",
        "DTSTART;TZID=Tokyo Standard Time:20261215T130000",
        "DTEND;TZID=Tokyo Standard Time:20261215T140000",
        "SUMMARY:ずらした回",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n"),
      options,
    );
    const [master, exception] = calendar.events;
    expect(master).toMatchObject({
      summary: "長いタイトルを折り返したもの",
      startTimeZone: "Asia/Tokyo",
      startAt: "2026-12-01T01:00:00Z",
      endAt: "2026-12-01T02:00:00Z",
      rrule: "FREQ=WEEKLY;BYDAY=TU",
      exdates: ["2026-12-08T01:00:00Z", "2026-12-22T01:00:00Z"],
      reminders: [
        { method: "display", minutes: 15 },
        { method: "email", minutes: 1440 },
      ],
    });
    expect(master?.raw).toContain("BEGIN:VALARM");
    expect(master?.raw.startsWith("BEGIN:VEVENT")).toBe(true);
    expect(exception).toMatchObject({
      uid: "r1",
      recurrenceId: "2026-12-15T01:00:00Z",
      startAt: "2026-12-15T04:00:00Z",
    });
  });

  it("名前の分からない TZID は VTIMEZONE のオフセットで、浮動時刻は既定のタイムゾーンで読む", () => {
    const calendar = parseICalendar(
      crlf([
        "BEGIN:VCALENDAR",
        "BEGIN:VTIMEZONE",
        "TZID:Custom Zone",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0530",
        "TZOFFSETTO:+0530",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:c",
        "DTSTART;TZID=Custom Zone:20261201T100000",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:f",
        "DTSTART:20261201T100000",
        "DTEND:20261201T110000",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:d",
        "DTSTART;VALUE=DATE:20261201",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
      options,
    );
    expect(calendar.events[0]).toMatchObject({
      startTimeZone: "+05:30",
      startAt: "2026-12-01T04:30:00Z",
      endAt: "2026-12-01T04:30:00Z",
    });
    expect(calendar.events[1]).toMatchObject({
      startTimeZone: null,
      startAt: "2026-12-01T01:00:00Z",
    });
    expect(calendar.events[2]).toMatchObject({
      startDate: "2026-12-01",
      endDate: "2026-12-02",
    });
  });

  it("同じ UID と回が重なれば SEQUENCE の大きい方を使い、UID が無ければ作る", () => {
    const calendar = parseICalendar(
      crlf([
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:x",
        "SEQUENCE:3",
        "DTSTART:20261201T000000Z",
        "SUMMARY:新",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:x",
        "SEQUENCE:1",
        "DTSTART:20261201T000000Z",
        "SUMMARY:旧",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "DTSTART:20261202T000000Z",
        "SUMMARY:UID なし",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
      options,
    );
    expect(calendar.events.map((event) => event.summary)).toEqual([
      "新",
      "UID なし",
    ]);
    expect(calendar.events[1]?.uid).toMatch(/^orbit-[0-9a-f]{32}$/);
  });

  it("iCalendar でなければ ICalendarError", () => {
    expect(() => parseICalendar("<html></html>", options)).toThrow(
      ICalendarError,
    );
  });
});
