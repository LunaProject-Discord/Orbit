import { Temporal } from "temporal-polyfill";
import {
  type EventTiming,
  expandOccurrences,
  instantRecurrenceId,
  type RecurrenceException,
} from "./recurrence.js";

/**
 * 予定のリマインダー (段取り 9) の共通の計算。サーバー (worker が push の job を作る) と
 * 端末 (Desktop・Android が OS に予約する) が同じ関数を使うので、tag と鳴らす時刻が必ず一致する。
 * ブラウザーでも読むので、Node 専用の import を入れない (読むのは recurrence.ts と Temporal だけ)。
 * 設計は calendar-dev/notifications-design.md の 2.1、3.2、3.3、5 章。
 */

// ---------------------------------------------------------------------------
// 数値の決まり (設計 13 章の 12)
// ---------------------------------------------------------------------------

/** リマインダーの分の上限 (28 日前)。これより大きい値は丸める。 */
export const REMINDER_MAX_MINUTES = 28 * 24 * 60;
/**
 * 終日の予定のリマインダーの分の下限 (当日 23:59 まで)。終日の予定の minutes は「開始日の 0:00
 * (壁時計) から何分前か」で、負は当日 0:00 より後 (当日 9:00 = -540)。利用者ごとの既定と
 * 予定ごとの両方に使える (設計 13 章の 1 を B に変更、2026-11-27)。
 */
export const ALL_DAY_MIN_MINUTES = -(24 * 60 - 1);
/** 鳴らす時刻をこれより過ぎて見つけた通知は鳴らさない (遅れた通知)。 */
export const REMINDER_LATE_LIMIT_MS = 15 * 60_000;
/** 端末が予約する窓 (今から 7 日先まで)。 */
export const DEVICE_REMINDER_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** 端末が予約する件数の上限 (早い順)。 */
export const DEVICE_REMINDER_LIMIT = 64;
/** 端末の予約を組み直すまとめの時間。 */
export const DEVICE_REMINDER_DEBOUNCE_MS = 500;
/** 端末が窓を進めるために組み直す間隔。 */
export const DEVICE_REMINDER_REFRESH_MS = 6 * 60 * 60_000;
/** 端末がサーバーへ予約の範囲を報告する間隔の下限 (1 分に 1 回まで)。 */
export const REMINDER_COVER_REPORT_MIN_INTERVAL_MS = 60_000;
/** サーバーが受け付ける coverUntil の上限 (今 + 8 日)。 */
export const REMINDER_COVER_MAX_MS = 8 * 24 * 60 * 60_000;
/** サーバーが繰り返しの回を event_occurrences に展開しておく日数 (今日 + 35 日)。 */
export const SERVER_OCCURRENCE_WINDOW_DAYS = 35;
/** 終了がこれより前の回は event_occurrences から消す (今 − 1 日)。 */
export const SERVER_OCCURRENCE_KEEP_MS = 24 * 60 * 60_000;
/** サーバーが送る時刻を確かめる間隔。 */
export const REMINDER_DISPATCH_INTERVAL_MS = 30_000;
/** ReminderIndexer が changes を確かめ直す間隔。 */
export const REMINDER_INDEXER_POLL_MS = 60_000;
/** ReminderIndexer が「位置より後」に重ねて読む直近の範囲 (seq とコミットの順のずれに備える)。 */
export const REMINDER_INDEXER_OVERLAP_MS = 2 * 60_000;
/** ReminderIndexer の読んだ位置を持つ worker_cursors の名前。 */
export const REMINDER_INDEXER_CURSOR = "reminder-indexer";
/** 浮動時刻の予定と利用者のタイムゾーンが分からないときの既定。 */
export const DEFAULT_REMINDER_TIME_ZONE = "Asia/Tokyo";
/**
 * 通知を消してよい時刻の、開始からの最短の長さ。長さ 0 の予定 (締め切りなど) の通知が、
 * 出た瞬間に消えないようにする。
 */
export const MIN_REMINDER_LIFETIME_MS = 15 * 60_000;

