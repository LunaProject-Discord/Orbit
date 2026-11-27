import { describe, expect, it } from "vitest";
import {
  ICalendarError,
  MAX_COMPONENT_DEPTH,
  parseICalendar,
} from "./icalendar.js";

const options = { defaultTimeZone: "Asia/Tokyo" };

const crlf = (lines: string[]) => lines.join("\r\n");

describe("parseICalendar", () => {
  it.each([
    ["REQUEST", "REQUEST"],
    ["CANCEL", "CANCEL"],
    ["reply", "REPLY"],
    [null, null],
  ])("METHOD (%s) を大文字で返す", (method, expected) => {
    const calendar = parseICalendar(
      crlf([
        "BEGIN:VCALENDAR",
        ...(method ? [`METHOD:${method}`] : []),
        "BEGIN:VEVENT",
        "UID:m@example.com",
        "DTSTART:20261201T000000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
      options,
    );
    expect(calendar.method).toBe(expected);
  });

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

describe("parseICalendar (悪意のある入力)", () => {
  const LINES = 60_000;
  /** 1 回目は JIT の暖機で遅いことがあるので、2 回測って速い方を見る。 */
  function timed(run: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 2; round++) {
      const started = performance.now();
      try {
        run();
      } catch (error) {
        if (!(error instanceof ICalendarError)) throw error;
      }
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  function filler(count: number, line: (index: number) => string): string[] {
    return Array.from({ length: count }, (_, index) => line(index));
  }

  it("閉じない BEGIN:VEVENT を 60,000 行並べても 100ms 以下で投げる", () => {
    const input = crlf([
      "BEGIN:VCALENDAR",
      ...filler(LINES / 2, () => "BEGIN:VEVENT"),
      ...filler(LINES / 2 - 2, (index) => `SUMMARY:${index}`),
      "END:VCALENDAR",
    ]);
    expect(input.length).toBeGreaterThan(500_000);
    expect(() => parseICalendar(input, options)).toThrow(ICalendarError);
    expect(timed(() => parseICalendar(input, options))).toBeLessThan(100);
  });

  it("閉じない BEGIN:VEVENT を 3 段で止めても、続く 60,000 行を 100ms 以下で読む", () => {
    const input = crlf([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "BEGIN:VEVENT",
      "BEGIN:VEVENT",
      "UID:x",
      "DTSTART:20261201T000000Z",
      ...filler(LINES, (index) => `X-FILL:${index}`),
      "END:VCALENDAR",
    ]);
    expect(timed(() => parseICalendar(input, options))).toBeLessThan(100);
  });

  it("入れ子は MAX_COMPONENT_DEPTH まで読み、超えたら投げる", () => {
    expect(MAX_COMPONENT_DEPTH).toBe(4);
    const ok = crlf([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:d",
      "DTSTART:20261201T000000Z",
      "BEGIN:VALARM",
      "BEGIN:X-INNER",
      "END:X-INNER",
      "TRIGGER:-PT10M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const event = parseICalendar(ok, options).events[0];
    expect(event?.reminders).toEqual([{ method: "display", minutes: 10 }]);
    // VALARM と中身の行も VEVENT の raw に入る。
    expect(event?.raw).toContain("BEGIN:X-INNER");
    expect(event?.raw.startsWith("BEGIN:VEVENT")).toBe(true);
    expect(event?.raw.endsWith("END:VEVENT")).toBe(true);
    const deep = ok.replace(
      "BEGIN:X-INNER\r\nEND:X-INNER",
      "BEGIN:X-INNER\r\nBEGIN:X-DEEPER\r\nEND:X-DEEPER\r\nEND:X-INNER",
    );
    expect(() => parseICalendar(deep, options)).toThrow(ICalendarError);
  });

  it("raw は VEVENT ごとの行だけ (ほかの予定の行を含まない)", () => {
    const calendar = parseICalendar(
      crlf([
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART:20261201T000000Z",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:b",
        "DTSTART:20261202T000000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ]),
      options,
    );
    expect(calendar.events.map((event) => event.raw)).toEqual([
      "BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261201T000000Z\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261202T000000Z\r\nEND:VEVENT",
    ]);
  });

  it.each([
    [
      "同じ UID の予定を並べる",
      () =>
        filler(LINES / 4, () =>
          [
            "BEGIN:VEVENT",
            "UID:same",
            "DTSTART:20261201T000000Z",
            "END:VEVENT",
          ].join("\r\n"),
        ),
    ],
    [
      "違う UID の予定を並べる",
      () =>
        filler(LINES / 4, (index) =>
          [
            "BEGIN:VEVENT",
            `UID:u${index}`,
            "DTSTART:20261201T000000Z",
            "END:VEVENT",
          ].join("\r\n"),
        ),
    ],
    [
      "1 つの予定に ATTENDEE を並べる",
      () => [
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART:20261201T000000Z",
        ...filler(LINES, (index) => `ATTENDEE:mailto:p${index}@example.com`),
        "END:VEVENT",
      ],
    ],
    [
      "1 行を 60,000 回折り返す",
      () => [
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART:20261201T000000Z",
        "DESCRIPTION:x",
        ...filler(LINES, () => " xxxxxxxxxxxx"),
        "END:VEVENT",
      ],
    ],
  ])("%s 60,000 行", (_, body) => {
    const input = crlf(["BEGIN:VCALENDAR", ...body(), "END:VCALENDAR"]);
    // 行数の上限なしでも行数に比例する時間で読み切る (入れ子×行数だった前は 30 秒以上)。
    // 並列のテストで揺れるので、ここは余裕を見て 250ms。
    expect(
      timed(() => parseICalendar(input, { ...options, maxEvents: 100 })),
    ).toBeLessThan(250);
    // 招待のルートと同じく行数の上限を付ければ、読む前に投げる。
    const limited = { ...options, maxEvents: 100, maxLines: 10_000 };
    expect(() => parseICalendar(input, limited)).toThrow(ICalendarError);
    expect(timed(() => parseICalendar(input, limited))).toBeLessThan(100);
  });

  it("maxEvents は同じ UID の重なりも数える", () => {
    const input = crlf([
      "BEGIN:VCALENDAR",
      ...["SUMMARY:1", "SUMMARY:2", "SUMMARY:3"].flatMap((summary) => [
        "BEGIN:VEVENT",
        "UID:same",
        "DTSTART:20261201T000000Z",
        summary,
        "END:VEVENT",
      ]),
      "END:VCALENDAR",
    ]);
    const calendar = parseICalendar(input, { ...options, maxEvents: 2 });
    expect(calendar.events.map((event) => event.summary)).toEqual(["2"]);
  });

  it("maxLines を超えたら投げる", () => {
    const input = crlf([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART:20261201T000000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    expect(() => parseICalendar(input, { ...options, maxLines: 5 })).toThrow(
      ICalendarError,
    );
    expect(
      parseICalendar(input, { ...options, maxLines: 6 }).events,
    ).toHaveLength(1);
  });
});
