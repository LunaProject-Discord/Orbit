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
  REMINDER_LATE_LIMIT_MS,
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
 *
 * 鳴らす時刻を少し (15 分以内) 過ぎたもの: 設計 2.1 では鳴らす。橋にまだ渡したことが無いもの
 * (作った時点で時刻を過ぎていた予定など) だけを 1 度渡し、橋がすぐに出す。渡したことのあるものは
 * 渡さない (橋が「過ぎたがまだ出していない」ものを自分で残す。起動し直した橋で二重に出さない)。
 * 渡した印は localStorage に置く (HandedReminders)。
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
  /** 控えを今すぐ最新にする (新しい招待の通知の前に、その予定を控えに入れるため)。 */
  pull?(): Promise<unknown>;
};

/** 橋に渡した印 (tag@鳴らす時刻 → 鳴らす時刻)。 */
export type HandedReminders = {
  load(): Map<string, number>;
  save(value: Map<string, number>): void;
  clear(): void;
};

/** 橋に渡した印を置く localStorage の鍵。 */
export const HANDED_REMINDERS_STORAGE_KEY = "calendar.reminders.handed";

/** localStorage に置く印 (使えなければ、この画面の中だけで覚える)。 */
export function createStoredHandedReminders(): HandedReminders {
  let memory = new Map<string, number>();
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  return {
    load() {
      try {
        const raw = storage?.getItem(HANDED_REMINDERS_STORAGE_KEY);
        if (!raw) return new Map(memory);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return new Map(memory);
        return new Map(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        );
      } catch {
        return new Map(memory);
      }
    },
    save(value) {
      memory = new Map(value);
      try {
        storage?.setItem(
          HANDED_REMINDERS_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(value)),
        );
      } catch {
        // 書けなくても、この画面の中では覚えている。
      }
    },
    clear() {
      memory = new Map();
      try {
        storage?.removeItem(HANDED_REMINDERS_STORAGE_KEY);
      } catch {
        // 消せなくても、印は 15 分で使われなくなる。
      }
    },
  };
}

function handedKey(item: Pick<ScheduledReminder, "tag" | "fireAt">): string {
  return `${item.tag}@${item.fireAt}`;
}

/**
 * 橋に渡す一覧を決める。時刻を過ぎたもの (15 分以内) は、まだ渡したことが無いものだけ。
 * 戻り値の handed は、渡したあとに覚える印 (15 分より前のものは捨てる)。
 */
export function selectUnhanded(
  items: readonly ScheduledReminder[],
  handed: ReadonlyMap<string, number>,
  now: number,
): { items: ScheduledReminder[]; handed: Map<string, number> } {
  const next = new Map<string, number>();
  for (const [key, fireAt] of handed) {
    if (fireAt >= now - REMINDER_LATE_LIMIT_MS) next.set(key, fireAt);
  }
  const selected = items.filter(
    (item) => item.fireAt > now || !handed.has(handedKey(item)),
  );
  for (const item of selected) next.set(handedKey(item), item.fireAt);
  return { items: selected, handed: next };
}

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
  /** 橋に渡した印の置き場 (既定は localStorage)。 */
  handed?: HandedReminders;
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
 * 鳴らす時刻を 15 分以内に過ぎた、まだ終わっていない予定のものも含める (設計 2.1)。
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
    from: now - REMINDER_LATE_LIMIT_MS,
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
  private readonly handed: HandedReminders;

  constructor(private readonly options: ReminderAgentOptions) {
    this.now = options.now ?? Date.now;
    this.handed = options.handed ?? createStoredHandedReminders();
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
    const now = this.now();
    const built = buildDeviceReminders(snapshot, this.options.settings(), now);
    const { coverUntil } = built;
    const { items, handed } = selectUnhanded(
      built.items,
      this.handed.load(),
      now,
    );
    const signature = JSON.stringify(items);
    if (signature !== this.lastSent) {
      await this.options.bridge.replaceAll(items);
      if (this.stopped) return;
      this.lastSent = signature;
    }
    this.handed.save(handed);
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
    this.handed.clear();
    await this.options.bridge.clear();
  }
}