/**
 * 終日の予定の、予定ごとの選択肢 (当日 9:00 / 前日 9:00 / 前日 17:00 / 2 日前 9:00 /
 * 1 週間前 9:00)。「当日 9:00」は負の分 (-540)。画面は、これ以外の値 (-1439〜) も
 * allDayReminderTime で「何日前の何時」として出せる。
 */
export const ALL_DAY_REMINDER_MINUTES = [-540, 900, 420, 2340, 9540] as const;
/** 終日の予定の、利用者ごとの既定の選択肢 (null = オフ、当日 9:00、前日 9:00、前日 17:00)。 */
export const ALL_DAY_DEFAULT_CHOICES = [null, -540, 900, 420] as const;
/** 終日の予定の、利用者ごとの既定の標準 (当日 9:00)。 */
export const DEFAULT_ALL_DAY_REMINDER = { minutes: -540 } as const;

// ---------------------------------------------------------------------------
// 入力と出力の型
// ---------------------------------------------------------------------------

/** リマインダー 1 つ (calendars.defaultReminders、event_reminders と同じ形)。 */
export type ReminderRule = { method: string; minutes: number };

/** 計算に使うカレンダーの項目。 */
export type ReminderCalendar = {
  id: string;
  /** 通知が効くか (calendarNotifies で決めた実際の値)。 */
  notify: boolean;
  visible: boolean;
  defaultReminders: readonly ReminderRule[] | null;
  /** 浮動時刻の予定を展開するタイムゾーン。null は settings.timeZone。 */
  timeZone: string | null;
};

/** 出欠の状態 (event_attendees.status)。 */
export type ReminderResponse =
  | "needs_action"
  | "accepted"
  | "declined"
  | "tentative"
  | "delegated";

/**
 * 計算に使う予定の項目 (原本・繰り返さない予定・例外)。サーバーの行 (Date) と
 * 端末の控え (ISO 8601 の文字列) のどちらも渡せる。
 */
export type ReminderEvent = {
  id: string;
  calendarId: string;
  /** 例外の原本。原本と繰り返さない予定は null。 */
  parentId: string | null;
  recurrenceId: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  allDay: boolean;
  startAt: string | Date | null;
  endAt: string | Date | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  rrule: string | null;
  rdates?: readonly string[] | null;
  exdates?: readonly string[] | null;
  useDefaultReminders: boolean;
  reminders: readonly ReminderRule[];
  /**
   * 自分の出欠 (self の参加者の status。selfResponse で求める)。参加者でなければ null。
   * 例外で null のときは原本の値を使う。
   */
  myResponse?: ReminderResponse | string | null;
};

/** 利用者ごとの設定のうち、計算に使うもの。 */
export type ReminderSettings = {
  /** 終日の予定の「開始日の 0:00」を決めるタイムゾーン。サーバーは user_settings、端末は端末の今の値。 */
  timeZone: string;
  /** 終日の予定の既定の通知 (calendar_notifications.allDay)。null はオフ。 */
  allDay: { minutes: number } | null;
};

export type PlanRemindersInput = {
  calendars: readonly ReminderCalendar[];
  events: readonly ReminderEvent[];
  settings: ReminderSettings;
  /** 鳴らす時刻の範囲 (epoch ms)。from 以上 to 未満。 */
  from: number;
  to: number;
};

/** 鳴らす通知 1 件。 */
export type PlannedReminder = {
  /** cal-rem:<masterId>:<recurrenceId または "-">:<minutes>。 */
  tag: string;
  /** 繰り返しの原本 (繰り返さない予定はその予定、親の無い例外は parentId)。 */
  masterId: string;
  /** 回の中身を持つ予定 (例外があれば例外、無ければ原本)。押したときに開く。 */
  eventId: string;
  calendarId: string;
  /** 繰り返しの回なら元の回の開始 (recurrence.ts の書き方)、繰り返さない予定は null。 */
  recurrenceId: string | null;
  minutes: number;
  /** 鳴らす時刻 (epoch ms)。 */
  fireAt: number;
  /** 通知を消してよい時刻 (予定の終了、epoch ms)。 */
  expiresAt: number;
} & (
  | { allDay: false; startAt: string; endAt: string }
  | { allDay: true; startDate: string; endDate: string }
);

