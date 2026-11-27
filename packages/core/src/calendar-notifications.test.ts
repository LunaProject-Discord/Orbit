import { describe, expect, it } from "vitest";
import {
  calendarPushTtlSeconds,
  cancelText,
  cleanNotificationText,
  DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
  type EventNoticeSnapshot,
  eventNoticeChanges,
  formatEventWhen,
  inviteBatchText,
  inviteText,
  readCalendarNotificationSettings,
  reminderText,
  rsvpFailedText,
  toCalendarFcmData,
  toReminderMessage,
  updateText,
} from "./calendar-notifications.js";
import { planReminders } from "./reminders.js";

const tokyo = {
  timeZone: "Asia/Tokyo",
  now: Date.parse("2026-11-28T00:00:00Z"), // 東京 11/28 (土) 9:00
};

const meeting = {
  allDay: false as const,
  startAt: "2026-11-28T01:00:00Z",
  endAt: "2026-11-28T02:00:00Z",
};

const snapshot = (
  over: Partial<EventNoticeSnapshot> = {},
): EventNoticeSnapshot =>
  ({
    title: "定例会議",
    location: "会議室 A",
    organizer: "山田 太郎",
    sequence: 0,
    timeZone: "Asia/Tokyo",
    ...meeting,
    ...over,
  }) as EventNoticeSnapshot;

describe("formatEventWhen", () => {
  it("今日は時刻だけ、別の日は日付付き", () => {
    expect(formatEventWhen(meeting, tokyo)).toBe("10:00〜11:00");
    expect(
      formatEventWhen(
        {
          allDay: false,
          startAt: "2026-11-29T01:00:00Z",
          endAt: "2026-11-29T02:00:00Z",
        },
        tokyo,
      ),
    ).toBe("11月29日(日) 10:00〜11:00");
  });

  it("日をまたぐ予定は終わりにも日付", () => {
    expect(
      formatEventWhen(
        {
          allDay: false,
          startAt: "2026-11-28T13:00:00Z",
          endAt: "2026-11-28T16:00:00Z",
        },
        tokyo,
      ),
    ).toBe("22:00〜11月29日(日) 01:00");
  });

  it("終日は今日・明日・日付、複数日は範囲", () => {
    const day = (startDate: string, endDate: string) =>
      formatEventWhen({ allDay: true, startDate, endDate }, tokyo);
    expect(day("2026-11-28", "2026-11-29")).toBe("今日 (終日)");
    expect(day("2026-11-29", "2026-11-30")).toBe("明日 (終日)");
    expect(day("2026-11-30", "2026-12-01")).toBe("11月30日(月) (終日)");
    expect(day("2026-11-30", "2026-12-03")).toBe("11月30日(月)〜12月2日(水)");
  });

  it("利用者のタイムゾーンで今日を決める", () => {
    expect(
      formatEventWhen(meeting, { ...tokyo, timeZone: "America/New_York" }),
    ).toBe("20:00〜21:00"); // ニューヨークでは 11/27 の夜で、今日
    expect(
      formatEventWhen(meeting, {
        ...tokyo,
        now: Date.parse("2026-11-27T04:00:00Z"),
        timeZone: "America/New_York",
      }),
    ).toBe("11月27日(金) 20:00〜21:00");
    expect(
      formatEventWhen(meeting, {
        ...tokyo,
        now: Date.parse("2026-11-27T04:00:00Z"),
      }),
    ).toBe("11月28日(土) 10:00〜11:00");
  });

  it("書き方を差し替えられる", () => {
    expect(
      formatEventWhen(
        {
          allDay: false,
          startAt: "2026-11-29T01:00:00Z",
          endAt: "2026-11-29T02:00:00Z",
        },
        {
          ...tokyo,
          format: {
            date: (date) => date.toString(),
            time: (time) => `${time.hour}時`,
          },
        },
      ),
    ).toBe("2026-11-29 10時〜11時");
  });
});

