import {
  type CalendarNotificationSettings,
  DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
  rsvpFailedText,
} from "@orbit/core/calendar-notifications";
import type { RsvpStatus } from "@orbit/core/event-invite";
import { REMINDER_COVER_REPORT_MIN_INTERVAL_MS } from "@orbit/core/reminders";
import {
  getCalendarNotificationSettings,
  reportReminderCover,
  saveCalendarNotificationSettings,
} from "@/lib/api";
import { localTimeZone } from "@/lib/calendar/dates";
import {
  ReminderAgent,
  type ReminderAgentSettings,
  type ReminderCoverResult,
  type ReminderSource,
} from "@/lib/calendar/notifications/agent";
import {
  type CalendarActionPayload,
  DESKTOP_CALENDAR_EVENTS,
  type OpenEventPayload,
  type ReminderBridge,
} from "@/lib/calendar/notifications/bridge";
import {
  getCalendarClient,
  OfflineCalendarClient,
  openCalendarOffline,
} from "@/lib/calendar/offline";
import { openCalendarEvent, toCalendarEventTarget } from "@/lib/calendar/route";
import { canRespondTo } from "@/lib/calendar/rsvp";
import { isDesktopApp, listenDesktop } from "@/lib/desktop/app";
import { subscribeEvents } from "@/lib/events";
import { isNativeApp } from "@/lib/native/app";
import {
  calendarNotificationsEnabled,
  currentNotificationStatus,
  onCalendarNotificationsChange,
  onNotificationStatusChange,
  parseCalendarEvent,
  setCalendarHandledElsewhere,
  showCalendarNotification,
} from "@/lib/notifications";
import { deviceId } from "@/lib/sync-status";

/**
 * 予定の通知の、端末側の仕組みの入口 (段取り 9、設計 3 章)。ログイン後の画面の土台
 * (auth-provider) から startCalendarNotifications を呼ぶ。メールの画面を開いていても動く。
 *
 * - リマインダー: 端末の橋を選び、ReminderAgent で予約する。
 *   Desktop は `@/lib/desktop/reminders`、Android は `@/lib/native/reminders`、
 *   Web は `./web-bridge` (Web Push が使えないとき = 状態が page のときだけ)。どれも動的 import。
 *   Desktop はメインウィンドウだけが予約する。
 * - 招待・変更・取り消し: SSE の calendar イベントを、Desktop と page の Web が通知で出す
 *   (Web Push・FCM が届く端末では、サービスワーカーと Android が出す)。
 * - 通知を押したとき: サービスワーカーの open-event、Desktop の desktop://open-event で予定を開く。
 *   Desktop の出欠のボタン (desktop://calendar-action) は、端末の控えから返事をする。
 * - ログアウト・利用者の切り替え・401 で clearCalendarReminders を呼び、予約を消す。
 */

type BridgeKind = "desktop" | "native" | "web";

/** 予約した利用者 (次に別の利用者が開いたとき、前の利用者の予約を必ず消すため)。 */
const OWNER_KEY = "calendar.reminders.owner";
/** Android の FCM の送り先 (lib/native/push.ts が保存する値)。予約の範囲の報告に使う。 */
const NATIVE_TOKEN_KEY = "mail.push-device-token";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 覚えられなくても、ログアウトのときには消す。
  }
}

function platformBridgeKind(): BridgeKind {
  if (isDesktopApp()) return "desktop";
  if (isNativeApp()) return "native";
  return "web";
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? null;
  } catch {
    return null;
  }
}

/** 橋を作る (それぞれのファイルを、使う端末でだけ読み込む)。 */
async function createBridge(kind: BridgeKind): Promise<ReminderBridge> {
  if (kind === "desktop") {
    const { createDesktopReminderBridge } = await import(
      "@/lib/desktop/reminders"
    );
    return createDesktopReminderBridge();
  }
  if (kind === "native") {
    const { createNativeReminderBridge } = await import(
      "@/lib/native/reminders"
    );
    return createNativeReminderBridge();
  }
  const { createWebReminderBridge } = await import(
    "@/lib/calendar/notifications/web-bridge"
  );
  return createWebReminderBridge(await existingRegistration());
}

