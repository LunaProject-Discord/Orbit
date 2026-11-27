import { isReminderLate, REMINDER_LATE_LIMIT_MS } from "@orbit/core/reminders";
import type {
  CalendarNotificationData,
  ReminderBridge,
  ScheduledReminder,
} from "@/lib/calendar/notifications/bridge";
import { openCalendarEvent } from "@/lib/calendar/route";

/**
 * Web (ブラウザー・PWA) の橋 (段取り 9、設計 3.5)。Web には予約通知が無いので、
 * Web Push が使えないとき (状態が page) だけ、画面を開いている間のタイマーで出す。
 * setTimeout を長く張らず、30 秒ごとに一覧を見て時刻の来たものを出す (スリープ明けにずれないように)。
 * 鳴らす時刻を 15 分過ぎて見つけたもの (スリープ明けなど) は出さない。
 *
 * 出した印は「tag@鳴らす時刻」で覚える (同じ tag でも時刻が動けば、別の通知としてもう一度出す)。
 * 印は localStorage に置き、同じ端末のほかのタブと分け合う (消した通知が別のタブから出直さない)。
 */

/** 一覧を見る間隔。 */
export const WEB_REMINDER_CHECK_MS = 30_000;

const ICON = "/icons/icon-192.png";

/** 出す通知 1 件の中身 (サービスワーカーの notificationclick が data を読む)。 */
export function webReminderNotification(item: ScheduledReminder): {
  title: string;
  options: NotificationOptions;
} {
  const data: CalendarNotificationData = {
    kind: "event-reminder",
    eventId: item.eventId,
    recurrenceId: item.recurrenceId,
  };
  return {
    title: item.title,
    options: { body: item.body, tag: item.tag, icon: ICON, data },
  };
}

/** 出した印 (同じ tag でも、鳴らす時刻が動けば別の通知)。Desktop の Rust の fire_key と同じ形。 */
export function reminderFireKey(
  item: Pick<ScheduledReminder, "tag" | "fireAt">,
): string {
  return `${item.tag}@${item.fireAt}`;
}

/** 出した印の置き場。 */
export type ShownReminders = {
  has(key: string): boolean;
  /** keepUntil まで覚える (epoch ms)。 */
  add(key: string, keepUntil: number): void;
  clear(): void;
};

/** 出した印を置く localStorage の鍵。 */
export const WEB_REMINDER_SHOWN_STORAGE_KEY = "calendar.reminders.web-shown";

/**
 * 出した印を localStorage に置く (同じ端末のタブで分け合う)。読むたびに読み直すので、
 * ほかのタブが出した印もすぐに見える。localStorage が使えなければ、このタブの中だけで覚える。
 */
export function createSharedShownReminders(
  now: () => number = Date.now,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })(),
): ShownReminders {
  let memory: Record<string, number> = {};
  const read = (): Record<string, number> => {
    if (!storage) return memory;
    try {
      const parsed: unknown = JSON.parse(
        storage.getItem(WEB_REMINDER_SHOWN_STORAGE_KEY) ?? "{}",
      );
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, number>)
        : {};
    } catch {
      return memory;
    }
  };
  const write = (value: Record<string, number>) => {
    memory = value;
    if (!storage) return;
    try {
      storage.setItem(WEB_REMINDER_SHOWN_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // 書けなくても、このタブの中では覚えている。
    }
  };
  return {
    has(key) {
      const until = read()[key];
      return typeof until === "number" && until > now();
    },
    add(key, keepUntil) {
      const at = now();
      const next: Record<string, number> = {};
      // 期限の過ぎた印は捨てる (増え続けないようにする)。
      for (const [other, until] of Object.entries(read())) {
        if (typeof until === "number" && until > at) next[other] = until;
      }
      next[key] = keepUntil;
      write(next);
    },
    clear() {
      memory = {};
      try {
        storage?.removeItem(WEB_REMINDER_SHOWN_STORAGE_KEY);
      } catch {
        // 消せなくても、印は期限で消える。
      }
    },
  };
}

/** 印を覚えておく期限。鳴らす時刻を 15 分過ぎると Agent も橋も渡さなくなるので、その少しあと。 */
function keepUntilOf(item: ScheduledReminder): number {
  return item.fireAt + REMINDER_LATE_LIMIT_MS + 60_000;
}