describe("リマインダーの文言", () => {
  it("題名と日時・場所", () => {
    expect(
      reminderText(
        meeting,
        { summary: "定例会議", location: "会議室 A" },
        tokyo,
      ),
    ).toEqual({ title: "定例会議", body: "10:00〜11:00 · 会議室 A" });
  });

  it("題名なし、長い題名の切り詰め、制御文字", () => {
    expect(
      reminderText(meeting, { summary: "  ", location: null }, tokyo),
    ).toEqual({ title: "(タイトルなし)", body: "10:00〜11:00" });
    const long = reminderText(
      meeting,
      { summary: `a\u0000b\nc${"x".repeat(200)}`, location: null },
      tokyo,
    );
    expect(long.title.startsWith("a b c")).toBe(true);
    expect([...long.title]).toHaveLength(150);
    expect(long.title.endsWith("…")).toBe(true);
  });

  it("中身を出さない設定", () => {
    expect(
      reminderText(
        meeting,
        { summary: "秘密", location: "どこか" },
        { ...tokyo, detail: "private" },
      ),
    ).toEqual({ title: "予定のリマインダー", body: "10:00 から" });
    expect(
      reminderText(
        { allDay: true, startDate: "2026-11-29", endDate: "2026-11-30" },
        { summary: "秘密", location: null },
        { ...tokyo, detail: "private" },
      ),
    ).toEqual({ title: "予定のリマインダー", body: "明日 (終日)" });
  });

  it("planReminders の結果から通知を作る", () => {
    const [planned] = planReminders({
      calendars: [
        {
          id: "c1",
          notify: true,
          visible: true,
          defaultReminders: [{ method: "display", minutes: 10 }],
          timeZone: "Asia/Tokyo",
        },
      ],
      events: [
        {
          id: "e1",
          calendarId: "c1",
          parentId: null,
          recurrenceId: null,
          status: "confirmed",
          allDay: false,
          startDate: null,
          endDate: null,
          startTimeZone: "Asia/Tokyo",
          rrule: null,
          useDefaultReminders: true,
          reminders: [],
          ...meeting,
        },
      ],
      settings: { timeZone: "Asia/Tokyo", allDay: null },
      from: tokyo.now - 60 * 60_000,
      to: tokyo.now + 24 * 60 * 60_000,
    });
    if (!planned) throw new Error("no reminder");
    const message = toReminderMessage(
      planned,
      { summary: "定例会議", location: null },
      tokyo,
    );
    expect(message).toEqual({
      kind: "event-reminder",
      title: "定例会議",
      body: "10:00〜11:00",
      tag: "cal-rem:e1:-:10",
      eventId: "e1",
      recurrenceId: null,
      expiresAt: Date.parse(meeting.endAt),
      calendarId: "c1",
    });
    expect(toCalendarFcmData(message)).toEqual({
      kind: "event-reminder",
      title: "定例会議",
      body: "10:00〜11:00",
      tag: "cal-rem:e1:-:10",
      eventId: "e1",
      expiresAt: String(Date.parse(meeting.endAt)),
      calendarId: "c1",
      channel: "calendar-reminders",
    });
  });
});

