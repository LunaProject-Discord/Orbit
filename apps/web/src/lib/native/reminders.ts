import {
  DESKTOP_EVENT_URL_PREFIX,
  NATIVE_REMINDER_METHODS,
  type OpenEventMessage,
  type ReminderBridge,
  type ReminderCapabilities,
  type ScheduledReminder,
} from "@/lib/calendar/notifications/bridge";
import { isNativeApp, loadAppShell } from "@/lib/native/app";

/**
 * Android アプリ (Capacitor) の予定のリマインダーの橋 (段取り 9、設計 3.2・3.5)。
 * 予約そのものは apps/mobile の AppShellPlugin → ReminderScheduler (AlarmManager) が行う。
 * 毎回「全部の一覧」を渡し、今ある予約との差分は Java の側で取る。
 *
 * Mail アプリは正確なアラームの権限を持たないので、Android 12 以降は exact = false になる
 * (予約は数分遅れ得る。サーバーの FCM も届き、同じ tag で 1 つの通知になる)。
 * Calendar アプリ (段取り 10) が入っている端末では schedule = "none" を返し、予約しない。
 */

/** 通知から起動したときの予定の URL を、1 度だけ受け取る AppShell のメソッド (MainActivity が持つ)。 */
export const TAKE_LAUNCH_CALENDAR_URL_METHOD = "takeLaunchCalendarUrl";

type NativeReminderShell = {
  [NATIVE_REMINDER_METHODS.schedule](options: {
    items: ScheduledReminder[];
  }): Promise<void>;
  [NATIVE_REMINDER_METHODS.clear](): Promise<void>;
  [NATIVE_REMINDER_METHODS.capabilities](): Promise<unknown>;
  [TAKE_LAUNCH_CALENDAR_URL_METHOD](): Promise<unknown>;
};

const NONE: ReminderCapabilities = { schedule: "none", exact: false };

async function shell(): Promise<NativeReminderShell> {
  const { AppShell } = await loadAppShell();
  // AppShell は、どんな名前のメソッドも端末側へ取り次ぐ Proxy (lib/native/app.ts)。
  return AppShell as unknown as NativeReminderShell;
}

/** 端末から返った能力を確かめる。形が違えば予約できない扱い。 */
export function parseNativeCapabilities(value: unknown): ReminderCapabilities {
  if (!value || typeof value !== "object") return NONE;
  const { schedule, exact } = value as Record<string, unknown>;
  if (schedule !== "os" && schedule !== "process" && schedule !== "none") {
    return NONE;
  }
  return { schedule, exact: schedule !== "none" && exact === true };
}

/** 端末へ渡す形 (ScheduledReminder の項目だけ。余計な値を渡さない)。 */
export function toNativeReminder(item: ScheduledReminder): ScheduledReminder {
  return {
    tag: item.tag,
    fireAt: Math.floor(item.fireAt),
    expiresAt: Math.floor(item.expiresAt),
    title: item.title,
    body: item.body,
    eventId: item.eventId,
    recurrenceId: item.recurrenceId,
  };
}