// ---------------------------------------------------------------------------
// 分の範囲 (終日は負を許す)
// ---------------------------------------------------------------------------

/** リマインダーの分の下限。終日は -1439 (当日 23:59)、終日以外は 0 (開始の時刻)。 */
export function reminderMinMinutes(allDay: boolean): number {
  return allDay ? ALL_DAY_MIN_MINUTES : 0;
}

/**
 * リマインダーの分を、予定の種類ごとの範囲に丸める (整数にし、下限〜28 日前)。
 * 終日以外の負の分は 0 にする。数でなければ null。
 */
export function clampReminderMinutes(
  minutes: number,
  allDay: boolean,
): number | null {
  if (!Number.isFinite(minutes)) return null;
  return Math.min(
    Math.max(Math.round(minutes), reminderMinMinutes(allDay)),
    REMINDER_MAX_MINUTES,
  );
}

/**
 * 終日の予定の minutes を「開始日の何日前の何時何分」(壁時計) に直す。daysBefore = 0 は当日、
 * 1 は前日。例: -540 → { daysBefore: 0, hour: 9, minute: 0 }、900 → { 1, 9, 0 }。
 */
export function allDayReminderTime(minutes: number): {
  daysBefore: number;
  hour: number;
  minute: number;
} {
  const rounded = Math.round(minutes);
  const daysBefore = Math.max(0, Math.ceil(rounded / (24 * 60)));
  const ofDay = daysBefore * 24 * 60 - rounded;
  return {
    daysBefore,
    hour: Math.floor(ofDay / 60),
    minute: ofDay % 60,
  };
}

/** allDayReminderTime の逆。「開始日の daysBefore 日前の hour:minute」を minutes にする。 */
export function allDayReminderMinutes(time: {
  daysBefore: number;
  hour: number;
  minute: number;
}): number {
  return time.daysBefore * 24 * 60 - (time.hour * 60 + time.minute);
}

/**
 * 負の分 (終日の予定の当日 0:00 より後) を書けないプロバイダ (Google、Microsoft) へ書く
 * リマインダー。負の分を除く。除いた分は Orbit の中だけの通知になる。
 */
export function nonNegativeReminders<T extends { minutes: number }>(
  reminders: readonly T[],
): T[] {
  return reminders.filter((reminder) => reminder.minutes >= 0);
}

/** Orbit の中だけの通知 (負の分。Google・Microsoft には書けない)。 */
export function negativeReminders<T extends { minutes: number }>(
  reminders: readonly T[],
): T[] {
  return reminders.filter((reminder) => reminder.minutes < 0);
}

// ---------------------------------------------------------------------------
// 小さな決まり
// ---------------------------------------------------------------------------

/** 通知を既定でオフにするカレンダーの種類 (購読・祝日・誕生日)。 */
const QUIET_SOURCES = new Set(["ics", "holidays", "birthdays"]);

/** カレンダーの種類ごとの、通知の既定 (calendars.notify が null のときの値)。 */
export function calendarNotifyDefault(source: string): boolean {
  return !QUIET_SOURCES.has(source);
}

/** カレンダーの通知が効くか。calendars.notify が null なら種類ごとの既定。 */
export function calendarNotifies(calendar: {
  source: string;
  notify: boolean | null | undefined;
}): boolean {
  return typeof calendar.notify === "boolean"
    ? calendar.notify
    : calendarNotifyDefault(calendar.source);
}

/**
 * カレンダーの、通知に関わる値をつないだ文字列 (calendars.reminders_hash に入れる)。
 * 同期のたびに記録される calendar の変更のうち、これが変わったものだけ作り直す。
 */
export function calendarRemindersFingerprint(calendar: {
  notify: boolean;
  visible: boolean;
  defaultReminders: readonly ReminderRule[] | null;
  timeZone: string | null;
}): string {
  return JSON.stringify([
    calendar.notify,
    calendar.visible,
    (calendar.defaultReminders ?? []).map((rule) => [
      rule.method,
      rule.minutes,
    ]),
    calendar.timeZone ?? null,
  ]);
}