/** Desktop のメインウィンドウか (メールの通知と同じく、メインウィンドウだけが出す)。 */
async function isMainDesktopWindow(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/** Agent が読む控え。OfflineCalendarClient を開いて返す。 */
async function openSource(userId: string): Promise<ReminderSource | null> {
  await openCalendarOffline(userId);
  const client = getCalendarClient();
  return client instanceof OfflineCalendarClient ? client : null;
}

/**
 * Android の予約の範囲をサーバーへ報告する。1 分に 1 回まで (続けて来たら最後の値を後で送る)。
 */
function createCoverReporter() {
  let lastAt = 0;
  let pending: ReminderCoverResult | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    timer = null;
    const report = pending;
    pending = null;
    const token = readStorage(NATIVE_TOKEN_KEY);
    if (!report || !token) return;
    lastAt = Date.now();
    void reportReminderCover({
      token,
      coverUntil: report.coverUntil,
      coverSeq: report.coverSeq,
      exact: report.exact,
    }).catch(() => {
      // 届かなければサーバーは push も送る (tag で 1 つになる)。
    });
  };
  return {
    report(result: ReminderCoverResult) {
      pending = result;
      if (timer) return;
      const wait = Math.max(
        0,
        lastAt + REMINDER_COVER_REPORT_MIN_INTERVAL_MS - Date.now(),
      );
      timer = setTimeout(send, wait);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

class CalendarNotificationRuntime {
  private stopped = false;
  private source: ReminderSource | null = null;
  private agent: ReminderAgent | null = null;
  private agentKind: BridgeKind | null = null;
  private bridge: ReminderBridge | null = null;
  private stopSse: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];
  private settings: CalendarNotificationSettings =
    DEFAULT_CALENDAR_NOTIFICATION_SETTINGS;
  private savedTimeZone = false;
  private reconciling: Promise<void> | null = null;
  private reconcileAgain = false;
  private readonly cover = createCoverReporter();

  constructor(readonly userId: string) {}

  async start(): Promise<void> {
    const owner = readStorage(OWNER_KEY);
    if (owner && owner !== this.userId) {
      await clearPlatformBridge();
      writeStorage(OWNER_KEY, null);
    }
    if (this.stopped) return;
    if (isDesktopApp() && !(await isMainDesktopWindow())) return;
    this.listenOpen();
    this.source = await openSource(this.userId);
    if (this.stopped || !this.source) return;
    this.cleanups.push(
      onNotificationStatusChange(() => this.reconcile()),
      onCalendarNotificationsChange(() => this.reconcile()),
    );
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // 旅行などでタイムゾーンが変わっていれば、ここで組み直す。
      void this.loadSettings().then(() => this.agent?.refresh());
    };
    document.addEventListener("visibilitychange", onVisible);
    this.cleanups.push(() =>
      document.removeEventListener("visibilitychange", onVisible),
    );
    await this.loadSettings();
    this.reconcile();
  }

  /** 設定画面で設定を保存したあと。 */
  refresh(): void {
    void this.loadSettings().then(() => this.agent?.refresh());
  }

  private agentSettings(): ReminderAgentSettings {
    return {
      timeZone: localTimeZone(),
      allDay: this.settings.allDay,
      detail: this.settings.detail,
    };
  }

  private async loadSettings(): Promise<void> {
    try {
      const { calendarNotifications, timeZone } =
        await getCalendarNotificationSettings();
      this.settings = calendarNotifications;
      // タイムゾーンが未設定なら、最初に開いた端末が自分のタイムゾーンを保存する (設計 6.2)。
      if (timeZone === null && !this.savedTimeZone) {
        this.savedTimeZone = true;
        await saveCalendarNotificationSettings({
          calendarNotifications,
          timeZone: localTimeZone(),
        }).catch(() => {});
      }
    } catch {
      // 読めなければ、前に読んだ値 (または標準の値) で予約する。
    }
  }

  /** 端末の設定と通知の状態に合わせて、Agent と SSE を動かす・止める。 */
  reconcile(): void {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        await this.reconcileOnce();
      } while (this.reconcileAgain && !this.stopped);
    })()
      .catch(() => {})
      .finally(() => {
        this.reconciling = null;
      });
  }

  private wantedKind(): BridgeKind | null {
    if (!calendarNotificationsEnabled()) return null;
    const kind = platformBridgeKind();
    // Web Push が届くブラウザーでは予約しない (サーバーの push に任せる)。
    if (kind === "web" && currentNotificationStatus() !== "page") return null;
    return kind;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.stopped || !this.source) return;
    const kind = this.wantedKind();
    if (kind !== this.agentKind) {
      await this.stopAgent(true);
      if (kind === null && platformBridgeKind() !== "web") {
        // 通知を切った端末に、OS の予約が残らないようにする。
        await clearPlatformBridge();
      }
      if (kind !== null && !this.stopped) {
        const bridge = await createBridge(kind);
        if (this.stopped) return;
        const agent = new ReminderAgent({
          source: this.source,
          bridge,
          settings: () => this.agentSettings(),
          onScheduled:
            kind === "native"
              ? (result) => this.cover.report(result)
              : undefined,
        });
        this.bridge = bridge;
        this.agent = agent;
        this.agentKind = kind;
        writeStorage(OWNER_KEY, this.userId);
        const started = await agent.start();
        if (kind === "native") {
          // Calendar アプリが入っている端末では none (予定の通知は Calendar アプリが受け持つ)。
          setCalendarHandledElsewhere(!started);
        }
      }
    }
    this.syncSse();
  }

  /** 招待・変更の SSE を受けるか (Desktop と、page の Web)。 */
  private syncSse(): void {
    const kind = platformBridgeKind();
    const wanted =
      !this.stopped &&
      calendarNotificationsEnabled() &&
      (kind === "desktop" ||
        (kind === "web" && currentNotificationStatus() === "page"));
    if (wanted && !this.stopSse) {
      this.stopSse = subscribeEvents(
        (event) => {
          if (event.event !== "calendar") return;
          for (const message of parseCalendarEvent(event.data)) {
            void showCalendarNotification(message, (eventId) =>
              this.canRespond(eventId),
            );
          }
        },
        { deviceId: deviceId() },
      );
    } else if (!wanted && this.stopSse) {
      this.stopSse();
      this.stopSse = null;
    }
  }

  /** 通知から出欠を返してよい予定か (Desktop のボタン)。 */
  private canRespond(eventId: string): boolean {
    const snapshot = this.source?.reminderSnapshot();
    const event = snapshot?.events.find((item) => item.id === eventId);
    if (!event || event.status === "cancelled") return false;
    const calendar = snapshot?.calendars.find(
      (item) => item.id === event.calendarId,
    );
    return !!calendar && !calendar.readOnly && canRespondTo(event, calendar);
  }

  /** 通知を押したとき・出欠のボタンを押したときの知らせを受ける。 */
  private listenOpen(): void {
    if (isDesktopApp()) {
      this.cleanups.push(
        listenDesktop<OpenEventPayload>(
          DESKTOP_CALENDAR_EVENTS.openEvent,
          (payload) =>
            openCalendarEvent(
              toCalendarEventTarget(payload?.eventId, payload?.recurrenceId),
            ),
        ),
        listenDesktop<CalendarActionPayload>(
          DESKTOP_CALENDAR_EVENTS.calendarAction,
          (payload) => this.respondFromNotification(payload),
        ),
      );
      return;
    }
    if (isNativeApp()) {
      // Android: 通知を押すと jp.lunaproject.orbit.mail://calendar/events/<id>?o=<回> で開く
      // (起動中は appUrlOpen、通知から起動したときは getLaunchUrl)。
      let cancelled = false;
      let remove: (() => void) | null = null;
      void import("@/lib/native/reminders").then(
        ({ listenNativeCalendarOpen }) => {
          const stop = listenNativeCalendarOpen((message) => {
            if (message.type === "open-event") {
              openCalendarEvent(
                toCalendarEventTarget(message.eventId, message.recurrenceId),
              );
            } else {
              openCalendarEvent(null);
            }
          });
          if (cancelled) stop();
          else remove = stop;
        },
      );
      this.cleanups.push(() => {
        cancelled = true;
        remove?.();
      });
      return;
    }
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        eventId?: unknown;
        recurrenceId?: unknown;
      } | null;
      if (data?.type === "open-event") {
        openCalendarEvent(
          toCalendarEventTarget(data.eventId, data.recurrenceId),
        );
      } else if (data?.type === "open-calendar") {
        openCalendarEvent(null);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    this.cleanups.push(() =>
      navigator.serviceWorker.removeEventListener("message", onMessage),
    );
  }

  private respondFromNotification(payload: CalendarActionPayload | null) {
    const target = toCalendarEventTarget(payload?.eventId, null);
    const status: unknown = payload?.status;
    if (
      !target ||
      (status !== "accepted" && status !== "tentative" && status !== "declined")
    ) {
      return;
    }
    const client = getCalendarClient();
    const event = this.source
      ?.reminderSnapshot()
      ?.events.find((item) => item.id === target.eventId);
    try {
      if (!client || !event) throw new Error("not found");
      // オフラインなら送信待ちに積まれ、届くようになったら送られる。
      client.respond(target.eventId, status as RsvpStatus);
    } catch {
      const text = rsvpFailedText(event?.summary ?? null);
      void showCalendarNotification({
        kind: "event-update",
        ...text,
        tag: `cal-rsvp-failed:${target.eventId}`,
        eventId: target.eventId,
      });
    }
  }

  private async stopAgent(clear: boolean): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    this.agentKind = null;
    this.bridge = null;
    this.cover.stop();
    if (!agent) return;
    if (clear) await agent.clear().catch(() => {});
    else agent.stop();
  }

  /** 止める (予約は残す)。 */
  stop(): void {
    this.stopped = true;
    void this.stopAgent(false);
    this.stopSse?.();
    this.stopSse = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** 止めて、予約を消す。 */
  async clear(): Promise<void> {
    this.stopped = true;
    const hadBridge = this.bridge !== null;
    await this.stopAgent(true);
    this.stopSse?.();
    this.stopSse = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (!hadBridge) await clearPlatformBridge();
  }
}

