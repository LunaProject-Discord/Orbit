import {
  type CalendarNotificationDetail,
  type CalendarTextFormat,
  toReminderMessage,
} from "@orbit/core/calendar-notifications";
import {
  calendarNotifies,
  DEVICE_REMINDER_DEBOUNCE_MS,
  DEVICE_REMINDER_LIMIT,
  DEVICE_REMINDER_REFRESH_MS,
  DEVICE_REMINDER_WINDOW_MS,
  planReminders,
  type ReminderCalendar,
  type ReminderEvent,
  selectDeviceReminders,
  selfResponse,
} from "@orbit/core/reminders";
import type { Calendar, CalendarEvent } from "@/lib/calendar/api";
import type {
  ReminderBridge,
  ReminderCapabilities,
  ScheduledReminder,
} from "@/lib/calendar/notifications/bridge";

/**
 * 予定のリマインダーを端末に予約する Agent (段取り 9、設計 3.2)。
 * 端末の控え (OfflineCalendarClient) から planReminders で「今〜7 日先・最大 64 件」を選び、
 * 文言まで作って橋 (bridge) に毎回「全部の一覧」を渡す。差分は橋の側で取る。
 *
 * 組み直す時機: 開始時、控えが変わったとき、設定やタイムゾーンが変わったとき (refresh)、
 * 6 時間ごと (7 日の窓を進める)。続けて来たら 500 ms でまとめる。
 */

/** Agent が読む控え。OfflineCalendarClient がこの形を持つ。 */
export type ReminderSnapshot = {
  calendars: readonly Calendar[];
  events: readonly CalendarEvent[];
  /** 控えの同期位置 (changes.seq)。 */
  cursor: string;
};

export type ReminderSource = {
  /** 初回の同期が終わるまでは null。 */
  reminderSnapshot(): ReminderSnapshot | null;
  /** 控えが変わったら呼ぶ。購読しているあいだ、控えは SSE の change で最新に保たれる。 */
  subscribe(listener: () => void): () => void;
};

/** 予約に使う利用者の設定。 */
export type ReminderAgentSettings = {
  /** 端末の今のタイムゾーン (終日の予定の「開始日の 0:00」と、文言の日時)。 */
  timeZone: string;
  /** 終日の予定の既定の通知 (calendar_notifications.allDay)。null はオフ。 */
  allDay: { minutes: number } | null;
  /** private なら題名と本文を伏せる。 */
  detail: CalendarNotificationDetail;
  format?: CalendarTextFormat;
};

/** 組み直した結果 (Android がサーバーへ報告する予約の範囲)。 */
export type ReminderCoverResult = {
  coverUntil: number;
  coverSeq: string;
  exact: boolean;
  count: number;
};

export type ReminderAgentOptions = {
  source: ReminderSource;
  bridge: ReminderBridge;
  settings: () => ReminderAgentSettings;
  now?: () => number;
  /** 橋に渡したあとに呼ぶ (予約の範囲の報告に使う)。 */
  onScheduled?: (result: ReminderCoverResult) => void;
  debounceMs?: number;
  refreshMs?: number;
};

/** カレンダーの通知が効くか。サーバーの応答の notify (効く値) があればそれ、無ければ種類ごとの既定。 */
export function calendarNotifyOf(calendar: Calendar): boolean {
  const notify = (calendar as { notify?: unknown }).notify;
  return calendarNotifies({
    source: calendar.source,
    notify: typeof notify === "boolean" ? notify : null,
  });
}

export function toReminderCalendar(calendar: Calendar): ReminderCalendar {
  return {
    id: calendar.id,
    notify: calendarNotifyOf(calendar),
    visible: calendar.visible,
    defaultReminders: calendar.defaultReminders ?? null,
    timeZone: calendar.timeZone,
  };
}

export function toReminderEvent(event: CalendarEvent): ReminderEvent {
  return {
    id: event.id,
    calendarId: event.calendarId,
    parentId: event.parentId,
    recurrenceId: event.recurrenceId,
    status: event.status,
    allDay: event.allDay,
    startAt: event.startAt,
    endAt: event.endAt,
    startDate: event.startDate,
    endDate: event.endDate,
    startTimeZone: event.startTimeZone,
    rrule: event.rrule,
    rdates: event.rdates ?? null,
    exdates: event.exdates ?? null,
    useDefaultReminders: event.useDefaultReminders,
    reminders: event.reminders ?? [],
    myResponse: selfResponse(event.attendees),
  };
}