/** 参加者の一覧から自分の出欠を取り出す。自分が参加者でなければ null。 */
export function selfResponse(
  attendees: readonly { self: boolean; status: string }[] | null | undefined,
): string | null {
  return attendees?.find((attendee) => attendee.self)?.status ?? null;
}

/** リマインダーの tag。同じ通知には、どこで作っても同じ値を付ける。 */
export function reminderTag(
  masterId: string,
  recurrenceId: string | null,
  minutes: number,
): string {
  return `cal-rem:${masterId}:${recurrenceId ?? "-"}:${minutes}`;
}

/** reminderTag を読む。形が違えば null。recurrenceId は ":" を含みうるので、前後から切る。 */
export function parseReminderTag(tag: string): {
  masterId: string;
  recurrenceId: string | null;
  minutes: number;
} | null {
  if (!tag.startsWith("cal-rem:")) return null;
  const rest = tag.slice("cal-rem:".length);
  const first = rest.indexOf(":");
  const last = rest.lastIndexOf(":");
  if (first <= 0 || last <= first) return null;
  const minutes = Number(rest.slice(last + 1));
  const recurrenceId = rest.slice(first + 1, last);
  if (!Number.isInteger(minutes) || !recurrenceId) return null;
  return {
    masterId: rest.slice(0, first),
    recurrenceId: recurrenceId === "-" ? null : recurrenceId,
    minutes,
  };
}

/** 鳴らす時刻を過ぎすぎていて、もう鳴らさない通知か (15 分の決まり)。 */
export function isReminderLate(fireAt: number, now: number): boolean {
  return now - fireAt > REMINDER_LATE_LIMIT_MS;
}

/** 端末が報告した coverUntil を、サーバーが受け付ける範囲 (今 + 8 日まで) に丸める。 */
export function clampReminderCoverUntil(
  coverUntil: number,
  now: number,
): number {
  return Math.min(coverUntil, now + REMINDER_COVER_MAX_MS);
}

/** 端末の予約の状態 (devices.reminder_cover_until、reminder_cover_seq、exact_alarms)。 */
export type ReminderCover = {
  coverUntil: number | Date | null;
  coverSeq: bigint | string | number | null;
  exact: boolean;
};

const toMs = (value: number | Date) =>
  typeof value === "number" ? value : value.getTime();

function toBigInt(value: bigint | string | number): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * その端末が自分でこの通知を鳴らすので、サーバーの push を省いてよいか (設計 3.3 の 2)。
 * coverUntil >= fireAt かつ coverSeq >= changeSeq かつ exact のときだけ true。
 */
export function deviceCoversReminder(
  cover: ReminderCover | null | undefined,
  job: { fireAt: number | Date; changeSeq: bigint | string | number },
): boolean {
  if (!cover?.exact || cover.coverUntil == null || cover.coverSeq == null) {
    return false;
  }
  if (toMs(cover.coverUntil) < toMs(job.fireAt)) return false;
  const coverSeq = toBigInt(cover.coverSeq);
  const changeSeq = toBigInt(job.changeSeq);
  return coverSeq !== null && changeSeq !== null && coverSeq >= changeSeq;
}

/**
 * 端末が予約する分を選ぶ。早い順に limit 件まで。収まらなければ、入らなかった最初の通知の
 * 直前までを「予約済み」(coverUntil) とする。収まれば to まで。
 */
export function selectDeviceReminders(
  planned: readonly PlannedReminder[],
  options: { to: number; limit?: number },
): { reminders: PlannedReminder[]; coverUntil: number } {
  const limit = options.limit ?? DEVICE_REMINDER_LIMIT;
  const sorted = [...planned].sort(comparePlanned);
  if (sorted.length <= limit) {
    return { reminders: sorted, coverUntil: options.to };
  }
  const reminders = sorted.slice(0, limit);
  const firstLeft = sorted[limit] as PlannedReminder;
  // 同じ時刻の通知が溢れたときは、その時刻を「予約済み」に含めない。
  const coverUntil = firstLeft.fireAt - 1;
  return {
    reminders: reminders.filter((item) => item.fireAt <= coverUntil),
    coverUntil,
  };
}

