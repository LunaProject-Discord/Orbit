import { isReminderLate } from "@orbit/core/reminders";
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

/** 今の時刻に出すもの (due) と、出さずに済ませるもの (skip) を分ける。 */
export function dueReminders(
  items: readonly ScheduledReminder[],
  shown: ReadonlySet<string>,
  now: number,
): { due: ScheduledReminder[]; skip: ScheduledReminder[] } {
  const due: ScheduledReminder[] = [];
  const skip: ScheduledReminder[] = [];
  for (const item of items) {
    if (shown.has(item.tag) || item.fireAt > now) continue;
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

/** 出したリマインダーの通知を閉じる (ログアウトのとき)。 */
async function closeShown(
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
  let items: ScheduledReminder[] = [];
  const shown = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = async () => {
    const at = now();
    const { due, skip } = dueReminders(items, shown, at);
    for (const item of skip) shown.add(item.tag);
    for (const item of due) {
      shown.add(item.tag);
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
      // Agent は「今から先」だけを渡すので、時刻を過ぎたがまだ出していないものは残す
      // (次の確認の前に組み直されても落とさない)。
      const kept = items.filter(
        (item) =>
          !tags.has(item.tag) &&
          !shown.has(item.tag) &&
          item.fireAt <= at &&
          !isReminderLate(item.fireAt, at),
      );
      items = [...kept, ...next];
      const live = new Set(items.map((item) => item.tag));
      for (const tag of shown) if (!live.has(tag)) shown.delete(tag);
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
      await closeShown(registration);
    },
  };
}
