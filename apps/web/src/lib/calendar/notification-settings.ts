import {
  type CalendarNotificationSettings,
  type CalendarNotificationSettingsBody,
  DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
} from "@orbit/core/calendar-notifications";
import {
  allDayReminderMinutes,
  allDayReminderTime,
  clampReminderMinutes,
} from "@orbit/core/reminders";
import { useSyncExternalStore } from "react";
import {
  type Calendar,
  calendarNotifySupported,
  getCalendarNotificationSettings,
  type Reminder,
  saveCalendarNotificationSettings,
  updateCalendar,
} from "@/lib/calendar/api";
import { CALENDAR_NOTIFICATIONS_STORAGE_KEY } from "@/lib/calendar/notifications/bridge";
import { setCalendarNotificationsEnabled } from "@/lib/notifications";

/**
 * 予定の通知の画面側の決まり (段取り 9 の D2)。
 * - 終日の予定の通知の値 (minutes) と「何日前の何時何分」の変換と表示
 * - すべての端末で共通の設定 (サーバー) の保持
 * - 端末ごとのオン・オフ (localStorage の calendar.notifications)
 */

// ---------------------------------------------------------------------------
// 終日の予定の通知 (minutes ⇄ 日数 + 時刻)
// ---------------------------------------------------------------------------

/** 終日の予定の通知で選べる「何日前」(0 は当日)。 */
export const ALL_DAY_REMINDER_DAYS = [0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 28];
/** 終日の予定の通知を足したときの値 (当日 9:00)。 */
export const ALL_DAY_REMINDER_NEW = -540;

/**
 * 終日の予定の通知の値 (開始日の 0:00 の何分前。負は当日) を、範囲 (-1439〜28 日前) に
 * 丸めてから「何日前の何時何分」に直す (変換は @orbit/core/reminders)。
 */
export function allDayReminderParts(minutes: number): AllDayReminderTime {
  return allDayReminderTime(clampReminderMinutes(minutes, true) ?? 0);
}

/** 「何日前の何時何分」から値を作る。範囲の外は丸める。 */
export function allDayReminderValue(time: AllDayReminderTime): number {
  return clampReminderMinutes(allDayReminderMinutes(time), true) ?? 0;
}

export type AllDayReminderTime = ReturnType<typeof allDayReminderTime>;

/** 「当日」「1 日前」「1 週間前」。 */
export function allDayDaysLabel(days: number): string {
  if (days === 0) return "当日";
  if (days % 7 === 0) return `${days / 7} 週間前`;
  return `${days} 日前`;
}

/** 終日の予定の通知の時刻 (「当日 9:00」「1 日前 17:00」)。 */
export function allDayReminderText(minutes: number): string {
  const { daysBefore, hour, minute } = allDayReminderParts(minutes);
  return `${allDayDaysLabel(daysBefore)} ${hour}:${String(minute).padStart(2, "0")}`;
}

/** 終日の予定の通知の表示 (「当日 9:00 に通知」)。 */
export function allDayReminderLabel(reminder: Reminder): string {
  const text = allDayReminderText(reminder.minutes);
  return reminder.method === "email" ? `${text}にメール` : `${text}に通知`;
}