function comparePlanned(a: PlannedReminder, b: PlannedReminder): number {
  return a.fireAt - b.fireAt || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
}

/**
 * 予定ごと・カレンダーの既定のリマインダーの分 (表示するものだけ)。終日は -1439〜28 日、
 * 終日以外は 0〜28 日に丸める。
 */
function displayMinutes(
  rules: readonly ReminderRule[] | null,
  allDay: boolean,
): number[] {
  const result = new Set<number>();
  for (const rule of rules ?? []) {
    if (rule.method !== "display") continue;
    const minutes = clampReminderMinutes(rule.minutes, allDay);
    if (minutes !== null) result.add(minutes);
  }
  return [...result];
}

function allDayDefaultMinutes(settings: ReminderSettings): number[] {
  const minutes = settings.allDay?.minutes;
  if (typeof minutes !== "number") return [];
  const clamped = clampReminderMinutes(minutes, true);
  return clamped === null ? [] : [clamped];
}

const isoOf = (value: string | Date) =>
  typeof value === "string" ? value : value.toISOString();

/** 予定の時刻を recurrence.ts の形にする。必要な項目が欠けていれば null。 */
function timingOf(event: ReminderEvent): EventTiming | null {
  if (event.allDay) {
    if (!event.startDate) return null;
    const endDate =
      event.endDate && event.endDate > event.startDate
        ? event.endDate
        : Temporal.PlainDate.from(event.startDate).add({ days: 1 }).toString();
    return { allDay: true, startDate: event.startDate, endDate };
  }
  if (!event.startAt) return null;
  const startAt = isoOf(event.startAt);
  return {
    allDay: false,
    startAt,
    endAt: event.endAt ? isoOf(event.endAt) : startAt,
    startTimeZone: event.startTimeZone,
  };
}

const dayStart = (date: string, timeZone: string) =>
  Temporal.PlainDate.from(date).toZonedDateTime({ timeZone });

/**
 * 鳴らす通知を、鳴らす時刻の早い順に返す (設計 2.1、5.1)。
 * - 時刻のある予定: 回の開始 − minutes 分 (経過時間)。
 * - 終日の予定: 開始日の 0:00 (settings.timeZone) から minutes 分前の壁時計の時刻。
 *   負の分は 0:00 より後 (-540 = 当日 9:00、下限 -1439)。予定ごとの値も負を使える。
 *   カレンダーの既定は使わず、useDefaultReminders なら settings.allDay を使う。
 * - 時刻のある予定の負の分は 0 (開始の時刻) に丸める。
 * - 鳴らさない: 通知オフ・非表示のカレンダー、取り消した予定と回、自分が不参加、
 *   予定の終了より後の時刻、method が display でないもの。
 */
