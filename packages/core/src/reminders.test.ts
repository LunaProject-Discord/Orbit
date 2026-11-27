import { describe, expect, it } from "vitest";
import {
  calendarNotifies,
  calendarRemindersFingerprint,
  clampReminderCoverUntil,
  deviceCoversReminder,
  isReminderLate,
  type PlannedReminder,
  type PlanRemindersInput,
  parseReminderTag,
  planReminders,
  type ReminderCalendar,
  type ReminderEvent,
  reminderTag,
  selectDeviceReminders,
  selfResponse,
} from "./reminders.js";

const ms = (iso: string) => Date.parse(iso);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const calendar = (over: Partial<ReminderCalendar> = {}): ReminderCalendar => ({
  id: "c1",
  notify: true,
  visible: true,
  defaultReminders: [{ method: "display", minutes: 10 }],
  timeZone: "Asia/Tokyo",
  ...over,
});

const timed = (over: Partial<ReminderEvent> = {}): ReminderEvent => ({
  id: "e1",
  calendarId: "c1",
  parentId: null,
  recurrenceId: null,
  status: "confirmed",
  allDay: false,
  startAt: "2026-12-01T01:00:00Z",
  endAt: "2026-12-01T02:00:00Z",
  startDate: null,
  endDate: null,
  startTimeZone: "Asia/Tokyo",
  rrule: null,
  useDefaultReminders: true,
  reminders: [],
  ...over,
});

const allDay = (over: Partial<ReminderEvent> = {}): ReminderEvent => ({
  ...timed(),
  allDay: true,
  startAt: null,
  endAt: null,
  startDate: "2026-12-01",
  endDate: "2026-12-02",
  startTimeZone: null,
  ...over,
});

const plan = (over: Partial<PlanRemindersInput>) =>
  planReminders({
    calendars: [calendar()],
    events: [],
    settings: { timeZone: "Asia/Tokyo", allDay: { minutes: -540 } },
    from: ms("2026-11-27T00:00:00Z"),
    to: ms("2027-01-31T00:00:00Z"),
    ...over,
  });

const brief = (items: PlannedReminder[]) =>
  items.map((item) => [item.tag, new Date(item.fireAt).toISOString()]);

