import type { RsvpStatus } from "@orbit/core/event-invite";

/**
 * 予定のリマインダーを端末に予約する「橋」の約束 (段取り 9、設計 3.2・3.5・8 章)。
 * 予約の計算 (planReminders) と文言は TypeScript (ReminderAgent) に 1 つだけ置き、
 * OS ごとの差はこの型の実装 (橋) に閉じ込める。このファイルは型と名前だけを持つ。
 *
 * 橋の実装と、D1 の notifications/index.ts が動的 import する名前:
 * - Web: `./web-bridge` の `createWebReminderBridge(registration)` (D1)
 * - Desktop: `@/lib/desktop/reminders` の `createDesktopReminderBridge()` (E)
 * - Android: `@/lib/native/reminders` の `createNativeReminderBridge()` (F)
 */

/** OS に予約する通知 1 件。 */
export type ScheduledReminder = {
  /** cal-rem:<masterId>:<recurrenceId または "-">:<minutes> (@orbit/core/reminders の reminderTag)。 */
  tag: string;
  /** 鳴らす時刻 (epoch ms)。 */
  fireAt: number;
  /** 予定の終了。過ぎたら通知を消してよい (epoch ms)。 */
  expiresAt: number;
  /** 出す文言まで TypeScript で作る (OS 側は表示するだけ)。 */
  title: string;
  body: string;
  /** 押したときに開く予定 (回の中身を持つ行)。 */
  eventId: string;
  recurrenceId: string | null;
};

/**
 * 予約の能力。
 * - os: アプリを終了しても鳴る (Android の AlarmManager、Windows の予約トースト)
 * - process: 起動中だけ (macOS・Linux の Rust 側のタイマー、Web の page)
 * - none: 予約できない (push が有効な Web はこれ。Agent を動かさない)
 * exact は正確な時刻に鳴るか (Android で正確なアラームが使えないと false)。
 */
export type ReminderCapabilities = {
  schedule: "os" | "process" | "none";
  exact: boolean;
};

export interface ReminderBridge {
  capabilities(): Promise<ReminderCapabilities>;
  /** 毎回「全部の一覧」を渡す。今ある予約との差分は橋の側で取る。 */
  replaceAll(items: ScheduledReminder[]): Promise<void>;
  /** すべての予約を消す。ログアウト・利用者の切り替え・401 で必ず呼ぶ。 */
  clear(): Promise<void>;
}

/** 橋を作る関数 (各実装のファイルが上の名前で export する)。 */
export type ReminderBridgeFactory = () => ReminderBridge;

/** 端末ごとの予定の通知のオン・オフ (localStorage)。未設定は mail.notifications と同じ。 */
export const CALENDAR_NOTIFICATIONS_STORAGE_KEY = "calendar.notifications";

// ---------------------------------------------------------------------------
// サービスワーカー (D1、public/sw.js)
// ---------------------------------------------------------------------------

/** サービスワーカー → 開いている画面: 予定を開いてほしい。 */
export type OpenEventMessage = {
  type: "open-event";
  eventId: string;
  recurrenceId: string | null;
};

/** Web Push の通知の data (sw.js の showNotification に渡す)。 */
export type CalendarNotificationData = {
  kind: string;
  eventId: string | null;
  recurrenceId: string | null;
  /** 出欠のボタンの送り先と合言葉 (招待だけ)。 */
  action?: { url: string; token: string };
};

// ---------------------------------------------------------------------------
// Desktop (E、apps/desktop/src-tauri)
// ---------------------------------------------------------------------------

/** Tauri のコマンド名。 */
export const DESKTOP_REMINDER_COMMANDS = {
  /** 引数 { items: ScheduledReminder[] }。 */
  schedule: "schedule_reminders",
  clear: "clear_reminders",
  /** 戻り値 ReminderCapabilities。 */
  capabilities: "reminder_capabilities",
  /** 招待・変更の通知。引数 { notification: DesktopCalendarNotification }。 */
  notify: "notify_calendar",
} as const;

/** Rust → 画面のイベント名。 */
export const DESKTOP_CALENDAR_EVENTS = {
  /** 通知を押した (payload OpenEventPayload)。 */
  openEvent: "desktop://open-event",
  /** Windows のトーストの出欠ボタンを押した (payload CalendarActionPayload)。 */
  calendarAction: "desktop://calendar-action",
} as const;

/** notify_calendar に渡す通知 (CalendarPushMessage から rsvp を除き、ボタンの有無を足したもの)。 */
export type DesktopCalendarNotification = {
  kind: string;
  title: string;
  body: string;
  tag: string;
  eventId: string | null;
  recurrenceId: string | null;
  expiresAt: number | null;
  /** 参加 / 未定 / 不参加 のボタンを付ける (Windows だけ)。 */
  rsvp: boolean;
};

export type OpenEventPayload = { eventId: string; recurrenceId: string | null };
export type CalendarActionPayload = { eventId: string; status: RsvpStatus };

/** アプリ専用 URL で予定を開く形 (jp.lunaproject.orbit.mail://calendar/events/<id>?o=<回>)。 */
export const DESKTOP_EVENT_URL_PREFIX =
  "jp.lunaproject.orbit.mail://calendar/events/";

// ---------------------------------------------------------------------------
// Android (F、AppShellPlugin)
// ---------------------------------------------------------------------------

/** AppShell プラグインに足すメソッド名。 */
export const NATIVE_REMINDER_METHODS = {
  /** 引数 { items: ScheduledReminder[] }。 */
  schedule: "scheduleReminders",
  clear: "clearReminders",
  /** 戻り値 ReminderCapabilities。 */
  capabilities: "reminderCapabilities",
} as const;
