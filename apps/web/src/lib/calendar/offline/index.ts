import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Calendar, EventRange } from "@/lib/calendar/api";
import * as calendarApi from "@/lib/calendar/api";
import {
  type ClientApi,
  OfflineCalendarClient,
} from "@/lib/calendar/offline/client";
import { createBrowserShare } from "@/lib/calendar/offline/share";
import {
  deleteCalendarStore,
  openCalendarStore,
} from "@/lib/calendar/offline/store";
import type {
  CalendarClient,
  ConflictItem,
  EventRangeQuery,
  QueuedOp,
} from "@/lib/calendar/offline/types";
import { subscribeEvents } from "@/lib/events";
import { isOnline, subscribeOnline } from "@/lib/offline/network";
import type { LocalStore } from "@/lib/offline/store";

/**
 * カレンダーのオフライン対応の入口。ログインした利用者ごとに CalendarClient を 1 つ開き、
 * ログアウトで保存先ごと消す (401 では消さない。預かった変更を失わないため)。
 *
 * 画面は useCalendarClient() / useCalendarData(range) で読み、client の関数で書く。
 */

export {
  OfflineCalendarClient,
  OfflineUnavailableError,
} from "@/lib/calendar/offline/client";
export { isHeld } from "@/lib/calendar/offline/queue";
export type * from "@/lib/calendar/offline/types";

const api: ClientApi = {
  createEvent: calendarApi.createEvent,
  updateEvent: calendarApi.updateEvent,
  updateOccurrence: calendarApi.updateOccurrence,
  deleteEvent: calendarApi.deleteEvent,
  deleteOccurrence: calendarApi.deleteOccurrence,
  respondToEvent: calendarApi.respondToEvent,
  updateCalendar: calendarApi.updateCalendar,
  listCalendars: calendarApi.listCalendars,
  listEvents: calendarApi.listEvents,
  searchEvents: calendarApi.searchEvents,
  syncCalendars: calendarApi.syncCalendars,
  listConflicts: calendarApi.listConflicts,
  dismissConflict: calendarApi.dismissConflict,
  retryConflict: calendarApi.retryConflict,
  resendInvite: calendarApi.resendInvite,
};

/** SSE の change をまとめる時間 (いまの画面と同じ)。 */
const CHANGE_DEBOUNCE_MS = 300;

/**
 * 画面が開いている間だけ動かすきっかけ: SSE の change、タブが見える状態に戻ったとき。
 * (SSE の接続は画面ごとに張られるので、カレンダーの画面が無いときは張らない。)
 */
function browserTriggers(client: OfflineCalendarClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe =
    typeof window === "undefined"
      ? () => {}
      : subscribeEvents((event) => {
          if (event.event !== "change") return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void client.pull(), CHANGE_DEBOUNCE_MS);
        });
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    // BroadcastChannel が無い環境でも、前面に戻ったら保存先から読み直す。
    void client
      .reloadFromStore()
      .then(() => client.pull())
      .then(() => client.flush());
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

type Session = {
  userId: string;
  client: OfflineCalendarClient;
  store: LocalStore;
  close: () => void;
};

let session: Promise<Session | null> | null = null;
let sessionUserId: string | null = null;
/** 開くたびに増やす (開いている途中で閉じられたかを見分ける)。 */
let generation = 0;
let currentClient: OfflineCalendarClient | null = null;
const clientListeners = new Set<() => void>();

function setCurrent(client: OfflineCalendarClient | null) {
  currentClient = client;
  for (const listener of clientListeners) listener();
}