export function planReminders(input: PlanRemindersInput): PlannedReminder[] {
  const { settings, from, to } = input;
  if (!(to > from)) return [];
  const calendars = new Map(input.calendars.map((c) => [c.id, c]));
  const ids = new Set(input.events.map((event) => event.id));
  const masters: ReminderEvent[] = [];
  const exceptions = new Map<string, ReminderEvent[]>();
  for (const event of input.events) {
    if (event.parentId && ids.has(event.parentId)) {
      const list = exceptions.get(event.parentId) ?? [];
      list.push(event);
      exceptions.set(event.parentId, list);
    } else {
      masters.push(event);
    }
  }

  // 展開の範囲。終日の負の分 (当日 9:00) と 28 日前の通知を拾えるよう、前後に余裕を取る。
  const day = 24 * 60 * 60_000;
  const range = {
    from: Temporal.Instant.fromEpochMilliseconds(from - 2 * day)
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .toString(),
    to: Temporal.Instant.fromEpochMilliseconds(
      to + REMINDER_MAX_MINUTES * 60_000 + 2 * day,
    )
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .toString(),
    timeZone: "UTC",
  };

  const result = new Map<string, PlannedReminder>();
  for (const master of masters) {
    const calendar = calendars.get(master.calendarId);
    if (!calendar || !calendar.notify || !calendar.visible) continue;
    if (master.status === "cancelled") continue;
    const timing = timingOf(master);
    if (!timing) continue;
    // 親の無い例外は、原本の ID と元の回で tag を作る (原本がある端末と同じ値にする)。
    const orphan = master.parentId !== null;
    const masterId = master.parentId ?? master.id;
    const children: RecurrenceException<ReminderEvent>[] = [];
    for (const child of exceptions.get(master.id) ?? []) {
      const childTiming = timingOf(child);
      if (!childTiming || !child.recurrenceId) continue;
      children.push({
        ...childTiming,
        key: child,
        recurrenceId: child.recurrenceId,
        cancelled: child.status === "cancelled",
      });
    }
    const occurrences = orphan
      ? expandOccurrences<ReminderEvent>(
          { ...timing, rrule: null },
          [],
          range,
          {
            defaultTimeZone: calendar.timeZone ?? settings.timeZone,
          },
        )
      : expandOccurrences<ReminderEvent>(
          {
            ...timing,
            rrule: master.rrule,
            rdates: master.rdates ?? null,
            exdates: master.exdates ?? null,
          },
          children,
          range,
          { defaultTimeZone: calendar.timeZone ?? settings.timeZone },
        );

    for (const occurrence of occurrences) {
      const event = occurrence.exception ?? master;
      if (event.status === "cancelled") continue;
      const response = event.myResponse ?? master.myResponse ?? null;
      if (response === "declined") continue;
      const recurrenceId = orphan
        ? master.recurrenceId
        : occurrence.recurrenceId;

      let startMs: number;
      let endMs: number;
      let minutesList: number[];
      let fireAtOf: (minutes: number) => number;
      if (occurrence.allDay) {
        const start = dayStart(occurrence.startDate, settings.timeZone);
        startMs = start.epochMilliseconds;
        endMs = dayStart(
          occurrence.endDate > occurrence.startDate
            ? occurrence.endDate
            : Temporal.PlainDate.from(occurrence.startDate)
                .add({ days: 1 })
                .toString(),
          settings.timeZone,
        ).epochMilliseconds;
        minutesList = event.useDefaultReminders
          ? allDayDefaultMinutes(settings)
          : displayMinutes(event.reminders, true);
        // 壁時計で引く (「前日 9:00」が夏時間の切り替えの前後でも 9:00 になる)。
        fireAtOf = (minutes) =>
          start
            .toPlainDateTime()
            .subtract({ minutes })
            .toZonedDateTime(settings.timeZone, {
              disambiguation: "compatible",
            }).epochMilliseconds;
      } else {
        startMs = Temporal.Instant.from(occurrence.startAt).epochMilliseconds;
        endMs = Temporal.Instant.from(occurrence.endAt).epochMilliseconds;
        minutesList = displayMinutes(
          event.useDefaultReminders
            ? calendar.defaultReminders
            : event.reminders,
          false,
        );
        // 経過時間で引く (Google と同じ持ち方)。
        fireAtOf = (minutes) => startMs - minutes * 60_000;
      }
      const expiresAt = Math.max(endMs, startMs + MIN_REMINDER_LIFETIME_MS);
      for (const minutes of minutesList) {
        const fireAt = fireAtOf(minutes);
        if (fireAt < from || fireAt >= to || fireAt >= expiresAt) continue;
        const tag = reminderTag(masterId, recurrenceId, minutes);
        const base = {
          tag,
          masterId,
          eventId: event.id,
          calendarId: calendar.id,
          recurrenceId,
          minutes,
          fireAt,
          expiresAt,
        };
        result.set(
          tag,
          occurrence.allDay
            ? {
                ...base,
                allDay: true,
                startDate: occurrence.startDate,
                endDate: occurrence.endDate,
              }
            : {
                ...base,
                allDay: false,
                startAt: instantRecurrenceId(occurrence.startAt),
                endAt: instantRecurrenceId(occurrence.endAt),
              },
        );
      }
    }
  }
  return [...result.values()].sort(comparePlanned);
}