/**
 * 控えから、端末に予約する一覧を作る。文言の「今日」は鳴らす時刻で決める
 * (前の日に予約しても、鳴ったときに正しい言い方になるように)。
 */
export function buildDeviceReminders(
  snapshot: ReminderSnapshot,
  settings: ReminderAgentSettings,
  now: number,
  limit = DEVICE_REMINDER_LIMIT,
): { items: ScheduledReminder[]; coverUntil: number } {
  const to = now + DEVICE_REMINDER_WINDOW_MS;
  const planned = planReminders({
    calendars: snapshot.calendars.map(toReminderCalendar),
    events: snapshot.events.map(toReminderEvent),
    settings: { timeZone: settings.timeZone, allDay: settings.allDay },
    from: now,
    to,
  });
  const { reminders, coverUntil } = selectDeviceReminders(planned, {
    to,
    limit,
  });
  const byId = new Map(snapshot.events.map((event) => [event.id, event]));
  const items = reminders.map((item): ScheduledReminder => {
    const event = byId.get(item.eventId);
    const message = toReminderMessage(
      item,
      { summary: event?.summary ?? null, location: event?.location ?? null },
      {
        timeZone: settings.timeZone,
        now: item.fireAt,
        detail: settings.detail,
        ...(settings.format ? { format: settings.format } : {}),
      },
    );
    return {
      tag: item.tag,
      fireAt: item.fireAt,
      expiresAt: item.expiresAt,
      title: message.title,
      body: message.body,
      eventId: item.eventId,
      recurrenceId: item.recurrenceId,
    };
  });
  return { items, coverUntil };
}

export class ReminderAgent {
  private readonly now: () => number;
  private capabilities: ReminderCapabilities | null = null;
  private unsubscribe: (() => void) | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private lastSent: string | null = null;

  constructor(private readonly options: ReminderAgentOptions) {
    this.now = options.now ?? Date.now;
  }

  /** 動かし始める。橋が予約できない (none) なら動かさずに false。 */
  async start(): Promise<boolean> {
    const capabilities = await this.options.bridge
      .capabilities()
      .catch((): ReminderCapabilities => ({ schedule: "none", exact: false }));
    if (this.stopped || capabilities.schedule === "none") return false;
    this.capabilities = capabilities;
    this.unsubscribe = this.options.source.subscribe(() => this.refresh());
    this.interval = setInterval(
      () => this.refresh(),
      this.options.refreshMs ?? DEVICE_REMINDER_REFRESH_MS,
    );
    await this.rebuild();
    return true;
  }

  /** 組み直す (続けて呼ばれたら 500 ms でまとめる)。 */
  refresh(): void {
    if (this.stopped || !this.capabilities) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.rebuild();
    }, this.options.debounceMs ?? DEVICE_REMINDER_DEBOUNCE_MS);
  }

  /** 今すぐ組み直す。組み直しの途中なら、終わってからもう 1 回だけ行う。 */
  rebuild(): Promise<void> {
    if (this.stopped || !this.capabilities) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.rebuildOnce();
      } while (this.again && !this.stopped);
    })()
      .catch(() => {
        // 予約できなくても、画面の操作は続けられる (次の時機に組み直す)。
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async rebuildOnce(): Promise<void> {
    const snapshot = this.options.source.reminderSnapshot();
    const capabilities = this.capabilities;
    if (!snapshot || !capabilities) return;
    const { items, coverUntil } = buildDeviceReminders(
      snapshot,
      this.options.settings(),
      this.now(),
    );
    const signature = JSON.stringify(items);
    if (signature !== this.lastSent) {
      await this.options.bridge.replaceAll(items);
      if (this.stopped) return;
      this.lastSent = signature;
    }
    this.options.onScheduled?.({
      coverUntil,
      coverSeq: snapshot.cursor,
      exact: capabilities.exact,
      count: items.length,
    });
  }

  /** 止める (予約は残す。アプリを閉じても鳴らすため)。 */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.interval) clearInterval(this.interval);
    this.debounce = null;
    this.interval = null;
  }

  /** 止めて、予約をすべて消す (ログアウト・利用者の切り替え)。 */
  async clear(): Promise<void> {
    this.stop();
    await this.running?.catch(() => {});
    this.lastSent = null;
    await this.options.bridge.clear();
  }
}