/** ログインした利用者の保存先を開く。同じ利用者で開いていれば、何もしない。 */
export function openCalendarOffline(
  userId: string,
  createStore: (userId: string) => Promise<LocalStore> = openCalendarStore,
): Promise<void> {
  if (session && sessionUserId === userId) return session.then(() => {});
  closeCalendarOffline();
  sessionUserId = userId;
  const mine = ++generation;
  const opening = (async (): Promise<Session | null> => {
    const store = await createStore(userId);
    const share = createBrowserShare(userId);
    let client: OfflineCalendarClient;
    try {
      client = await OfflineCalendarClient.open({
        userId,
        store,
        api,
        share,
        isOnline,
        triggers: browserTriggers,
      });
    } catch {
      share.close();
      store.close();
      return null;
    }
    const unsubscribeOnline = subscribeOnline(() => {
      if (isOnline()) client.onOnline();
    });
    // 開いている間に別の利用者に切り替わっていたら、使わずに閉じる。
    if (generation !== mine) {
      unsubscribeOnline();
      client.close();
      share.close();
      store.close();
      return null;
    }
    setCurrent(client);
    return {
      userId,
      client,
      store,
      close: () => {
        unsubscribeOnline();
        client.close();
        share.close();
        store.close();
      },
    };
  })().catch(() => null);
  session = opening;
  return opening.then(() => {});
}

/** 保存先を閉じる (内容は残る)。 */
export function closeCalendarOffline(): void {
  generation += 1;
  const closing = session;
  session = null;
  sessionUserId = null;
  if (currentClient) setCurrent(null);
  void closing?.then((current) => current?.close()).catch(() => {});
}

/** 利用者の保存先を消す (ログアウトしたとき)。 */
export async function clearCalendarOffline(userId: string): Promise<void> {
  const closing = session;
  closeCalendarOffline();
  await closing?.catch(() => {});
  await deleteCalendarStore(userId);
}

/** 開いている CalendarClient。開く前とログアウト後は null。 */
export function getCalendarClient(): CalendarClient | null {
  return currentClient;
}

function subscribeClient(listener: () => void): () => void {
  clientListeners.add(listener);
  return () => clientListeners.delete(listener);
}

/** 開いている CalendarClient。開くまでは null (開いたら描画し直す)。 */
export function useCalendarClient(): CalendarClient | null {
  return useSyncExternalStore(
    subscribeClient,
    () => currentClient,
    () => null,
  );
}

const noop = () => () => {};
const nothing = () => null;
const no = () => false;
const noQueue: QueuedOp[] = [];
const noConflicts: ConflictItem[] = [];

export type CalendarData = {
  client: CalendarClient | null;
  calendars: Calendar[] | null;
  /** 期間内の予定と回。まだ分からなければ null。 */
  data: EventRange | null;
  queue: QueuedOp[];
  conflicts: ConflictItem[];
  /** 端末の保存先に書けなかった変更がある (「保存できませんでした」を出す)。 */
  storageFailed: boolean;
};

/**
 * 画面の読み込み (1 章の useCalendarData)。client の中身が変わると描画し直す。
 * range が null なら期間の予定は読まない。
 */
export function useCalendarData(
  range: EventRangeQuery | null,
  client: CalendarClient | null = null,
): CalendarData {
  const opened = useCalendarClient();
  const active = client ?? opened;
  // 描画ごとに購読し直さないよう、client が変わったときだけ作り直す
  // (購読が 0 になると、client は SSE などのきっかけを止めてしまう)。
  const subscribe = useMemo(
    () =>
      active ? (listener: () => void) => active.subscribe(listener) : noop,
    [active],
  );
  const from = range?.from;
  const to = range?.to;
  const timeZone = range?.timeZone;
  const readRange = useCallback(
    () =>
      active && from && to && timeZone
        ? active.range({ from, to, timeZone })
        : null,
    [active, from, to, timeZone],
  );
  const calendars = useSyncExternalStore(
    subscribe,
    active ? () => active.calendars() : nothing,
    nothing,
  );
  const data = useSyncExternalStore(subscribe, readRange, nothing);
  const queue = useSyncExternalStore(
    subscribe,
    active ? () => active.queue() : () => noQueue,
    () => noQueue,
  );
  const conflicts = useSyncExternalStore(
    subscribe,
    active ? () => active.conflicts() : () => noConflicts,
    () => noConflicts,
  );
  const storageFailed = useSyncExternalStore(
    subscribe,
    active ? () => active.storageFailed() : no,
    no,
  );
  return { client: active, calendars, data, queue, conflicts, storageFailed };
}
