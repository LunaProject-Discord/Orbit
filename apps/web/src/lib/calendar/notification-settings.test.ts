import { DEFAULT_CALENDAR_NOTIFICATION_SETTINGS } from "@orbit/core/calendar-notifications";
import { ALL_DAY_DEFAULT_CHOICES } from "@orbit/core/reminders";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Calendar } from "@/lib/calendar/api";
import {
  allDayDefault,
  allDayReminderLabel,
  allDayReminderParts,
  allDayReminderText,
  allDayReminderValue,
  CalendarNotifyUnsupportedError,
  changeCalendarNotificationSettings,
  currentCalendarNotificationSettings,
  deviceCalendarEnabledFrom,
  overlayCalendar,
  parseTimeInput,
  refreshCalendarNotificationSettings,
  resetCalendarNotificationSettingsForTest,
  saveCalendarNotify,
  timeInputValue,
} from "@/lib/calendar/notification-settings";
import { calendar } from "@/lib/calendar/offline/test-support";

const READY = {
  status: "ready" as const,
  value: {
    calendarNotifications: DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
    timeZone: "Asia/Tokyo",
  },
};

afterEach(() => resetCalendarNotificationSettingsForTest());

describe("終日の予定の通知の値", () => {
  it("開始日の 0:00 の何分前かを、何日前と時刻に分ける", () => {
    const parts = (daysBefore: number, hour: number, minute = 0) => ({
      daysBefore,
      hour,
      minute,
    });
    expect(allDayReminderParts(-540)).toEqual(parts(0, 9));
    expect(allDayReminderParts(0)).toEqual(parts(0, 0));
    expect(allDayReminderParts(900)).toEqual(parts(1, 9));
    expect(allDayReminderParts(420)).toEqual(parts(1, 17));
    expect(allDayReminderParts(9540)).toEqual(parts(7, 9));
    // 時刻のある予定の「10 分前」は、終日では前日 23:50。
    expect(allDayReminderParts(10)).toEqual(parts(1, 23, 50));
    // 範囲の外は丸める (下限は当日 23:59)。
    expect(allDayReminderParts(-5000)).toEqual(parts(0, 23, 59));
  });

  it("何日前と時刻から値に戻し、範囲の外は丸める", () => {
    expect(allDayReminderValue({ daysBefore: 0, hour: 9, minute: 0 })).toBe(
      -540,
    );
    expect(allDayReminderValue({ daysBefore: 1, hour: 9, minute: 0 })).toBe(
      900,
    );
    expect(allDayReminderValue({ daysBefore: 40, hour: 0, minute: 0 })).toBe(
      28 * 1440,
    );
    for (const minutes of [-1439, -540, 0, 1, 900, 1440, 40320]) {
      expect(allDayReminderValue(allDayReminderParts(minutes))).toBe(minutes);
    }
  });

  it("「当日 9:00」「1 日前 9:00」の形で出す", () => {
    expect(allDayReminderText(-540)).toBe("当日 9:00");
    expect(allDayReminderText(900)).toBe("1 日前 9:00");
    expect(allDayReminderText(420)).toBe("1 日前 17:00");
    expect(allDayReminderText(2340)).toBe("2 日前 9:00");
    expect(allDayReminderText(9540)).toBe("1 週間前 9:00");
    expect(allDayReminderText(-1439)).toBe("当日 23:59");
    expect(allDayReminderLabel({ method: "display", minutes: -540 })).toBe(
      "当日 9:00に通知",
    );
    expect(allDayReminderLabel({ method: "email", minutes: 900 })).toBe(
      "1 日前 9:00にメール",
    );
    expect(
      ALL_DAY_DEFAULT_CHOICES.map((value) =>
        value === null ? null : allDayReminderText(value),
      ),
    ).toEqual([null, "当日 9:00", "1 日前 9:00", "1 日前 17:00"]);
  });

  it("時刻の入力欄の値を読み書きする", () => {
    expect(timeInputValue({ hour: 9, minute: 0 })).toBe("09:00");
    expect(timeInputValue({ hour: 23, minute: 59 })).toBe("23:59");
    expect(parseTimeInput("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("")).toBeNull();
  });
});

describe("すべての端末で共通の設定", () => {
  it("古いサーバー (項目が無い) は unsupported にし、取り直さない", async () => {
    const load = vi.fn().mockResolvedValue(null);
    await refreshCalendarNotificationSettings({ load });
    expect(currentCalendarNotificationSettings().status).toBe("unsupported");
    await refreshCalendarNotificationSettings({ load });
    expect(load).toHaveBeenCalledTimes(1);
    // 古いサーバーでは、終日の既定は標準の値 (当日 9:00) として扱う。
    expect(allDayDefault(currentCalendarNotificationSettings())).toEqual({
      minutes: -540,
    });
  });

  it("取得できないときは error", async () => {
    await refreshCalendarNotificationSettings({
      load: () => Promise.reject(new Error("offline")),
    });
    expect(currentCalendarNotificationSettings().status).toBe("error");
  });

  it("変更はすぐ反映し、保存できたら残す (全体を送る)", async () => {
    resetCalendarNotificationSettingsForTest(READY);
    const save = vi.fn().mockResolvedValue(undefined);
    const saved = await changeCalendarNotificationSettings(
      { allDay: { minutes: 900 } },
      save,
    );
    expect(saved).toBe(true);
    expect(save).toHaveBeenCalledWith({
      calendarNotifications: {
        ...DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
        allDay: { minutes: 900 },
      },
      timeZone: "Asia/Tokyo",
    });
    expect(
      currentCalendarNotificationSettings().value?.calendarNotifications.allDay,
    ).toEqual({ minutes: 900 });
  });

  it("保存できなければ元に戻す", async () => {
    resetCalendarNotificationSettingsForTest(READY);
    const saved = await changeCalendarNotificationSettings(
      { invites: false, timeZone: "UTC" },
      () => Promise.reject(new Error("offline")),
    );
    expect(saved).toBe(false);
    expect(currentCalendarNotificationSettings()).toBe(READY);
  });

  it("取得前は変えられない", async () => {
    const save = vi.fn();
    expect(
      await changeCalendarNotificationSettings({ invites: false }, save),
    ).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("端末ごとのオン・オフ", () => {
  it("未設定は新着メールの通知と同じ", () => {
    expect(deviceCalendarEnabledFrom(null, true)).toBe(true);
    expect(deviceCalendarEnabledFrom(null, false)).toBe(false);
    expect(deviceCalendarEnabledFrom("off", true)).toBe(false);
    expect(deviceCalendarEnabledFrom("on", false)).toBe(true);
  });
});

describe("カレンダーごとの通知", () => {
  const base = calendar({ notify: true, notifyDefault: true });

  it("保存した値を返す", async () => {
    const update = vi.fn(async (_id: string, changes: Partial<Calendar>) => ({
      ...base,
      ...changes,
    }));
    const saved = await saveCalendarNotify(base, { notify: false }, update);
    expect(saved.notify).toBe(false);
    expect(update).toHaveBeenCalledWith(base.id, { notify: false });
  });

  it("古いサーバー (応答に notify が無い、または値が変わらない) は失敗にする", async () => {
    const { notify: _notify, ...old } = base;
    await expect(
      saveCalendarNotify(base, { notify: false }, async () => old),
    ).rejects.toBeInstanceOf(CalendarNotifyUnsupportedError);
    await expect(
      saveCalendarNotify(base, { notify: false }, async () => base),
    ).rejects.toBeInstanceOf(CalendarNotifyUnsupportedError);
  });

  it("控えが追い付くまで保存した値を重ねる", () => {
    const saved = { ...base, notify: false, updatedAt: "2026-11-27T10:00:01Z" };
    const listed = { ...base, updatedAt: "2026-11-27T10:00:00Z" };
    expect(overlayCalendar(listed, saved, undefined).notify).toBe(false);
    // 控えが同じか新しくなったら控えの値。
    expect(
      overlayCalendar(
        { ...base, notify: true, updatedAt: "2026-11-27T10:00:02Z" },
        saved,
        undefined,
      ).notify,
    ).toBe(true);
    // 保存中の値は一番上。
    expect(overlayCalendar(listed, undefined, { notify: false }).notify).toBe(
      false,
    );
  });
});
