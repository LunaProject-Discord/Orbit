import { Temporal } from "temporal-polyfill";
import type { InviteErrorCode, RsvpStatus } from "./event-invite.js";
import type { PlannedReminder } from "./reminders.js";

/**
 * 予定の通知 (段取り 9) で端末へ送る内容の型と文言。worker (Web Push・FCM)、API (SSE)、
 * 端末 (予約する通知の文言) が同じものを使う。
 * ブラウザーでも読むので、Node 専用の import を入れない (合言葉は event-notification-actions.ts)。
 * 設計は calendar-dev/notifications-design.md の 2 章、4.3、6.2、7 章、9 章。
 */

// ---------------------------------------------------------------------------
// 送る内容
// ---------------------------------------------------------------------------

export const CALENDAR_NOTIFICATION_KINDS = [
  "event-reminder",
  "event-invite",
  "event-update",
  "event-cancel",
  "event-invites-batch",
] as const;

export type CalendarNotificationKind =
  (typeof CALENDAR_NOTIFICATION_KINDS)[number];

export function isCalendarNotificationKind(
  value: unknown,
): value is CalendarNotificationKind {
  return (
    typeof value === "string" &&
    (CALENDAR_NOTIFICATION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * 端末に出す予定の通知 1 件。メールの PushMessage は変えず、受け取る側は kind の有無で見分ける。
 */
export type CalendarPushMessage = {
  kind: CalendarNotificationKind;
  title: string;
  body: string;
  /** 同じ値の通知は置き換わる (端末の予約と push が両方来ても 1 つにする)。 */
  tag: string;
  /** 押したときに開く予定。まとめた通知では null (カレンダーを開く)。 */
  eventId: string | null;
  recurrenceId?: string | null;
  /** 通知を消してよい時刻 (予定の終了、epoch ms)。 */
  expiresAt?: number;
  calendarId?: string;
  /** 出欠のボタン (招待だけ)。Desktop の SSE には付けない。 */
  rsvp?: { url: string; token: string };
};

/** SSE (API の EventsHub → 開いている画面) で送る予定の通知のイベント。 */
export type CalendarHubEvent = {
  type: "calendar";
  notifications: CalendarPushMessage[];
};

/** Android の通知の分類 (FCM の data.channel と、アプリが作る NotificationChannel の ID)。 */
export const CALENDAR_CHANNEL_REMINDERS = "calendar-reminders";
export const CALENDAR_CHANNEL_INVITES = "calendar-invites";
export type CalendarNotificationChannel =
  | typeof CALENDAR_CHANNEL_REMINDERS
  | typeof CALENDAR_CHANNEL_INVITES;

/** Android の通知の分類の名前と説明 (strings.xml と同じ文言)。 */
export const CALENDAR_CHANNEL_LABELS: Record<
  CalendarNotificationChannel,
  { name: string; description: string }
> = {
  [CALENDAR_CHANNEL_REMINDERS]: {
    name: "予定のリマインダー",
    description: "予定の前に知らせます",
  },
  [CALENDAR_CHANNEL_INVITES]: {
    name: "招待と予定の変更",
    description: "招待が届いたとき、招待された予定が変わったときに知らせます",
  },
};

/** Windows のトーストの Group (予定の通知はすべてこれ)。 */
export const CALENDAR_TOAST_GROUP = "calendar";

export function calendarNotificationChannel(
  kind: CalendarNotificationKind,
): CalendarNotificationChannel {
  return kind === "event-reminder"
    ? CALENDAR_CHANNEL_REMINDERS
    : CALENDAR_CHANNEL_INVITES;
}

// ---------------------------------------------------------------------------
// tag (リマインダーの tag は reminders.ts の reminderTag)
// ---------------------------------------------------------------------------

export const inviteTag = (eventId: string) => `cal-inv:${eventId}`;
/** 変更・取り消しの tag。招待の通知を置き換えない別の値 (取り消しは招待の通知も消す)。 */
export const updateTag = (eventId: string) => `cal-upd:${eventId}`;
/** まとめた招待の tag。届くたびに別の通知として出す。 */
export const inviteBatchTag = (calendarId: string, firstEventId: string) =>
  `cal-inv-batch:${calendarId}:${firstEventId}`;

/** 予定の通知の tag か (cal- で始まる)。メールの tag (mail:、mail-batch:) と見分ける。 */
export function isCalendarTag(tag: string): boolean {
  return tag.startsWith("cal-");
}

// ---------------------------------------------------------------------------
// 数値の決まり
// ---------------------------------------------------------------------------

/** 1 回の取り込みの招待のうち、1 件ずつ通知する数の上限。超えたら 1 件にまとめる。 */
export const MAX_SINGLE_INVITE_NOTIFICATIONS = 3;
/** 利用者ごとの、1 分に出す招待・変更の通知の上限。超えたらまとめの 1 件にする。 */
export const MAX_NOTICES_PER_MINUTE = 30;
/** event_notices の行を、予定の終了から残す日数。 */
export const EVENT_NOTICE_RETENTION_DAYS = 7;
/** 招待・変更の push の預かり時間 (秒)。 */
export const CALENDAR_NOTICE_TTL_SECONDS = 24 * 60 * 60;
/** リマインダーの push の預かり時間の下限と上限 (秒)。 */
export const REMINDER_TTL_MIN_SECONDS = 60;
export const REMINDER_TTL_MAX_SECONDS = 24 * 60 * 60;
/** 題名と場所、主催者の名前の長さの上限 (文字)。 */
export const MAX_EVENT_TITLE = 150;
export const MAX_EVENT_LOCATION = 80;
export const MAX_EVENT_PERSON = 80;

/**
 * push の預かり時間 (秒)。リマインダーは予定の終了まで (60 秒〜24 時間)。
 * 電源を入れ直した端末に昨日のリマインダーが出ないようにする。招待・変更は 24 時間。
 */
export function calendarPushTtlSeconds(
  message: Pick<CalendarPushMessage, "kind" | "expiresAt">,
  now: number,
): number {
  if (message.kind !== "event-reminder" || message.expiresAt === undefined) {
    return CALENDAR_NOTICE_TTL_SECONDS;
  }
  const seconds = Math.floor((message.expiresAt - now) / 1000);
  return Math.min(
    Math.max(seconds, REMINDER_TTL_MIN_SECONDS),
    REMINDER_TTL_MAX_SECONDS,
  );
}

/**
 * FCM の data (文字列だけ)。Android の OrbitMessagingService は data.kind が event- で始まれば
 * CalendarNotifications へ回す。項目が無いものは空文字にせず省く (eventId だけは空文字)。
 */
export function toCalendarFcmData(
  message: CalendarPushMessage,
): Record<string, string> {
  return {
    kind: message.kind,
    title: message.title,
    body: message.body,
    tag: message.tag,
    eventId: message.eventId ?? "",
    ...(message.recurrenceId ? { recurrenceId: message.recurrenceId } : {}),
    ...(message.expiresAt !== undefined
      ? { expiresAt: String(message.expiresAt) }
      : {}),
    ...(message.calendarId ? { calendarId: message.calendarId } : {}),
    channel: calendarNotificationChannel(message.kind),
    ...(message.rsvp
      ? { rsvpUrl: message.rsvp.url, rsvpToken: message.rsvp.token }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 通知からの出欠 (合言葉の計算は Node 専用の event-notification-actions.ts)
// ---------------------------------------------------------------------------

/** 通知からの出欠を受け付ける API のパス (/v1 より後ろ。ログイン無し)。 */
export const NOTIFICATION_EVENT_ACTION_PATH = "/notification-actions/event";

/** 通知に付ける出欠のボタン (Android・Windows は 3 つ。Chrome は先頭と末尾の 2 つ)。 */
export const RSVP_BUTTONS: readonly { id: RsvpStatus; title: string }[] = [
  { id: "accepted", title: "参加" },
  { id: "tentative", title: "未定" },
  { id: "declined", title: "不参加" },
];

/** POST /v1/notification-actions/event の本文。 */
export type EventNotificationActionRequest = {
  eventId: string;
  status: RsvpStatus;
  token: string;
  /** 押した時刻 (ISO 8601)。オフラインで溜めて後から送るとき。 */
  respondedAt?: string;
  /** 同じ要求の再送を 1 回として扱うための鍵。 */
  idempotencyKey?: string;
};

/**
 * POST /v1/notification-actions/event の失敗。404 = 予定が無い (済んだ扱い)、
 * 403 = 合言葉が違う・期限切れ、409 = 下の code。
 */
export type EventNotificationActionError = {
  error: string;
  code?: InviteErrorCode;
};

// ---------------------------------------------------------------------------
// 端末の登録と予約の報告 (API の本文)
// ---------------------------------------------------------------------------

/** devices.app。Android の Calendar アプリ (段取り 10) は calendar で登録する。 */
export const DEVICE_APPS = ["mail", "calendar"] as const;
export type DeviceApp = (typeof DEVICE_APPS)[number];

/** POST /v1/push/subscriptions に足す項目 (省略時 mail = true、calendar = false)。 */
export type PushSubscriptionFlags = { mail?: boolean; calendar?: boolean };

/** POST /v1/push/devices に足す項目 (省略時 app = mail、mail = true、calendar = false)。 */
export type DeviceRegistrationFlags = PushSubscriptionFlags & {
  app?: DeviceApp;
  /** 端末の ID (Web の deviceId())。 */
  installId?: string;
};

/** 端末が予約の範囲を報告する API のパス (/v1 より後ろ)。 */
export const PUSH_DEVICE_REMINDERS_PATH = "/push/devices/reminders";

/** POST /v1/push/devices/reminders の本文。 */
export type ReminderCoverReport = {
  token: string;
  /** ここまでの時刻 (epoch ms) の通知は端末が予約済み。サーバーは今 + 8 日に丸める。 */
  coverUntil: number;
  /** 予約を計算したときの端末の同期位置 (calMeta.cursor = changes.seq、10 進の文字列)。 */
  coverSeq: string;
  /** 正確なアラームで予約できている。false ならサーバーは push も送る。 */
  exact: boolean;
};

// ---------------------------------------------------------------------------
// 利用者ごとの設定 (user_settings.calendar_notifications)
// ---------------------------------------------------------------------------

export type CalendarNotificationDetail = "full" | "private";

export type CalendarNotificationSettings = {
  /** 新しい招待。 */
  invites: boolean;
  /** 招待された予定の変更と取り消し。 */
  changes: boolean;
  /** 自分が主催した予定への返事の到着 (9 では未使用。設計 13 章の 5)。 */
  replies: boolean;
  /** 終日の予定の通知。minutes は開始日の 0:00 の何分前か (負は当日)。null はオフ。 */
  allDay: { minutes: number } | null;
  /** 通知に予定の内容を出すか。private はサーバーの push の題名・本文を伏せる。 */
  detail: CalendarNotificationDetail;
};

export const DEFAULT_CALENDAR_NOTIFICATION_SETTINGS: CalendarNotificationSettings =
  {
    invites: true,
    changes: true,
    replies: false,
    allDay: { minutes: -540 },
    detail: "full",
  };

/** PUT /v1/settings/calendar-notifications の本文と、GET /v1/settings に足す項目。 */
export type CalendarNotificationSettingsBody = {
  calendarNotifications: CalendarNotificationSettings;
  /** 利用者のタイムゾーン (IANA 名)。null は未設定 (最初に開いた端末が保存する)。 */
  timeZone: string | null;
};

/** 保存してあった設定を読む。形の合わない項目は標準の値にする。 */
export function readCalendarNotificationSettings(
  saved: unknown,
): CalendarNotificationSettings {
  const record =
    typeof saved === "object" && saved !== null
      ? (saved as Record<string, unknown>)
      : {};
  const defaults = DEFAULT_CALENDAR_NOTIFICATION_SETTINGS;
  const flag = (key: "invites" | "changes" | "replies") =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : defaults[key];
  let allDay = defaults.allDay;
  if (record.allDay === null) {
    allDay = null;
  } else if (typeof record.allDay === "object" && record.allDay !== null) {
    const minutes = (record.allDay as { minutes?: unknown }).minutes;
    if (typeof minutes === "number" && Number.isInteger(minutes)) {
      allDay = { minutes };
    }
  }
  return {
    invites: flag("invites"),
    changes: flag("changes"),
    replies: flag("replies"),
    allDay,
    detail:
      record.detail === "private" || record.detail === "full"
        ? record.detail
        : defaults.detail,
  };
}

// ---------------------------------------------------------------------------
// 招待・変更・取り消しの「知らせた内容」(event_notices)
// ---------------------------------------------------------------------------

export type EventNoticeKind = "invite" | "update" | "cancel";

/** event_notices.snapshot。予定の行が消えても題名と日時を出せるようにする。 */
export type EventNoticeSnapshot = {
  title: string | null;
  location: string | null;
  /** 主催者の表示名 (無ければメールアドレス)。 */
  organizer: string | null;
  sequence: number;
  /** 繰り返しの規則。変わったら日時の変更として扱う。 */
  rrule?: string | null;
  /** 浮動時刻と終日の表示に使うタイムゾーン。 */
  timeZone: string | null;
} & (
  | { allDay: false; startAt: string; endAt: string }
  | { allDay: true; startDate: string; endDate: string }
);

/** 前に知らせた内容から、日時と場所が変わったか (設計 2.3)。 */
export function eventNoticeChanges(
  previous: EventNoticeSnapshot,
  next: EventNoticeSnapshot,
): { when: boolean; location: boolean } {
  let when = previous.allDay !== next.allDay;
  if (!when) {
    when =
      previous.allDay && next.allDay
        ? previous.startDate !== next.startDate ||
          previous.endDate !== next.endDate
        : !previous.allDay &&
          !next.allDay &&
          (instantMs(previous.startAt) !== instantMs(next.startAt) ||
            instantMs(previous.endAt) !== instantMs(next.endAt));
  }
  if ((previous.rrule ?? null) !== (next.rrule ?? null)) when = true;
  const location =
    (previous.location ?? "").trim() !== (next.location ?? "").trim();
  return { when, location };
}

function instantMs(value: string): number {
  try {
    return Temporal.Instant.from(value).epochMilliseconds;
  } catch {
    return Number.NaN;
  }
}

// ---------------------------------------------------------------------------
// 文言 (設計 9 章)
// ---------------------------------------------------------------------------

/** 制御文字を空白にし、空白を詰め、長さを切る (招待は他人が送り込めるため)。 */
export function cleanNotificationText(
  text: string | null | undefined,
  max: number,
): string {
  const clean = (text ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を落とす
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

const UNTITLED = "(タイトルなし)";
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

/**
 * 日付と時刻の書き方。端末は利用者の設定 (dateFormat) に合わせたものを渡せる。
 * 省くと「11月28日(土)」「10:00」。
 */
export type CalendarTextFormat = {
  date(date: Temporal.PlainDate): string;
  time(time: Temporal.PlainTime): string;
};

export const DEFAULT_CALENDAR_TEXT_FORMAT: CalendarTextFormat = {
  date: (date) =>
    `${date.month}月${date.day}日(${WEEKDAYS[date.dayOfWeek - 1]})`,
  time: (time) =>
    `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`,
};

export type CalendarTextOptions = {
  /** 表示に使うタイムゾーン (利用者のタイムゾーン)。 */
  timeZone: string;
  /** 「今日」を決める時刻 (epoch ms)。 */
  now: number;
  format?: CalendarTextFormat;
  /** private は題名と本文を伏せる。 */
  detail?: CalendarNotificationDetail;
};

/** 文言に使う日時。PlannedReminder と EventNoticeSnapshot のどちらも渡せる。 */
export type CalendarTextTiming =
  | { allDay: false; startAt: string; endAt: string }
  | { allDay: true; startDate: string; endDate: string };

/**
 * 日時の文言。今日なら時刻だけ、それ以外は日付付き。終日は「今日 (終日)」「明日 (終日)」
 * 「11月30日(月) (終日)」、複数日は「11月30日(月)〜12月2日(水)」。
 */
export function formatEventWhen(
  timing: CalendarTextTiming,
  options: CalendarTextOptions,
): string {
  const format = options.format ?? DEFAULT_CALENDAR_TEXT_FORMAT;
  const today = Temporal.Instant.fromEpochMilliseconds(options.now)
    .toZonedDateTimeISO(options.timeZone)
    .toPlainDate();
  if (timing.allDay) {
    const start = Temporal.PlainDate.from(timing.startDate);
    const endExclusive = Temporal.PlainDate.from(timing.endDate);
    const last =
      Temporal.PlainDate.compare(endExclusive, start) > 0
        ? endExclusive.subtract({ days: 1 })
        : start;
    if (Temporal.PlainDate.compare(last, start) > 0) {
      return `${format.date(start)}〜${format.date(last)}`;
    }
    if (start.equals(today)) return "今日 (終日)";
    if (start.equals(today.add({ days: 1 }))) return "明日 (終日)";
    return `${format.date(start)} (終日)`;
  }
  const start = Temporal.Instant.from(timing.startAt).toZonedDateTimeISO(
    options.timeZone,
  );
  const end = Temporal.Instant.from(timing.endAt).toZonedDateTimeISO(
    options.timeZone,
  );
  const startDate = start.toPlainDate();
  const startText = startDate.equals(today)
    ? format.time(start.toPlainTime())
    : `${format.date(startDate)} ${format.time(start.toPlainTime())}`;
  if (Temporal.ZonedDateTime.compare(end, start) <= 0) return startText;
  const endText = end.toPlainDate().equals(startDate)
    ? format.time(end.toPlainTime())
    : `${format.date(end.toPlainDate())} ${format.time(end.toPlainTime())}`;
  return `${startText}〜${endText}`;
}

/** 開始の文言 (「10:00」「11月28日(土) 10:00」。終日は formatEventWhen と同じ)。 */
function formatEventStart(
  timing: CalendarTextTiming,
  options: CalendarTextOptions,
): string {
  if (timing.allDay) return formatEventWhen(timing, options);
  return formatEventWhen(
    { allDay: false, startAt: timing.startAt, endAt: timing.startAt },
    options,
  );
}

export type NotificationText = { title: string; body: string };

/** リマインダーの文言。題名は予定の題名、本文は日時と場所。 */
export function reminderText(
  planned: CalendarTextTiming,
  event: { summary: string | null; location: string | null },
  options: CalendarTextOptions,
): NotificationText {
  if (options.detail === "private") {
    return {
      title: "予定のリマインダー",
      body: planned.allDay
        ? formatEventWhen(planned, options)
        : `${formatEventStart(planned, options)} から`,
    };
  }
  const location = cleanNotificationText(event.location, MAX_EVENT_LOCATION);
  return {
    title: cleanNotificationText(event.summary, MAX_EVENT_TITLE) || UNTITLED,
    body: `${formatEventWhen(planned, options)}${location ? ` · ${location}` : ""}`,
  };
}

/** リマインダーの通知 (サーバーの push と、端末の予約の両方で使う)。 */
export function toReminderMessage(
  planned: PlannedReminder,
  event: { summary: string | null; location: string | null },
  options: CalendarTextOptions,
): CalendarPushMessage {
  return {
    kind: "event-reminder",
    ...reminderText(planned, event, options),
    tag: planned.tag,
    eventId: planned.eventId,
    recurrenceId: planned.recurrenceId,
    expiresAt: planned.expiresAt,
    calendarId: planned.calendarId,
  };
}

/** 招待の文言。「招待: 定例会議」「山田 太郎 さんから · 11月28日(土) 10:00〜11:00」。 */
export function inviteText(
  snapshot: EventNoticeSnapshot,
  options: CalendarTextOptions,
): NotificationText {
  if (options.detail === "private") return { title: "新しい招待", body: "" };
  const title =
    cleanNotificationText(snapshot.title, MAX_EVENT_TITLE) || UNTITLED;
  const organizer = cleanNotificationText(snapshot.organizer, MAX_EVENT_PERSON);
  const when = formatEventWhen(snapshot, options);
  return {
    title: `招待: ${title}`,
    body: organizer ? `${organizer} さんから · ${when}` : when,
  };
}

/** まとめた招待の文言。「新しい招待 4 件」「山田 太郎、佐藤 花子 ほか」。 */
export function inviteBatchText(
  organizers: readonly (string | null)[],
  count: number,
  options: Pick<CalendarTextOptions, "detail">,
): NotificationText {
  const title = `新しい招待 ${count} 件`;
  if (options.detail === "private") return { title, body: "" };
  const names = [
    ...new Set(
      organizers
        .map((name) => cleanNotificationText(name, MAX_EVENT_PERSON))
        .filter(Boolean),
    ),
  ];
  const shown = names.slice(0, 3);
  const more = names.length > shown.length || count > organizers.length;
  return {
    title,
    body: shown.length > 0 ? `${shown.join("、")}${more ? " ほか" : ""}` : "",
  };
}

/** 変更の文言。日時だけ・場所だけ・両方で本文を変える。 */
export function updateText(
  previous: EventNoticeSnapshot,
  next: EventNoticeSnapshot,
  options: CalendarTextOptions,
): NotificationText {
  if (options.detail === "private") return { title: "予定の変更", body: "" };
  const title = `変更: ${cleanNotificationText(next.title, MAX_EVENT_TITLE) || UNTITLED}`;
  const changes = eventNoticeChanges(previous, next);
  const when = formatEventWhen(next, options);
  const location =
    cleanNotificationText(next.location, MAX_EVENT_LOCATION) || "(なし)";
  if (changes.when && changes.location) {
    return { title, body: `${when} · ${location} になりました` };
  }
  if (changes.location)
    return { title, body: `場所が ${location} になりました` };
  return { title, body: `日時が ${when} になりました` };
}

/** 取り消しの文言。 */
export function cancelText(
  snapshot: EventNoticeSnapshot,
  options: CalendarTextOptions,
): NotificationText {
  if (options.detail === "private") return { title: "予定の変更", body: "" };
  return {
    title: `取り消し: ${cleanNotificationText(snapshot.title, MAX_EVENT_TITLE) || UNTITLED}`,
    body: `${formatEventWhen(snapshot, options)} の予定は取り消されました`,
  };
}

/** 通知からの出欠が失敗したときの文言。 */
export function rsvpFailedText(title: string | null): NotificationText {
  return {
    title: "出欠を反映できませんでした",
    body: cleanNotificationText(title, MAX_EVENT_TITLE) || UNTITLED,
  };
}