/** input type=time の値 (「09:00」) と時刻の変換。 */
export function timeInputValue(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export function parseTimeInput(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// すべての端末で共通の設定 (サーバー)
// ---------------------------------------------------------------------------

export type CalendarNotificationSettingsState =
  /** まだ取得していない、または取得中。 */
  | { status: "loading"; value: null }
  /** 取得できた。 */
  | { status: "ready"; value: CalendarNotificationSettingsBody }
  /** サーバーが予定の通知に対応していない (古いサーバー)。 */
  | { status: "unsupported"; value: null }
  /** 取得できなかった (オフラインなど)。 */
  | { status: "error"; value: null };

const LOADING: CalendarNotificationSettingsState = {
  status: "loading",
  value: null,
};

let state: CalendarNotificationSettingsState = LOADING;
let loading: Promise<void> | null = null;
let saving = 0;
const listeners = new Set<() => void>();

function setState(next: CalendarNotificationSettingsState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 予定の通知の設定。変わると、使っている部品を描き直す。 */
export function useCalendarNotificationSettings(): CalendarNotificationSettingsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => LOADING,
  );
}

/**
 * 設定が変わったら呼ぶ (予約の仕組み = notifications/index.ts が受けて組み直す)。
 * 戻り値の関数で解除する。
 */
export function onCalendarNotificationSettingsChange(
  listener: () => void,
): () => void {
  return subscribe(listener);
}

/** いまの設定 (部品の外から読むとき)。 */
export function currentCalendarNotificationSettings(): CalendarNotificationSettingsState {
  return state;
}

/**
 * サーバーから取得し直す。同時に呼ばれたら 1 回にまとめる。
 * force でなければ、取得済みのときは何もしない。
 */
export function refreshCalendarNotificationSettings(
  options: {
    force?: boolean;
    load?: () => Promise<CalendarNotificationSettingsBody | null>;
  } = {},
): Promise<void> {
  // 取得済み (古いサーバーと分かった場合を含む) なら、force でない限り取り直さない。
  if (
    !options.force &&
    (state.status === "ready" || state.status === "unsupported")
  ) {
    return Promise.resolve();
  }
  if (loading) return loading;
  const load = options.load ?? (() => getCalendarNotificationSettings());
  loading = load()
    .then((value) => {
      if (saving > 0) return;
      setState(
        value
          ? { status: "ready", value }
          : { status: "unsupported", value: null },
      );
    })
    .catch(() => {
      if (state.status !== "ready") setState({ status: "error", value: null });
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * 設定の一部を変える。画面にはすぐ反映し、保存できなければ元に戻す。保存できたかを返す。
 */
export async function changeCalendarNotificationSettings(
  patch: Partial<CalendarNotificationSettings> & { timeZone?: string | null },
  save: (
    body: CalendarNotificationSettingsBody,
  ) => Promise<void> = saveCalendarNotificationSettings,
): Promise<boolean> {
  if (state.status !== "ready") return false;
  const previous = state;
  const { timeZone, ...rest } = patch;
  const next: CalendarNotificationSettingsBody = {
    calendarNotifications: { ...previous.value.calendarNotifications, ...rest },
    timeZone: timeZone === undefined ? previous.value.timeZone : timeZone,
  };
  setState({ status: "ready", value: next });
  saving += 1;
  try {
    await save(next);
    return true;
  } catch {
    // 途中でほかの変更が入っていなければ元に戻す。
    if (state.status === "ready" && state.value === next) setState(previous);
    return false;
  } finally {
    saving -= 1;
  }
}

/** 終日の予定の既定 (取得前・古いサーバーでは標準の値)。 */
export function allDayDefault(
  settings: CalendarNotificationSettingsState,
): { minutes: number } | null {
  return settings.status === "ready"
    ? settings.value.calendarNotifications.allDay
    : DEFAULT_CALENDAR_NOTIFICATION_SETTINGS.allDay;
}

/** テスト用。 */
export function resetCalendarNotificationSettingsForTest(
  next: CalendarNotificationSettingsState = LOADING,
) {
  state = next;
  loading = null;
  saving = 0;
}

// ---------------------------------------------------------------------------
// カレンダーごとの通知
// ---------------------------------------------------------------------------

/** サーバーがカレンダーごとの通知に対応していないとき (応答に notify が無い)。 */
export class CalendarNotifyUnsupportedError extends Error {
  constructor() {
    super("calendar notify unsupported");
  }
}

/**
 * カレンダーの通知 (notify) か既定の通知 (defaultReminders) を保存し、保存後の
 * カレンダーを返す。古いサーバーは知らない項目を捨てるので、応答で確かめる。
 */
export async function saveCalendarNotify(
  calendar: Pick<Calendar, "id">,
  changes: { notify?: boolean; defaultReminders?: Reminder[] },
  update: typeof updateCalendar = updateCalendar,
): Promise<Calendar> {
  const saved = await update(calendar.id, changes);
  if (!calendarNotifySupported(saved)) {
    throw new CalendarNotifyUnsupportedError();
  }
  if (changes.notify !== undefined && saved.notify !== changes.notify) {
    throw new CalendarNotifyUnsupportedError();
  }
  return saved;
}

/**
 * 保存したばかりの値を、同期で控えが追い付くまで画面に出すための重ね合わせ。
 * 控えの updatedAt が保存の応答と同じか新しくなったら、控えの値を使う。
 */
export function overlayCalendar(
  calendar: Calendar,
  saved: Calendar | undefined,
  pending: Partial<Calendar> | undefined,
): Calendar {
  const base =
    saved && saved.updatedAt > calendar.updatedAt
      ? { ...calendar, ...saved }
      : calendar;
  return pending ? { ...base, ...pending } : base;
}

// ---------------------------------------------------------------------------
// 端末ごとのオン・オフ (localStorage)
// ---------------------------------------------------------------------------

/** 保存した値から決める。未設定はメールの通知と同じ (設計 3.4、13 章の 14 推奨 A)。 */
export function deviceCalendarEnabledFrom(
  stored: string | null,
  mailEnabled: boolean,
): boolean {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return mailEnabled;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(CALENDAR_NOTIFICATIONS_STORAGE_KEY);
  } catch {
    return null;
  }
}

const deviceListeners = new Set<() => void>();

function subscribeDevice(listener: () => void) {
  deviceListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === CALENDAR_NOTIFICATIONS_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    deviceListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** この端末に保存した値 ("on" / "off" / 未設定 null)。変わると描き直す。 */
export function useStoredDeviceCalendarNotifications(): string | null {
  return useSyncExternalStore(subscribeDevice, readStored, () => null);
}

/**
 * この端末の予定の通知を切り替える。保存と、送り先の登録 (calendar の旗) の組み直しは
 * lib/notifications.ts の setCalendarNotificationsEnabled が行い、予約 (ReminderAgent) は
 * onCalendarNotificationsChange で組み直される。ここでは画面の描き直しだけを足す。
 */
export function setDeviceCalendarNotifications(enabled: boolean) {
  void setCalendarNotificationsEnabled(enabled).finally(() => {
    for (const listener of deviceListeners) listener();
  });
  for (const listener of deviceListeners) listener();
}