describe("招待・変更・取り消しの文言", () => {
  it("招待", () => {
    expect(inviteText(snapshot(), tokyo)).toEqual({
      title: "招待: 定例会議",
      body: "山田 太郎 さんから · 10:00〜11:00",
    });
    expect(inviteText(snapshot({ organizer: null }), tokyo).body).toBe(
      "10:00〜11:00",
    );
    expect(inviteText(snapshot(), { ...tokyo, detail: "private" })).toEqual({
      title: "新しい招待",
      body: "",
    });
  });

  it("まとめ", () => {
    expect(
      inviteBatchText(["山田 太郎", "佐藤 花子", "山田 太郎"], 4, {}),
    ).toEqual({ title: "新しい招待 4 件", body: "山田 太郎、佐藤 花子 ほか" });
    expect(inviteBatchText(["a", "b"], 2, {}).body).toBe("a、b");
  });

  it("変更 (日時・場所・両方)", () => {
    const moved = snapshot({
      startAt: "2026-11-29T04:00:00Z",
      endAt: "2026-11-29T05:00:00Z",
    } as Partial<EventNoticeSnapshot>);
    expect(updateText(snapshot(), moved, tokyo)).toEqual({
      title: "変更: 定例会議",
      body: "日時が 11月29日(日) 13:00〜14:00 になりました",
    });
    expect(
      updateText(snapshot(), snapshot({ location: "会議室 B" }), tokyo).body,
    ).toBe("場所が 会議室 B になりました");
    expect(
      updateText(snapshot(), { ...moved, location: "会議室 B" }, tokyo).body,
    ).toBe("11月29日(日) 13:00〜14:00 · 会議室 B になりました");
  });

  it("取り消しと出欠の失敗", () => {
    expect(cancelText(snapshot(), tokyo)).toEqual({
      title: "取り消し: 定例会議",
      body: "10:00〜11:00 の予定は取り消されました",
    });
    expect(rsvpFailedText("定例会議")).toEqual({
      title: "出欠を反映できませんでした",
      body: "定例会議",
    });
  });

  it("日時と場所の変化を見分ける (書き方の違いは同じ時刻)", () => {
    expect(
      eventNoticeChanges(
        snapshot(),
        snapshot({
          startAt: "2026-11-28T10:00:00+09:00",
          title: "別の題名",
        } as Partial<EventNoticeSnapshot>),
      ),
    ).toEqual({ when: false, location: false });
    expect(
      eventNoticeChanges(snapshot(), snapshot({ rrule: "FREQ=DAILY" })).when,
    ).toBe(true);
    expect(
      eventNoticeChanges(
        snapshot(),
        snapshot({
          allDay: true,
          startDate: "2026-11-28",
          endDate: "2026-11-29",
        } as Partial<EventNoticeSnapshot>),
      ).when,
    ).toBe(true);
  });
});

describe("その他", () => {
  it("設定を読む", () => {
    expect(readCalendarNotificationSettings(null)).toEqual(
      DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
    );
    expect(
      readCalendarNotificationSettings({
        invites: false,
        allDay: null,
        detail: "private",
        changes: "yes",
      }),
    ).toEqual({
      invites: false,
      changes: true,
      replies: false,
      allDay: null,
      detail: "private",
    });
    expect(
      readCalendarNotificationSettings({ allDay: { minutes: 900 } }).allDay,
    ).toEqual({ minutes: 900 });
  });

  it("預かり時間はリマインダーは終了まで (60 秒〜24 時間)、ほかは 24 時間", () => {
    const now = 1_000_000;
    expect(
      calendarPushTtlSeconds(
        { kind: "event-reminder", expiresAt: now + 3600_000 },
        now,
      ),
    ).toBe(3600);
    expect(
      calendarPushTtlSeconds({ kind: "event-reminder", expiresAt: now }, now),
    ).toBe(60);
    expect(
      calendarPushTtlSeconds(
        { kind: "event-reminder", expiresAt: now + 3 * 86400_000 },
        now,
      ),
    ).toBe(86400);
    expect(calendarPushTtlSeconds({ kind: "event-invite" }, now)).toBe(86400);
  });

  it("制御文字と改行を空白にする", () => {
    expect(cleanNotificationText("a\u0007\u2028b\r\nc", 10)).toBe("a b c");
    expect(cleanNotificationText(null, 10)).toBe("");
  });

  it("出欠のボタンの送り先を FCM の data に載せる", () => {
    expect(
      toCalendarFcmData({
        kind: "event-invite",
        title: "t",
        body: "b",
        tag: "cal-inv:e1",
        eventId: "e1",
        rsvp: { url: "https://x/v1/notification-actions/event", token: "k" },
      }),
    ).toEqual({
      kind: "event-invite",
      title: "t",
      body: "b",
      tag: "cal-inv:e1",
      eventId: "e1",
      channel: "calendar-invites",
      rsvpUrl: "https://x/v1/notification-actions/event",
      rsvpToken: "k",
    });
  });
});