export function createNativeReminderBridge(): ReminderBridge {
  return {
    async capabilities() {
      if (!isNativeApp()) return NONE;
      try {
        const native = await shell();
        return parseNativeCapabilities(
          await native[NATIVE_REMINDER_METHODS.capabilities](),
        );
      } catch {
        // 古いアプリ (予約の機能が無い) は、予約できない扱い (サーバーの FCM だけになる)。
        return NONE;
      }
    },
    async replaceAll(items) {
      if (!isNativeApp()) return;
      const native = await shell();
      await native[NATIVE_REMINDER_METHODS.schedule]({
        items: items.map(toNativeReminder),
      });
    },
    async clear() {
      if (!isNativeApp()) return;
      try {
        const native = await shell();
        await native[NATIVE_REMINDER_METHODS.clear]();
      } catch {
        // 古いアプリには予約が無い。ログアウトでは Java の側 (publishSharedConfig) でも消す。
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 通知を押して予定を開く (設計 3.5・8 章)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_URL = DESKTOP_EVENT_URL_PREFIX.replace(/\/events\/$/, "");

/**
 * 古いアプリ (takeLaunchCalendarUrl が無い) で、起動時の URL (getLaunchUrl) を使ったか。
 * 画面の中の値なので、画面を作り直すと消える (新しいアプリは Java 側で 1 度だけ渡す)。
 */
let launchUrlUsed = false;

/**
 * 通知から起動したときの URL を受け取る。新しいアプリは Java 側 (MainActivity) が 1 度だけ渡し、
 * 履歴から開き直したときや画面を作り直したときは渡さない。古いアプリは getLaunchUrl を
 * この画面で 1 度だけ使う。
 */
export async function takeNativeLaunchUrl(
  getLaunchUrl: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    const native = await shell();
    const result = await native[TAKE_LAUNCH_CALENDAR_URL_METHOD]();
    if (result && typeof result === "object" && "url" in result) {
      const url = (result as { url: unknown }).url;
      return typeof url === "string" && url ? url : undefined;
    }
  } catch {
    // 古いアプリ (メソッドが無い)。下で getLaunchUrl を使う。
  }
  if (launchUrlUsed) return undefined;
  launchUrlUsed = true;
  return getLaunchUrl();
}

/** カレンダーを開いてほしい (まとめた招待の通知など、予定が 1 つに決まらないとき)。 */
export type OpenCalendarMessage = { type: "open-calendar" };

/**
 * 予定の通知を押したときにアプリが開く URL を読む。
 * jp.lunaproject.orbit.mail://calendar/events/<UUID>?o=<回> → 予定を開く、
 * jp.lunaproject.orbit.mail://calendar → カレンダーを開く。それ以外 (ログインの戻りなど) は null。
 * 予定の ID は UUID の形だけ受け付ける (設計 7.5。画面は自分の控えに無い ID を無視する)。
 */
export function parseNativeCalendarUrl(
  url: string,
): OpenEventMessage | OpenCalendarMessage | null {
  if (url === CALENDAR_URL || url === `${CALENDAR_URL}/`) {
    return { type: "open-calendar" };
  }
  if (!url.startsWith(DESKTOP_EVENT_URL_PREFIX)) return null;
  const rest = url.slice(DESKTOP_EVENT_URL_PREFIX.length);
  const query = rest.indexOf("?");
  const id = query < 0 ? rest : rest.slice(0, query);
  if (!UUID.test(id)) return null;
  let recurrenceId: string | null = null;
  if (query >= 0) {
    const value = new URLSearchParams(rest.slice(query + 1)).get("o");
    recurrenceId = value && value.length <= 64 ? value : null;
  }
  return { type: "open-event", eventId: id.toLowerCase(), recurrenceId };
}

/**
 * 予定の通知が押されたことを受け取る (Android アプリ)。起動中は App プラグインの appUrlOpen、
 * 通知からアプリが起動したときは getLaunchUrl で届く。戻り値の関数で解除する。
 * つなぎ込み (画面を /calendar/events/<id> へ移す) は、サービスワーカーの open-event と同じ所で行う。
 */
export function listenNativeCalendarOpen(
  listener: (message: OpenEventMessage | OpenCalendarMessage) => void,
): () => void {
  if (!isNativeApp()) return () => {};
  let cancelled = false;
  let remove: (() => void) | null = null;
  const deliver = (url: string | undefined) => {
    if (cancelled || !url) return;
    const message = parseNativeCalendarUrl(url);
    if (message) listener(message);
  };
  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("appUrlOpen", ({ url }) =>
        deliver(url),
      );
      if (cancelled) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();
      deliver(
        await takeNativeLaunchUrl(async () => (await App.getLaunchUrl())?.url),
      );
    } catch {
      // 受け取れなくても、通知からアプリは開く (今の画面のまま)。
    }
  })();
  return () => {
    cancelled = true;
    remove?.();
  };
}
