/**
 * デスクトップ版 (Tauri) の、予定の通知の橋 (段取り 9、設計 3.5 の E)。
 * 予約の計算と文言は ReminderAgent (lib/calendar/notifications) が持ち、ここは Rust 側
 * (apps/desktop/src-tauri/src/reminders.rs) のコマンドとイベントへの入口だけを受け持つ。
 *
 * - Windows: OS の予約トースト (アプリを終了しても鳴る見込み)。capabilities は "os"。
 *   予約トーストが使えなければ Rust 側がタイマー方式に切り替え、"process" を返す。
 * - macOS / Linux: Rust 側のタイマー (起動中だけ)。capabilities は "process"。
 * - 古いアプリ (このコマンドが無い) とブラウザー: "none" (予約しない)。
 *   画面は自動更新で新しくなっても、アプリ本体が古いままのことがあるため。
 *
 * Desktop はサーバーに送り先を登録しない (SSE で受けて OS の通知を出す) ので、
 * POST /v1/push/devices/reminders などの報告はしない。
 */

import type { CalendarPushMessage } from "@orbit/core/calendar-notifications";
import type { RsvpStatus } from "@orbit/core/event-invite";
import type {
  CalendarActionPayload,
  DesktopCalendarNotification,
  ReminderBridge,
  ReminderCapabilities,
  ScheduledReminder,
} from "@/lib/calendar/notifications/bridge";
import {
  DESKTOP_CALENDAR_EVENTS,
  DESKTOP_REMINDER_COMMANDS,
} from "@/lib/calendar/notifications/bridge";
import { invokeDesktop, isDesktopApp, listenDesktop } from "./app";

/**
 * まだ受け取っていない「予定を開いてほしい」を受け取るコマンド (src-tauri/src/launch.rs)。
 * 通知を押してアプリが起動したときは、画面がイベントを聞き始める前に届くので、受け取りに行く。
 */
export const TAKE_PENDING_OPEN_EVENT_COMMAND = "take_pending_open_event";

const NO_SCHEDULE: ReminderCapabilities = { schedule: "none", exact: false };

function isCapabilities(value: unknown): value is ReminderCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const { schedule, exact } = value as Record<string, unknown>;
  return (
    (schedule === "os" || schedule === "process" || schedule === "none") &&
    typeof exact === "boolean"
  );
}

/** Rust 側へ渡す形にそろえる (余計な項目を送らない。時刻は整数)。 */
function toCommandItem(item: ScheduledReminder): ScheduledReminder {
  return {
    tag: item.tag,
    fireAt: Math.trunc(item.fireAt),
    expiresAt: Math.trunc(item.expiresAt),
    title: item.title,
    body: item.body,
    eventId: item.eventId,
    recurrenceId: item.recurrenceId,
  };
}

/** デスクトップ版の橋。D1 の notifications/index.ts が動的 import して使う。 */
export function createDesktopReminderBridge(): ReminderBridge {
  return {
    async capabilities() {
      if (!isDesktopApp()) return NO_SCHEDULE;
      const result = await invokeDesktop<unknown>(
        DESKTOP_REMINDER_COMMANDS.capabilities,
      );
      return isCapabilities(result) ? result : NO_SCHEDULE;
    },
    async replaceAll(items) {
      await invokeDesktop(DESKTOP_REMINDER_COMMANDS.schedule, {
        items: items.map(toCommandItem),
      });
    },
    async clear() {
      await invokeDesktop(DESKTOP_REMINDER_COMMANDS.clear);
    },
  };
}

/**
 * SSE で受けた招待・変更・取り消しを、notify_calendar に渡す形にする。
 * rsvp (出欠のボタン) は、招待で、主催者に返事が届くカレンダーのときだけ画面が true にする (設計 2.4)。
 */
export function toDesktopCalendarNotification(
  message: CalendarPushMessage,
  options: { rsvp: boolean },
): DesktopCalendarNotification {
  return {
    kind: message.kind,
    title: message.title,
    body: message.body,
    tag: message.tag,
    eventId: message.eventId,
    recurrenceId: message.recurrenceId ?? null,
    expiresAt: message.expiresAt ?? null,
    rsvp:
      options.rsvp &&
      message.kind === "event-invite" &&
      message.eventId !== null,
  };
}

/** 招待・変更・取り消しを OS の通知で出す (メインウィンドウの分だけ出る)。 */
export function notifyDesktopCalendar(
  notification: DesktopCalendarNotification,
): Promise<null> {
  return invokeDesktop<null>(DESKTOP_REMINDER_COMMANDS.notify, {
    notification,
  });
}

/**
 * 通知を押して開く予定。eventId が null なら (まとめた招待の通知など) カレンダーを開くだけ。
 * bridge.ts の OpenEventPayload に、カレンダーを開くだけの場合 (null) を足したもの。
 */
export type DesktopOpenEvent = {
  eventId: string | null;
  recurrenceId: string | null;
};

function isOpenEvent(value: unknown): value is DesktopOpenEvent {
  if (typeof value !== "object" || value === null) return false;
  const { eventId, recurrenceId } = value as Record<string, unknown>;
  return (
    (eventId === null || typeof eventId === "string") &&
    (recurrenceId === null ||
      recurrenceId === undefined ||
      typeof recurrenceId === "string")
  );
}

/**
 * 通知を押して「予定を開いてほしい」が届いたら呼ぶ。戻り値の関数で解除する。
 * desktop://open-event は合図として受け、中身は take_pending_open_event で受け取る
 * (起動直後に届いて取りこぼした分も、聞き始めたときに受け取る。同じものを 2 度開かない)。
 */
export function listenDesktopOpenEvent(
  listener: (target: DesktopOpenEvent) => void,
): () => void {
  if (!isDesktopApp()) return () => {};
  let active = true;
  const take = async () => {
    const target = await invokeDesktop<unknown>(
      TAKE_PENDING_OPEN_EVENT_COMMAND,
    );
    if (active && isOpenEvent(target)) {
      listener({
        eventId: target.eventId,
        recurrenceId: target.recurrenceId ?? null,
      });
    }
  };
  const unlisten = listenDesktop<unknown>(
    DESKTOP_CALENDAR_EVENTS.openEvent,
    () => void take(),
  );
  void take();
  return () => {
    active = false;
    unlisten();
  };
}

const RSVP_STATUSES: readonly RsvpStatus[] = [
  "accepted",
  "tentative",
  "declined",
];

/**
 * Windows のトーストの出欠ボタン (参加 / 未定 / 不参加) が押されたら呼ぶ。戻り値の関数で解除する。
 * 画面は client.respond(eventId, status) で返事をし (オフラインなら送信待ちに積まれる)、
 * 失敗したら「出欠を反映できませんでした」を notify_calendar で出す。
 */
export function listenDesktopCalendarAction(
  listener: (action: CalendarActionPayload) => void,
): () => void {
  return listenDesktop<unknown>(
    DESKTOP_CALENDAR_EVENTS.calendarAction,
    (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const { eventId, status } = payload as Record<string, unknown>;
      if (
        typeof eventId === "string" &&
        RSVP_STATUSES.includes(status as RsvpStatus)
      ) {
        listener({ eventId, status: status as RsvpStatus });
      }
    },
  );
}