describe("planReminders", () => {
  it("カレンダーの既定のリマインダーで、開始の 10 分前", () => {
    const result = plan({ events: [timed()] });
    expect(result).toEqual([
      {
        tag: "cal-rem:e1:-:10",
        masterId: "e1",
        eventId: "e1",
        calendarId: "c1",
        recurrenceId: null,
        minutes: 10,
        fireAt: ms("2026-12-01T00:50:00Z"),
        expiresAt: ms("2026-12-01T02:00:00Z"),
        allDay: false,
        startAt: "2026-12-01T01:00:00Z",
        endAt: "2026-12-01T02:00:00Z",
      },
    ]);
  });

  it("予定ごとのリマインダーに切り替え、email は除き、28 日に丸める", () => {
    const result = plan({
      events: [
        timed({
          useDefaultReminders: false,
          reminders: [
            { method: "email", minutes: 30 },
            { method: "display", minutes: 0 },
            { method: "display", minutes: 60 * 24 * 40 },
            { method: "display", minutes: 0 },
          ],
        }),
      ],
      from: ms("2026-10-01T00:00:00Z"),
    });
    expect(brief(result)).toEqual([
      ["cal-rem:e1:-:40320", "2026-11-03T01:00:00.000Z"],
      ["cal-rem:e1:-:0", "2026-12-01T01:00:00.000Z"],
    ]);
  });

  it("取り消し・不参加・通知オフ・非表示のカレンダーは鳴らさない", () => {
    expect(plan({ events: [timed({ status: "cancelled" })] })).toEqual([]);
    expect(plan({ events: [timed({ myResponse: "declined" })] })).toEqual([]);
    expect(plan({ events: [timed({ myResponse: "tentative" })] })).toHaveLength(
      1,
    );
    expect(
      plan({ calendars: [calendar({ notify: false })], events: [timed()] }),
    ).toEqual([]);
    expect(
      plan({ calendars: [calendar({ visible: false })], events: [timed()] }),
    ).toEqual([]);
    expect(
      plan({ calendars: [calendar({ id: "other" })], events: [timed()] }),
    ).toEqual([]);
  });

  it("範囲の外の時刻は出さない", () => {
    expect(
      plan({
        events: [timed()],
        from: ms("2026-12-01T00:51:00Z"),
      }),
    ).toEqual([]);
    expect(plan({ events: [timed()], to: ms("2026-12-01T00:50:00Z") })).toEqual(
      [],
    );
  });

  it("繰り返しの回ごとに tag が分かれ、例外で動かした回と取り消した回、EXDATE を反映する", () => {
    const master = timed({
      id: "m1",
      rrule: "FREQ=DAILY;COUNT=5",
      exdates: ["2026-12-03T01:00:00Z"],
    });
    const moved = timed({
      id: "x1",
      parentId: "m1",
      recurrenceId: "2026-12-02T01:00:00Z",
      startAt: "2026-12-02T05:00:00Z",
      endAt: "2026-12-02T06:00:00Z",
    });
    const cancelled = timed({
      id: "x2",
      parentId: "m1",
      recurrenceId: "2026-12-04T01:00:00Z",
      status: "cancelled",
      startAt: "2026-12-04T01:00:00Z",
      endAt: "2026-12-04T02:00:00Z",
    });
    const result = plan({ events: [master, moved, cancelled] });
    expect(
      result.map((item) => [
        item.tag,
        item.eventId,
        new Date(item.fireAt).toISOString(),
      ]),
    ).toEqual([
      ["cal-rem:m1:2026-12-01T01:00:00Z:10", "m1", "2026-12-01T00:50:00.000Z"],
      ["cal-rem:m1:2026-12-02T01:00:00Z:10", "x1", "2026-12-02T04:50:00.000Z"],
      ["cal-rem:m1:2026-12-05T01:00:00Z:10", "m1", "2026-12-05T00:50:00.000Z"],
    ]);
  });

  it("例外だけ不参加なら、その回だけ鳴らさない", () => {
    const master = timed({ id: "m1", rrule: "FREQ=DAILY;COUNT=2" });
    const declined = timed({
      id: "x1",
      parentId: "m1",
      recurrenceId: "2026-12-02T01:00:00Z",
      startAt: "2026-12-02T01:00:00Z",
      endAt: "2026-12-02T02:00:00Z",
      myResponse: "declined",
    });
    expect(brief(plan({ events: [master, declined] }))).toEqual([
      ["cal-rem:m1:2026-12-01T01:00:00Z:10", "2026-12-01T00:50:00.000Z"],
    ]);
  });

  it("親の無い例外は、原本の ID と元の回で tag を作る", () => {
    const orphan = timed({
      id: "x1",
      parentId: "m1",
      recurrenceId: "2026-12-02T01:00:00Z",
      startAt: "2026-12-02T03:00:00Z",
      endAt: "2026-12-02T04:00:00Z",
    });
    const result = plan({ events: [orphan] });
    expect(
      result.map((item) => [item.tag, item.masterId, item.eventId]),
    ).toEqual([["cal-rem:m1:2026-12-02T01:00:00Z:10", "m1", "x1"]]);
  });

  it("夏時間をまたぐ毎週 10:00 (ニューヨーク) は現地 10:00 のまま", () => {
    const weekly = timed({
      id: "w1",
      startAt: "2027-03-07T15:00:00Z", // 10:00 EST
      endAt: "2027-03-07T16:00:00Z",
      startTimeZone: "America/New_York",
      rrule: "FREQ=WEEKLY;COUNT=2",
      useDefaultReminders: false,
      reminders: [{ method: "display", minutes: 0 }],
    });
    const spring = plan({
      calendars: [calendar({ timeZone: "America/New_York" })],
      events: [weekly],
      from: ms("2027-03-01T00:00:00Z"),
      to: ms("2027-03-31T00:00:00Z"),
    });
    expect(spring.map((item) => new Date(item.fireAt).toISOString())).toEqual([
      "2027-03-07T15:00:00.000Z",
      "2027-03-14T14:00:00.000Z", // 10:00 EDT
    ]);
    const fall = plan({
      calendars: [calendar({ timeZone: "America/New_York" })],
      events: [
        {
          ...weekly,
          startAt: "2027-10-31T14:00:00Z", // 10:00 EDT
          endAt: "2027-10-31T15:00:00Z",
        },
      ],
      from: ms("2027-10-25T00:00:00Z"),
      to: ms("2027-11-30T00:00:00Z"),
    });
    expect(fall.map((item) => new Date(item.fireAt).toISOString())).toEqual([
      "2027-10-31T14:00:00.000Z",
      "2027-11-07T15:00:00.000Z", // 10:00 EST
    ]);
  });

  it("時刻のある予定の「1 日前」は経過時間で引く (夏時間で壁時計が 1 時間ずれる)", () => {
    const result = plan({
      calendars: [calendar({ timeZone: "America/New_York" })],
      events: [
        timed({
          startAt: "2027-03-14T14:00:00Z", // 10:00 EDT
          endAt: "2027-03-14T15:00:00Z",
          startTimeZone: "America/New_York",
          useDefaultReminders: false,
          reminders: [{ method: "display", minutes: 1440 }],
        }),
      ],
      from: ms("2027-03-01T00:00:00Z"),
      to: ms("2027-03-31T00:00:00Z"),
    });
    expect(brief(result)).toEqual([
      ["cal-rem:e1:-:1440", "2027-03-13T14:00:00.000Z"], // 前日 9:00 EST
    ]);
  });

  it("浮動時刻の予定はカレンダーのタイムゾーンで展開する", () => {
    const result = plan({
      calendars: [calendar({ timeZone: null })],
      events: [
        timed({
          startTimeZone: null,
          rrule: "FREQ=DAILY;COUNT=1",
        }),
      ],
      settings: { timeZone: "America/New_York", allDay: null },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.recurrenceId).toBe("2026-12-01T01:00:00Z");
  });

  describe("終日の予定", () => {
    it("既定は利用者ごとの設定 (当日 9:00) で、カレンダーの既定は使わない", () => {
      const result = plan({ events: [allDay()] });
      expect(result).toEqual([
        {
          tag: "cal-rem:e1:-:-540",
          masterId: "e1",
          eventId: "e1",
          calendarId: "c1",
          recurrenceId: null,
          minutes: -540,
          fireAt: ms("2026-12-01T00:00:00Z"), // 東京 9:00
          expiresAt: ms("2026-12-01T15:00:00Z"),
          allDay: true,
          startDate: "2026-12-01",
          endDate: "2026-12-02",
        },
      ]);
    });

    it("利用者のタイムゾーンで 0:00 を決める (ニューヨーク)", () => {
      const result = plan({
        events: [allDay()],
        settings: { timeZone: "America/New_York", allDay: { minutes: 900 } },
      });
      expect(brief(result)).toEqual([
        ["cal-rem:e1:-:900", "2026-11-30T14:00:00.000Z"], // 前日 9:00 EST
      ]);
    });

    it("利用者の既定がオフなら鳴らさない。予定ごとの指定はそのまま使う", () => {
      expect(
        plan({
          events: [allDay()],
          settings: { timeZone: "Asia/Tokyo", allDay: null },
        }),
      ).toEqual([]);
      const result = plan({
        events: [
          allDay({
            useDefaultReminders: false,
            reminders: [
              { method: "display", minutes: 420 },
              { method: "display", minutes: -540 },
            ],
          }),
        ],
        settings: { timeZone: "Asia/Tokyo", allDay: null },
      });
      // 予定ごとの負の分は 0 (当日 0:00) に丸める。
      expect(brief(result)).toEqual([
        ["cal-rem:e1:-:420", "2026-11-30T08:00:00.000Z"],
        ["cal-rem:e1:-:0", "2026-11-30T15:00:00.000Z"],
      ]);
    });

    it("「前日 9:00」は夏時間の切り替えをまたいでも壁時計の 9:00", () => {
      const result = plan({
        events: [allDay({ startDate: "2027-03-15", endDate: "2027-03-16" })],
        settings: { timeZone: "America/New_York", allDay: { minutes: 2340 } },
        from: ms("2027-03-01T00:00:00Z"),
        to: ms("2027-03-31T00:00:00Z"),
      });
      // 2 日前 (3/13、EST) の 9:00。経過時間なら 8:00 になる。
      expect(brief(result)).toEqual([
        ["cal-rem:e1:-:2340", "2027-03-13T14:00:00.000Z"],
      ]);
    });

    it("繰り返す終日の予定は日付の recurrenceId", () => {
      const result = plan({
        events: [allDay({ id: "b1", rrule: "FREQ=YEARLY" })],
        from: ms("2026-11-27T00:00:00Z"),
        to: ms("2027-12-31T00:00:00Z"),
      });
      expect(result.map((item) => item.tag)).toEqual([
        "cal-rem:b1:2026-12-01:-540",
        "cal-rem:b1:2027-12-01:-540",
      ]);
    });
  });

  it("予定の終了より後には鳴らさない", () => {
    const result = plan({
      events: [
        allDay({
          useDefaultReminders: true,
        }),
      ],
      settings: { timeZone: "Asia/Tokyo", allDay: { minutes: -1439 } },
    });
    // 当日 23:59 は終了 (翌日 0:00) より前なので鳴る。
    expect(result).toHaveLength(1);
    expect(
      plan({
        events: [allDay()],
        settings: { timeZone: "Asia/Tokyo", allDay: { minutes: -5000 } },
      }),
    ).toHaveLength(1); // -1439 に丸める
  });

  it("同じ入力からは、サーバーと端末で同じ tag と時刻になる (Date と文字列のどちらでも)", () => {
    const fromStrings = plan({
      events: [timed({ rrule: "FREQ=WEEKLY;COUNT=3" })],
    });
    const fromDates = plan({
      events: [
        timed({
          rrule: "FREQ=WEEKLY;COUNT=3",
          startAt: new Date("2026-12-01T01:00:00Z"),
          endAt: new Date("2026-12-01T02:00:00Z"),
        }),
      ],
    });
    expect(fromDates).toEqual(fromStrings);
    expect(fromStrings).toHaveLength(3);
  });
});

describe("tag", () => {
  it("作って読める (recurrenceId の : と負の分)", () => {
    const tag = reminderTag("m1", "2026-12-01T01:00:00Z", -540);
    expect(tag).toBe("cal-rem:m1:2026-12-01T01:00:00Z:-540");
    expect(parseReminderTag(tag)).toEqual({
      masterId: "m1",
      recurrenceId: "2026-12-01T01:00:00Z",
      minutes: -540,
    });
    expect(parseReminderTag("cal-rem:m1:-:10")).toEqual({
      masterId: "m1",
      recurrenceId: null,
      minutes: 10,
    });
    expect(parseReminderTag("mail:m1")).toBeNull();
    expect(parseReminderTag("cal-rem:m1:10")).toBeNull();
  });
});

describe("calendarNotifies", () => {
  it("null は種類ごとの既定", () => {
    expect(calendarNotifies({ source: "google", notify: null })).toBe(true);
    expect(calendarNotifies({ source: "ics", notify: null })).toBe(false);
    expect(calendarNotifies({ source: "holidays", notify: undefined })).toBe(
      false,
    );
    expect(calendarNotifies({ source: "birthdays", notify: true })).toBe(true);
    expect(calendarNotifies({ source: "local", notify: false })).toBe(false);
  });

  it("通知に関わる値が変わったときだけ指紋が変わる", () => {
    const base = {
      notify: true,
      visible: true,
      defaultReminders: [{ method: "display", minutes: 10 }],
      timeZone: "Asia/Tokyo",
    };
    expect(calendarRemindersFingerprint(base)).toBe(
      calendarRemindersFingerprint({ ...base }),
    );
    expect(calendarRemindersFingerprint(base)).not.toBe(
      calendarRemindersFingerprint({ ...base, visible: false }),
    );
  });
});

describe("selfResponse", () => {
  it("self の参加者の出欠", () => {
    expect(
      selfResponse([
        { self: false, status: "accepted" },
        { self: true, status: "declined" },
      ]),
    ).toBe("declined");
    expect(selfResponse([])).toBeNull();
  });
});

describe("端末の予約とサーバーの push", () => {
  const job = { fireAt: ms("2026-12-01T00:50:00Z"), changeSeq: 100n };

  it("範囲内で seq が新しく exact なら省く", () => {
    expect(
      deviceCoversReminder(
        {
          coverUntil: ms("2026-12-02T00:00:00Z"),
          coverSeq: "100",
          exact: true,
        },
        job,
      ),
    ).toBe(true);
  });

  it("範囲外・seq が古い・exact でない・報告が無いなら送る", () => {
    const cover = {
      coverUntil: new Date("2026-12-02T00:00:00Z"),
      coverSeq: 100n,
      exact: true,
    };
    expect(
      deviceCoversReminder(
        { ...cover, coverUntil: new Date("2026-12-01T00:00:00Z") },
        job,
      ),
    ).toBe(false);
    expect(deviceCoversReminder({ ...cover, coverSeq: "99" }, job)).toBe(false);
    expect(deviceCoversReminder({ ...cover, exact: false }, job)).toBe(false);
    expect(deviceCoversReminder({ ...cover, coverUntil: null }, job)).toBe(
      false,
    );
    expect(deviceCoversReminder(null, job)).toBe(false);
    expect(deviceCoversReminder({ ...cover, coverSeq: "abc" }, job)).toBe(
      false,
    );
  });

  it("coverUntil は今 + 8 日に丸める", () => {
    const now = ms("2026-11-27T00:00:00Z");
    expect(clampReminderCoverUntil(now + 30 * DAY, now)).toBe(now + 8 * DAY);
    expect(clampReminderCoverUntil(now + DAY, now)).toBe(now + DAY);
  });

  it("15 分を過ぎた通知は遅れ", () => {
    const fireAt = ms("2026-12-01T00:50:00Z");
    expect(isReminderLate(fireAt, fireAt + 15 * MIN)).toBe(false);
    expect(isReminderLate(fireAt, fireAt + 15 * MIN + 1)).toBe(true);
  });

  it("件数に収まらなければ、入らなかった最初の通知の直前までを予約済みにする", () => {
    const items = plan({
      events: [timed({ rrule: "FREQ=DAILY;COUNT=10" })],
    });
    const to = ms("2027-01-31T00:00:00Z");
    expect(selectDeviceReminders(items, { to }).coverUntil).toBe(to);
    const { reminders, coverUntil } = selectDeviceReminders(items, {
      to,
      limit: 3,
    });
    expect(reminders).toHaveLength(3);
    expect(coverUntil).toBe((items[3] as PlannedReminder).fireAt - 1);
  });

  it("同じ時刻の通知が溢れたら、その時刻を予約済みに含めない", () => {
    const items = plan({
      events: [
        timed({
          useDefaultReminders: false,
          reminders: [
            { method: "display", minutes: 30 },
            { method: "display", minutes: 10 },
          ],
        }),
        timed({ id: "e2" }),
      ],
    });
    expect(items.map((item) => item.minutes)).toEqual([30, 10, 10]);
    const { reminders, coverUntil } = selectDeviceReminders(items, {
      to: ms("2027-01-31T00:00:00Z"),
      limit: 2,
    });
    expect(reminders.map((item) => item.minutes)).toEqual([30]);
    expect(coverUntil).toBe(ms("2026-12-01T00:50:00Z") - 1);
  });
});