/** 今の時刻に出すもの (due) と、出さずに済ませるもの (skip) を分ける。 */
export function dueReminders(
  items: readonly ScheduledReminder[],
  shown: Pick<ShownReminders, "has">,
  now: number,
): { due: ScheduledReminder[]; skip: ScheduledReminder[] } {
  const due: ScheduledReminder[] = [];
  const skip: ScheduledReminder[] = [];
  for (const item of items) {
    if (item.fireAt > now || shown.has(reminderFireKey(item))) continue;
    if (isReminderLate(item.fireAt, now) || now >= item.expiresAt) {
      skip.push(item);
    } else {
      due.push(item);
    }
  }
  return { due, skip };
}

export type WebReminderBridgeOptions = {
  now?: () => number;
  checkMs?: number;
  /** 通知を出す (テストで差し替える)。 */
  show?: (item: ScheduledReminder) => Promise<void>;
  /** 出した印の置き場 (既定は localStorage でタブと分け合う)。 */
  shown?: ShownReminders;
};

function canNotify(): boolean {
  return (
    typeof Notification !== "undefined" && Notification.permission === "granted"
  );
}

async function showWith(
  registration: ServiceWorkerRegistration | null,
  item: ScheduledReminder,
): Promise<void> {
  if (!canNotify()) return;
  const { title, options } = webReminderNotification(item);
  if (registration?.active) {
    await registration.showNotification(title, options);
    return;
  }
  const shown = new Notification(title, options);
  shown.onclick = () => {
    window.focus();
    shown.close();
    openCalendarEvent({
      eventId: item.eventId,
      recurrenceId: item.recurrenceId,
    });
  };
}

/** 出ている予定の通知を閉じる (ログアウトのとき。Web Push で届いたものも含む)。 */
export async function closeCalendarNotifications(
  registration: ServiceWorkerRegistration | null,
): Promise<void> {
  if (!registration) return;
  try {
    for (const item of await registration.getNotifications()) {
      const kind: unknown = (item.data as { kind?: unknown } | null)?.kind;
      if (typeof kind === "string" && kind.startsWith("event-")) item.close();
    }
  } catch {
    // 閉じられなくても、新しい通知は出なくなる。
  }
}

export function createWebReminderBridge(
  registration: ServiceWorkerRegistration | null,
  options: WebReminderBridgeOptions = {},
): ReminderBridge {
  const now = options.now ?? Date.now;
  const show = options.show ?? ((item) => showWith(registration, item));
  const shown = options.shown ?? createSharedShownReminders(now);
  let items: ScheduledReminder[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = async () => {
    const at = now();
    const { due, skip } = dueReminders(items, shown, at);
    const done = new Set([...due, ...skip]);
    items = items.filter((item) => !done.has(item));
    for (const item of skip)
      shown.add(reminderFireKey(item), keepUntilOf(item));
    for (const item of due) {
      // 出す前に、ほかのタブが出していないかをもう一度見る。
      if (shown.has(reminderFireKey(item))) continue;
      shown.add(reminderFireKey(item), keepUntilOf(item));
      await show(item).catch(() => {});
    }
  };

  return {
    async capabilities() {
      return { schedule: "process", exact: false };
    },
    async replaceAll(next) {
      const at = now();
      const tags = new Set(next.map((item) => item.tag));
      // Agent は過ぎたものを 1 度しか渡さないので、時刻を過ぎたがまだ出していないものは残す
      // (次の確認の前に組み直されても落とさない)。同じ tag が新しい一覧にあれば、そちらを使う。
      const kept = items.filter(
        (item) =>
          !tags.has(item.tag) &&
          !shown.has(reminderFireKey(item)) &&
          item.fireAt <= at &&
          !isReminderLate(item.fireAt, at) &&
          at < item.expiresAt,
      );
      items = [...kept, ...next];
      timer ??= setInterval(
        () => void check(),
        options.checkMs ?? WEB_REMINDER_CHECK_MS,
      );
      await check();
    },
    async clear() {
      if (timer) clearInterval(timer);
      timer = null;
      items = [];
      shown.clear();
      await closeCalendarNotifications(registration);
    },
  };
}