/** Desktop・Android の OS に残った予約を消す (Web は画面を閉じれば消えるので何もしない)。 */
async function clearPlatformBridge(): Promise<void> {
  const kind = platformBridgeKind();
  if (kind === "web") return;
  try {
    await (await createBridge(kind)).clear();
  } catch {
    // 消せなくても、ログアウトは続ける。
  }
}

let runtime: CalendarNotificationRuntime | null = null;

/**
 * ログインした利用者の予定の通知を動かす。戻り値の関数で止める (予約は残す)。
 * 同じ利用者で動いていれば、それを使い続ける。
 */
export function startCalendarNotifications(userId: string): () => void {
  if (typeof window === "undefined") return () => {};
  if (runtime && runtime.userId !== userId) {
    runtime.stop();
    runtime = null;
  }
  if (!runtime) {
    const current = new CalendarNotificationRuntime(userId);
    runtime = current;
    void current.start().catch(() => {});
  }
  const mine = runtime;
  return () => {
    if (runtime !== mine) return;
    runtime = null;
    mine.stop();
  };
}

/** 設定 (終日の通知・内容を出すか) を保存したあとに呼ぶ。読み直して組み直す。 */
export function refreshCalendarNotifications(): void {
  runtime?.refresh();
}

/**
 * ログアウト・401・利用者の切り替えで呼ぶ。予約を消し、通知の仕組みを止める
 * (OS に残った予約が次の利用者に出ないようにする。設計 7 章の 2)。
 */
export async function clearCalendarReminders(): Promise<void> {
  const current = runtime;
  runtime = null;
  writeStorage(OWNER_KEY, null);
  if (current) await current.clear();
  else await clearPlatformBridge();
}
