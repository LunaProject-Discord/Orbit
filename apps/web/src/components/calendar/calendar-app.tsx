"use client";

import { inviteRole } from "@orbit/core/event-invite";
import { cn } from "cn";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Temporal } from "temporal-polyfill";
import {
  AddCalendarDialog,
  type AddCalendarInput,
} from "@/components/calendar/add-calendar-dialog";
import { AgendaList } from "@/components/calendar/agenda-list";
import { CalendarSidebar } from "@/components/calendar/calendar-sidebar";
import { calendarColor } from "@/components/calendar/colors";
import {
  type ConflictBusy,
  ConflictList,
  ConflictsButton,
} from "@/components/calendar/conflict-list";
import { useDeleteUndo } from "@/components/calendar/delete-undo";
import { EventDetail } from "@/components/calendar/event-detail";
import { EventEditor } from "@/components/calendar/event-editor";
import { ImipSenderDialog } from "@/components/calendar/imip-sender-dialog";
import { MobileMonth } from "@/components/calendar/mobile-month";
import { MonthGrid } from "@/components/calendar/month-grid";
import type { RsvpChoice } from "@/components/calendar/rsvp-buttons";
import {
  type ChangeScope,
  ScopeDialog,
} from "@/components/calendar/scope-dialog";
import { SearchResults } from "@/components/calendar/search-results";
import { TimeGrid } from "@/components/calendar/time-grid";
import type { DisplayItem, SelectHandler } from "@/components/calendar/types";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { NOTICE_MS, showNotice } from "@/components/mail/toasts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type Account, ApiError, NetworkError, type User } from "@/lib/api";
import { navigateApp } from "@/lib/app-navigation";
import {
  type Calendar,
  type CalendarEvent,
  calendarScheduling,
  createCaldavAccount,
  createCalendar,
  deleteCalendar,
  type EventFields,
  refreshCalendar,
  subscribeCalendar,
  updateCalendar,
} from "@/lib/calendar/api";
import {
  calendarSyncStatus,
  conflictActionLabel,
  conflictMessage,
  conflictSummary,
  pendingState,
} from "@/lib/calendar/conflict-labels";
import {
  type CalendarView,
  daysBetween,
  localTimeZone,
  shiftDate,
  shortMonthTitle,
  todayIn,
  toLocal,
  viewRange,
  viewTitle,
} from "@/lib/calendar/dates";
import {
  attendeeEditableChanges,
  type EventForm,
  eventFormOf,
  formChanges,
  newEventForm,
  shiftMasterTime,
} from "@/lib/calendar/event-form";
import { groupCalendars } from "@/lib/calendar/groups";
import {
  type CalendarClient,
  type ConflictAction,
  type ConflictItem,
  isHeld,
  OfflineCalendarClient,
  OfflineUnavailableError,
  type QueuedOp,
  useCalendarData,
} from "@/lib/calendar/offline";
import {
  findOpeningItem,
  nextOpeningStep,
  type OpeningEvent,
  sameRecurrenceId,
} from "@/lib/calendar/open-event";
import {
  buildCalendarRoute,
  type CalendarEventTarget,
  OPEN_CALENDAR_EVENT,
  parseCalendarEventRoute,
  parseCalendarRoute,
} from "@/lib/calendar/route";
import { canRespondTo } from "@/lib/calendar/rsvp";
import { listAccounts, useOnline } from "@/lib/offline";
import { useMediaQuery } from "@/lib/use-media-query";
import { randomUuid } from "@/lib/uuid";

const DESKTOP_VIEWS: { view: CalendarView; label: string }[] = [
  { view: "day", label: "日" },
  { view: "week", label: "週" },
  { view: "month", label: "月" },
  { view: "agenda", label: "予定一覧" },
];
const MOBILE_VIEWS: { view: CalendarView; label: string }[] = [
  { view: "day", label: "日" },
  { view: "3day", label: "3 日" },
  { view: "month", label: "月" },
  { view: "agenda", label: "一覧" },
];

const SAVE_ERROR = "保存できませんでした。もう一度お試しください。";
const OFFLINE_SAVE_ERROR =
  "接続していないので保存できません。接続してからもう一度お試しください。";
const STORAGE_ERROR =
  "変更を端末に保存できませんでした。送り終わるまで、このタブを閉じないでください。";
const CONFLICT_TOAST = "calendar-conflict";
const SIDEBAR_KEY = "orbit.calendar.sidebar";

function readSidebarPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

type EditorState = {
  title: string;
  form: EventForm;
  /** 編集中の回。新しい予定なら null。 */
  item: DisplayItem | null;
};

/** Orbit Calendar の画面。 */
export function CalendarApp({ user }: { user: User }) {
  const timeZone = useMemo(() => localTimeZone(), []);
  const wide = useMediaQuery("(min-width: 1024px)");
  const medium = useMediaQuery("(min-width: 768px)");
  const [now, setNow] = useState(() => Temporal.Now.zonedDateTimeISO(timeZone));
  const today = now.toPlainDate();

  const initialRoute = useMemo(
    () => parseCalendarRoute(window.location.pathname),
    [],
  );
  const [view, setView] = useState<CalendarView | null>(initialRoute.view);
  const [date, setDate] = useState<Temporal.PlainDate>(
    () => initialRoute.date ?? todayIn(timeZone),
  );
  // 広い画面では 3 日を週に、狭い画面では週を 3 日にして見せる。
  const shownView: CalendarView = (() => {
    const chosen = view ?? (medium ? "week" : "3day");
    if (medium && chosen === "3day") return "week";
    if (!medium && chosen === "week") return "3day";
    return chosen;
  })();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarShown, setSidebarShown] = useState(true);
  const [selected, setSelected] = useState<{
    item: DisplayItem;
    anchor: HTMLElement;
  } | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 確認してから消す予定 (decline: 不参加で返事をして削除。organizer: 参加者に取り消しが届く)。 */
  const [confirmDelete, setConfirmDelete] = useState<{
    item: DisplayItem;
    mode: "decline" | "organizer";
  } | null>(null);
  const [scope, setScope] = useState<
    | { action: "save"; form: EventForm; item: DisplayItem }
    | { action: "delete"; item: DisplayItem }
    | null
  >(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Calendar | null>(null);
  /** 「招待メールの送信元」を開いているカレンダー。 */
  const [senderCalendar, setSenderCalendar] = useState<Calendar | null>(null);
  const [senderBusy, setSenderBusy] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CalendarEvent[] | null>(null);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictBusy, setConflictBusy] = useState<ConflictBusy>(null);
  const online = useOnline();
  /**
   * 通知から開く予定 (/calendar/events/<ID>?o=<回>、段取り 9)。控えから探して日付を移し
   * (located)、表示中の回が出たら詳細を開く。控えに無ければ pull してから探し、無ければ閉じる。
   */
  const [opening, setOpening] = useState<OpeningEvent | null>(() =>
    parseCalendarEventRoute(window.location.pathname, window.location.search),
  );
  /** URL から開いた詳細の位置 (押した予定の要素が無いので、画面の中ほどに置く)。 */
  const openAnchorRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    setSidebarShown(readSidebarPreference());
  }, []);
  const toggleSidebar = () => {
    setSidebarShown((current) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, current ? "closed" : "open");
      } catch {
        // 保存できなくても、この画面の間は切り替わる。
      }
      return !current;
    });
  };

  // 今の時刻の線を 1 分ごとに動かす。
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Temporal.Now.zonedDateTimeISO(timeZone)),
      60_000,
    );
    return () => clearInterval(timer);
  }, [timeZone]);

  // 表示と日付を URL に残す (再読み込みやブックマークで同じ表示に戻れるように)。
  useEffect(() => {
    const path = buildCalendarRoute(shownView, date);
    if (window.location.pathname !== path) {
      window.history.replaceState(window.history.state, "", path);
    }
  }, [shownView, date]);
  useEffect(() => {
    const onPopState = () => {
      const target = parseCalendarEventRoute(
        window.location.pathname,
        window.location.search,
      );
      if (target) {
        setOpening(target);
        return;
      }
      const route = parseCalendarRoute(window.location.pathname);
      if (route.view) setView(route.view);
      if (route.date) setDate(route.date);
    };
    // 通知を押した (カレンダーの画面を開いているとき)。
    const onOpenEvent = (event: Event) => {
      const target = (event as CustomEvent<CalendarEventTarget>).detail;
      if (target) setOpening({ ...target });
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener(OPEN_CALENDAR_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(OPEN_CALENDAR_EVENT, onOpenEvent);
    };
  }, []);

  const range = useMemo(() => viewRange(shownView, date), [shownView, date]);

  // 読み書きは端末の控え (CalendarClient) を通す。サーバーとの同期、SSE、
  // 送信待ちは client が受け持つ (ここで SSE を張ると接続が 2 本になる)。
  const rangeQuery = useMemo(
    () => ({
      from: range.from.toString(),
      to: range.to.toString(),
      timeZone,
    }),
    [range, timeZone],
  );
  const { client, calendars, data, queue, conflicts, storageFailed } =
    useCalendarData(rangeQuery);

  // 端末に書けなかった (容量不足など)。送信待ちはこのタブのメモリーにしか無い。
  useEffect(() => {
    if (storageFailed) showNotice(STORAGE_ERROR);
  }, [storageFailed]);

  // アカウントの一覧 (サイドバーの見出し)。メールの端末の控えから読む。
  // カレンダーが変わったら (アカウントの追加など) 読み直す。
  useEffect(() => {
    if (calendars === null) return;
    const controller = new AbortController();
    listAccounts(controller.signal)
      .then(setAccounts)
      .catch(() => {});
    return () => controller.abort();
  }, [calendars]);

  // 通知から開く予定を控えから探し、その日へ移る。
  // biome-ignore lint/correctness/useExhaustiveDependencies: data は控えが変わった (同期が進んだ) ときに探し直すため
  useEffect(() => {
    if (!opening || opening.located || opening.pulling || !client) return;
    if (!(client instanceof OfflineCalendarClient)) {
      setOpening(null);
      return;
    }
    const step = nextOpeningStep(
      opening,
      client.reminderSnapshot(),
      calendars !== null,
      timeZone,
    );
    if (step.type === "wait") return;
    if (step.type === "close") {
      // 見つからなければ、カレンダーを開いたままにする。
      setOpening(null);
      return;
    }
    if (step.type === "pull") {
      setOpening({ ...opening, pulling: true });
      void client
        .pull()
        .finally(() =>
          setOpening((current) =>
            current?.eventId === opening.eventId
              ? { ...current, pulling: false, pulled: true }
              : current,
          ),
        );
      return;
    }
    setSelected(null);
    setDate(step.day);
    setOpening({
      ...opening,
      located: true,
      day: step.day,
      masterId: step.masterId,
    });
  }, [opening, client, calendars, data, timeZone]);

  /** 作ったカレンダーなどを、SSE を待たずに取り込む。 */
  const pullNow = useCallback(() => {
    if (client instanceof OfflineCalendarClient) void client.pull();
  }, [client]);

  const calendarIndex = useMemo(() => {
    const map = new Map<string, { calendar: Calendar; index: number }>();
    for (const [index, calendar] of (calendars ?? []).entries()) {
      map.set(calendar.id, { calendar, index });
    }
    return map;
  }, [calendars]);
  const colorOf = useCallback(
    (calendar: Calendar) =>
      calendarColor(calendar, calendarIndex.get(calendar.id)?.index ?? 0),
    [calendarIndex],
  );
  const groups = useMemo(
    () => groupCalendars(calendars ?? [], accounts),
    [calendars, accounts],
  );
  const writable = useMemo(
    () => (calendars ?? []).filter((calendar) => !calendar.readOnly),
    [calendars],
  );

  const eventsById = useMemo(
    () => new Map((data?.events ?? []).map((event) => [event.id, event])),
    [data],
  );
  const items = useMemo<DisplayItem[]>(() => {
    if (!data) return [];
    const result: DisplayItem[] = [];
    for (const occurrence of data.occurrences) {
      const event = eventsById.get(occurrence.eventId);
      const master = eventsById.get(occurrence.masterId);
      if (!event) continue;
      const entry = calendarIndex.get(event.calendarId);
      if (entry && !entry.calendar.visible) continue;
      const local = toLocal(occurrence, timeZone);
      if (!local) continue;
      result.push({
        key: `${occurrence.eventId}:${occurrence.recurrenceId ?? ""}`,
        local,
        event,
        color: calendarColor(entry?.calendar, entry?.index ?? 0),
        pending: event.attendees.some(
          (attendee) => attendee.self && attendee.status === "needs_action",
        ),
        declined: event.attendees.some(
          (attendee) => attendee.self && attendee.status === "declined",
        ),
        repeating:
          occurrence.recurrenceId !== null &&
          Boolean(master?.rrule || master?.rdates.length),
        readOnly: entry?.calendar.readOnly ?? true,
      });
    }
    return result;
  }, [data, eventsById, calendarIndex, timeZone]);

  // 移った日の回が表示に出たら、詳細を開く。
  useEffect(() => {
    if (!opening?.located || !opening.day || !data) return;
    if (
      Temporal.PlainDate.compare(opening.day, range.from) < 0 ||
      Temporal.PlainDate.compare(opening.day, range.to) >= 0
    ) {
      return;
    }
    const item = findOpeningItem(opening, items);
    setOpening(null);
    if (window.location.pathname.startsWith("/calendar/events/")) {
      window.history.replaceState(
        window.history.state,
        "",
        buildCalendarRoute(shownView, opening.day),
      );
    }
    const anchor = openAnchorRef.current;
    if (item && anchor) setSelected({ item, anchor });
  }, [opening, data, items, range, shownView]);

  const holidays = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (
        calendarIndex.get(item.event.calendarId)?.calendar.source !== "holidays"
      )
        continue;
      for (
        let day = item.local.firstDay;
        Temporal.PlainDate.compare(day, item.local.lastDay) <= 0;
        day = day.add({ days: 1 })
      ) {
        set.add(day.toString());
      }
    }
    return set;
  }, [items, calendarIndex]);
  const busyDays = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) set.add(item.local.firstDay.toString());
    return set;
  }, [items]);

  const goTo = (next: Temporal.PlainDate, nextView?: CalendarView) => {
    setSelected(null);
    setDate(next);
    if (nextView) setView(nextView);
  };
  const changeView = (next: CalendarView) => {
    setSelected(null);
    setView(next);
  };

  const onSelect: SelectHandler = (item, anchor) => {
    setSelected({ item, anchor });
  };

  const defaultCalendarId = () => {
    const visible = writable.find((calendar) => calendar.visible);
    return (visible ?? writable[0])?.id ?? null;
  };

  const openCreate = (day: Temporal.PlainDate, minutes: number | null) => {
    const calendarId = defaultCalendarId();
    if (!calendarId) {
      setAddOpen(true);
      return;
    }
    setSaveError(null);
    setSidebarOpen(false);
    setEditor({
      title: "予定を作成",
      item: null,
      form: newEventForm({ calendarId, date: day, minutes, timeZone }),
    });
  };
  const openEdit = (item: DisplayItem) => {
    setSelected(null);
    setSaveError(null);
    setEditor({
      title: "予定を編集",
      item,
      form: eventFormOf(item.event, item.local),
    });
  };

  const masterOf = (item: DisplayItem): CalendarEvent | undefined =>
    item.event.parentId ? eventsById.get(item.event.parentId) : item.event;

  /**
   * 表示中の同じ回 (原本と recurrenceId で探す)。送り終えると仮の例外の ID が
   * サーバーの ID に替わるので、開いたときの item の ID は使わない。
   */
  const currentItem = useCallback(
    (item: DisplayItem): DisplayItem | null =>
      items.find((other) => sameOccurrence(other, item)) ?? null,
    [items],
  );

  const save = (form: EventForm, chosen: ChangeScope | null) => {
    if (!editor) return;
    if (!client) {
      setSaveError(SAVE_ERROR);
      return;
    }
    const opened = editor.item;
    const item = opened ? (currentItem(opened) ?? opened) : null;
    setSaveError(null);
    try {
      if (!opened || !item) {
        const fields = formChanges(form, timeZone, null);
        if (!fields?.time) throw new Error("invalid");
        client.createEvent({
          ...fields,
          time: fields.time,
          id: randomUuid(),
          calendarId: form.calendarId,
        });
      } else {
        // 開いたときの値と比べて、変えた項目だけを送る (ほかの端末の変更を上書きしない)。
        const before = eventFormOf(opened.event, opened.local);
        const formed = formChanges(form, timeZone, before);
        if (!formed) throw new Error("invalid");
        // 招待された予定は、通知と予定あり / 空きだけを送る (10 章の 2)。
        const changes =
          inviteRole(opened.event) === "attendee"
            ? attendeeEditableChanges(formed)
            : formed;
        if (Object.keys(changes).length > 0) {
          const recurrenceId = itemRecurrenceId(item);
          if (item.repeating && chosen === null) {
            setScope({ action: "save", form, item });
            return;
          }
          if (item.repeating && chosen === "this" && recurrenceId) {
            const { recurrence: _ignored, ...rest } = changes;
            const masterId = item.event.parentId ?? item.event.id;
            client.updateOccurrence(masterId, recurrenceId, rest);
          } else if (item.repeating && chosen === "all") {
            const master = masterOf(item);
            if (!master) throw new Error("master");
            const forMaster: EventFields = { ...changes };
            if (changes.time) {
              forMaster.time = shiftMasterTime(
                master,
                item.local,
                changes.time,
              );
            }
            client.updateEvent(master.id, forMaster);
          } else {
            client.updateEvent(item.event.id, changes);
          }
        }
      }
      // 保存を待たずに閉じる (表示はその場で変わり、送信待ちから順に送られる)。
      setEditor(null);
    } catch (error) {
      setSaveError(writeFailure(error));
    }
  };

  // 削除の「元に戻す」(Mail の削除と同じトースト・時間)。
  const deleteWithUndo = useDeleteUndo();

  const remove = (target: DisplayItem, chosen: ChangeScope | null) => {
    const item = currentItem(target) ?? target;
    if (item.repeating && chosen === null) {
      setScope({ action: "delete", item });
      return;
    }
    setSelected(null);
    if (!client) {
      showNotice("削除できませんでした。もう一度お試しください。");
      return;
    }
    try {
      deleteWithUndo(
        client,
        item.repeating && chosen === "this"
          ? "この回を削除しました"
          : item.repeating && chosen === "all"
            ? "すべての回を削除しました"
            : "予定を削除しました",
        undoFailure(item, calendarOf(item.event.calendarId)),
        () => {
          if (item.repeating && chosen === "this") {
            const recurrenceId = itemRecurrenceId(item);
            const masterId = item.event.parentId ?? item.event.id;
            if (recurrenceId) client.deleteOccurrence(masterId, recurrenceId);
          } else if (item.repeating && chosen === "all") {
            client.deleteEvent(item.event.parentId ?? item.event.id);
          } else {
            client.deleteEvent(item.event.id);
          }
        },
      );
    } catch (error) {
      showNotice(
        error instanceof OfflineUnavailableError
          ? "接続していないので削除できません。"
          : "削除できませんでした。もう一度お試しください。",
      );
    }
  };

  /**
   * 削除のボタン。招待された予定は「不参加で返事をして削除」の 1 つの操作にし (10 章の 3)、
   * 参加者のいる自分の予定は、取り消しの連絡が届くことを確かめてから消す。
   */
  const requestDelete = (target: DisplayItem) => {
    const item = currentItem(target) ?? target;
    const role = inviteRole(item.event);
    const calendar = calendarIndex.get(item.event.calendarId)?.calendar;
    // 返事を送れる招待だけ「不参加にして削除」。古いサーバー (scheduling が無い) と、
    // self がアカウントの持ち主でない共有カレンダーでは、ふつうの削除にする。
    if (role === "attendee" && canRespondTo(item.event, calendar, accounts)) {
      setConfirmDelete({ item, mode: "decline" });
      return;
    }
    if (
      role === "organizer" &&
      !item.repeating &&
      calendarScheduling(calendar) !== "none" &&
      item.event.attendees.some((attendee) => !attendee.self)
    ) {
      setConfirmDelete({ item, mode: "organizer" });
      return;
    }
    remove(item, null);
  };

  /** 不参加で返事をしてから消す。返事は消す前に積む (送信待ちは返事を捨てない)。 */
  const declineAndRemove = (target: DisplayItem) => {
    const item = currentItem(target) ?? target;
    setSelected(null);
    if (!client) {
      showNotice("削除できませんでした。もう一度お試しください。");
      return;
    }
    try {
      // 返事も削除と一緒に待たせる (元に戻すと、まだ送っていない返事も取り消す)。
      deleteWithUndo(
        client,
        "不参加にして削除しました",
        "すでに不参加の返事を送ったため、元に戻せませんでした。",
        () => {
          client.respond(item.event.id, "declined");
          const recurrenceId = itemRecurrenceId(item);
          if (item.event.parentId && recurrenceId) {
            // 例外の行 (この回だけ招待が変わったもの) は、その回だけを消す。
            client.deleteOccurrence(item.event.parentId, recurrenceId);
          } else {
            client.deleteEvent(item.event.id);
          }
        },
      );
    } catch (error) {
      showNotice(
        error instanceof OfflineUnavailableError
          ? "接続していないので削除できません。"
          : "削除できませんでした。もう一度お試しください。",
      );
    }
  };

  const respond = (item: DisplayItem, status: RsvpChoice) => {
    if (!client) {
      showNotice("返事を送れませんでした。もう一度お試しください。");
      return;
    }
    try {
      client.respond((currentItem(item) ?? item).event.id, status);
    } catch (error) {
      showNotice(
        error instanceof OfflineUnavailableError
          ? "接続していないので返事を送れません。"
          : "返事を送れませんでした。もう一度お試しください。",
      );
    }
  };

  const toggleCalendar = (calendar: Calendar) => {
    try {
      client?.updateCalendar(calendar.id, { visible: !calendar.visible });
    } catch {
      showNotice("表示を切り替えられませんでした。");
    }
  };

  const addCalendar = async (input: AddCalendarInput) => {
    setAddBusy(true);
    setAddError(null);
    try {
      if (input.kind === "caldav") {
        // アカウントを足すだけ。カレンダーは同期ワーカーが取り込み、変更の通知で現れる。
        const { merged } = await createCaldavAccount(
          input.service === "icloud"
            ? {
                provider: "icloud",
                appleId: input.username,
                password: input.password,
              }
            : {
                provider: "generic",
                url: input.url,
                username: input.username,
                password: input.password,
              },
        );
        setAddOpen(false);
        showNotice(
          merged
            ? "iCloud のメールのアカウントで、カレンダーの同期を始めました。"
            : "アカウントを追加しました。カレンダーを同期しています。",
          "info",
        );
        pullNow();
        return;
      }
      await (input.kind === "local"
        ? await createCalendar({
            name: input.name,
            color: input.color,
            timeZone,
          })
        : await subscribeCalendar({
            url: input.url,
            name: input.name || undefined,
            color: input.color,
            timeZone,
          }));
      setAddOpen(false);
      pullNow();
    } catch (error) {
      setAddError(addFailure(error));
    } finally {
      setAddBusy(false);
    }
  };

  const openSenderSetting = (calendar: Calendar) => {
    setSidebarOpen(false);
    setSenderError(null);
    setSenderCalendar(calendar);
  };
  const saveSender = async (accountId: string | null) => {
    const target = senderCalendar;
    if (!target) return;
    setSenderBusy(true);
    setSenderError(null);
    try {
      await updateCalendar(target.id, { imipAccountId: accountId });
      setSenderCalendar(null);
      pullNow();
    } catch (error) {
      setSenderError(
        error instanceof ApiError && error.code === "receive_only"
          ? "このアカウントは受信専用のため、送信元にできません。"
          : error instanceof ApiError && error.code === "imip_unsupported"
            ? "このカレンダーでは送信元を選べません。"
            : error instanceof NetworkError
              ? "接続していないので保存できません。"
              : "保存できませんでした。もう一度お試しください。",
      );
    } finally {
      setSenderBusy(false);
    }
  };

  const refreshSubscription = async (calendar: Calendar) => {
    try {
      const next = await refreshCalendar(calendar.id);
      if (next.lastError) showNotice(next.lastError);
      else showNotice(`「${next.name}」を更新しました。`, "info");
      pullNow();
    } catch {
      showNotice("更新できませんでした。");
    }
  };

  const removeCalendar = async (calendar: Calendar) => {
    try {
      await deleteCalendar(calendar.id);
      pullNow();
    } catch {
      showNotice("削除できませんでした。");
    }
  };

  const runSearch = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    if (!client) return;
    try {
      // サーバーに届かなければ、client が端末の控えから探す。
      setResults(await client.search(trimmed));
    } catch {
      showNotice("検索できませんでした。");
    }
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setResults(null);
  };

  // 開いている詳細は、表示中の同じ回に持ち直す (送り終えて ID が替わっても閉じない。
  // 予定が消えたら閉じる)。
  const selectedItem = selected
    ? (currentItem(selected.item) ?? (data ? null : selected.item))
    : null;
  useEffect(() => {
    if (selected && !selectedItem) setSelected(null);
  }, [selected, selectedItem]);
  // queue が変わると client の中身も変わるので、描画ごとに数え直す (件数は少ない)。
  const selectedPending =
    selectedItem && client
      ? pendingState(pendingOf(client, selectedItem))
      : null;

  const calendarOf = useCallback(
    (id: string | null) => (id ? calendarIndex.get(id)?.calendar : undefined),
    [calendarIndex],
  );
  const syncStatus = calendarSyncStatus({
    online,
    // 「元に戻す」を受け付けている間の削除は、まだ送信待ちに数えない (Mail と同じ)。
    pending: queue.filter((op) => op.state === "pending" && !isHeld(op)).length,
    loaded: calendars !== null,
  });

  const resolveConflict = async (
    item: ConflictItem,
    action: ConflictAction,
  ) => {
    if (!client) return;
    setConflictBusy({ id: item.id, action });
    try {
      await client.resolveConflict(item.id, action);
    } catch (error) {
      showNotice(
        error instanceof NetworkError ||
          error instanceof OfflineUnavailableError
          ? "接続していないので、いまは操作できません。接続してからもう一度お試しください。"
          : error instanceof ApiError && error.code === "not_resendable"
            ? "このメールはもう送り直せません (予定が変わったか、送る相手が変わっています)。閉じてください。"
            : error instanceof ApiError && error.code === "invite_limit"
              ? "招待メールの送信数が上限に達しました。しばらくしてからもう一度お試しください。"
              : "操作できませんでした。もう一度お試しください。",
      );
    } finally {
      setConflictBusy(null);
    }
  };
  const resolveRef = useRef(resolveConflict);
  resolveRef.current = resolveConflict;
  const calendarOfRef = useRef(calendarOf);
  calendarOfRef.current = calendarOf;

  // 新しく届いた競合は、1 件につき 1 回だけトーストで知らせる
  // (開いたときに既にあったものは、一覧の件数だけで知らせる)。
  const seenConflicts = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (calendars === null) return;
    const seen = seenConflicts.current;
    if (!seen) {
      seenConflicts.current = new Set(conflicts.map((item) => item.id));
      return;
    }
    const fresh = conflicts.filter((item) => !seen.has(item.id));
    for (const item of fresh) seen.add(item.id);
    if (fresh.length === 0) return;
    const options = {
      id: CONFLICT_TOAST,
      duration: NOTICE_MS,
      closeButton: true,
    };
    const first = fresh[0];
    const primary = first?.actions.find((action) => action !== "dismiss");
    if (fresh.length === 1 && first && primary) {
      toast(conflictMessage(first, calendarOfRef.current(first.calendarId)), {
        ...options,
        action: {
          label: conflictActionLabel(first, primary),
          onClick: () => void resolveRef.current(first, primary),
        },
      });
    } else {
      toast(conflictSummary(fresh.length), {
        ...options,
        action: { label: "確認する", onClick: () => setConflictsOpen(true) },
      });
    }
  }, [conflicts, calendars]);
  const selectedCalendar = selectedItem
    ? calendarIndex.get(selectedItem.event.calendarId)?.calendar
    : undefined;
  const selectedAccount = selectedCalendar?.accountId
    ? accounts.find((account) => account.id === selectedCalendar.accountId)
    : undefined;

  const days = daysBetween(range.from, range.to);
  const views = medium ? DESKTOP_VIEWS : MOBILE_VIEWS;
  const showSidebar = wide ? sidebarShown : false;

  const content = results ? (
    <SearchResults
      query={query}
      events={results}
      calendars={calendarIndex}
      timeZone={timeZone}
      onOpen={(event, day) => {
        closeSearch();
        goTo(day, "day");
        void event;
      }}
    />
  ) : shownView === "month" ? (
    medium ? (
      <MonthGrid
        month={date.with({ day: 1 })}
        days={days}
        items={items}
        today={today}
        holidays={holidays}
        selectedKey={selectedItem?.key ?? null}
        onSelect={onSelect}
        onSelectDay={(day) => goTo(day, "day")}
      />
    ) : (
      <MobileMonth
        month={date.with({ day: 1 })}
        selected={date}
        days={days}
        items={items}
        today={today}
        holidays={holidays}
        selectedKey={selectedItem?.key ?? null}
        onSelect={onSelect}
        onSelectDay={(day) =>
          day.month === date.month ? setDate(day) : goTo(day)
        }
      />
    )
  ) : shownView === "agenda" ? (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <AgendaList
        compact={!medium}
        items={items}
        from={range.from}
        to={range.to}
        today={today}
        holidays={holidays}
        selectedKey={selectedItem?.key ?? null}
        onSelect={onSelect}
      />
    </div>
  ) : (
    <TimeGrid
      days={days}
      items={items}
      timeZone={timeZone}
      today={today}
      now={now}
      holidays={holidays}
      selectedKey={selectedItem?.key ?? null}
      compact={!medium}
      onSelect={onSelect}
      onCreateAt={(day, minutes) => openCreate(day, minutes)}
      onSelectDay={(day) => goTo(day, "day")}
    />
  );

  const sidebar = (
    <CalendarSidebar
      user={user}
      groups={groups}
      colorOf={colorOf}
      today={today}
      selected={date}
      selectedRange={range}
      busyDays={busyDays}
      canCreate={calendars !== null}
      online={online}
      syncStatus={syncStatus}
      onSelectDate={(day) => {
        setSidebarOpen(false);
        goTo(day);
      }}
      onCreateEvent={() => openCreate(date, nextHour(now))}
      onToggleCalendar={toggleCalendar}
      onAddCalendar={() => {
        setSidebarOpen(false);
        setAddError(null);
        setAddOpen(true);
      }}
      onRefreshCalendar={(calendar) => void refreshSubscription(calendar)}
      onRemoveCalendar={(calendar) => setRemoving(calendar)}
      onChooseSender={openSenderSetting}
      onOpenSettings={() => navigateApp("/settings")}
      onToggleSidebar={wide ? toggleSidebar : null}
      onNavigate={() => setSidebarOpen(false)}
    />
  );

  return (
    <div className="flex h-[calc(100dvh-var(--titlebar-height))] shrink-0 overflow-hidden">
      {/* 狭い画面では、サイドバーを左から重ねて出す。 */}
      {!wide && (
        <>
          <button
            type="button"
            aria-label="メニューを閉じる"
            tabIndex={sidebarOpen ? 0 : -1}
            onClick={() => setSidebarOpen(false)}
            className={cn(
              "fixed inset-0 top-(--titlebar-height) z-30 bg-black/30",
              !sidebarOpen && "hidden",
            )}
          />
          <aside
            className={cn(
              "fixed inset-y-0 top-(--titlebar-height) left-0 z-40 w-[312px] max-w-[85vw] border-r transition-transform",
              sidebarOpen ? "translate-x-0" : "invisible -translate-x-full",
            )}
          >
            {sidebar}
          </aside>
        </>
      )}
      {showSidebar && (
        <aside className="w-[312px] shrink-0 border-r">{sidebar}</aside>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        <span
          ref={openAnchorRef}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/4 left-1/3 size-0"
        />
        {medium ? (
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            {(!wide || !sidebarShown) && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="サイドバーを開く"
                className="-ml-1 text-muted-foreground"
                onClick={() => (wide ? toggleSidebar() : setSidebarOpen(true))}
              >
                <MenuIcon className="size-5" />
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => goTo(today)}>
              今日
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="前へ"
              className="text-muted-foreground"
              onClick={() => goTo(shiftDate(shownView, date, -1))}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="次へ"
              className="text-muted-foreground"
              onClick={() => goTo(shiftDate(shownView, date, 1))}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
            <h1 className="ml-1 truncate font-display font-semibold text-xl">
              {results ? "検索結果" : viewTitle(shownView, date)}
            </h1>
            <div className="ml-auto flex min-w-0 shrink items-center gap-2">
              {!showSidebar && (
                <SyncIndicator status={syncStatus} short className="shrink-0" />
              )}
              <ConflictsButton
                count={conflicts.length}
                compact={!wide}
                onClick={() => setConflictsOpen(true)}
              />
              <form
                className="relative w-64 shrink"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runSearch(query);
                }}
              >
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="予定を検索"
                  placeholder="予定を検索"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    if (!event.target.value) setResults(null);
                  }}
                  className="pl-9"
                />
              </form>
            </div>
            <div className="flex shrink-0 rounded-lg bg-muted p-1">
              {views.map((entry) => (
                <button
                  key={entry.view}
                  type="button"
                  aria-pressed={entry.view === shownView}
                  onClick={() => {
                    setResults(null);
                    changeView(entry.view);
                  }}
                  className={cn(
                    "flex h-7 items-center rounded-md px-3 text-sm",
                    entry.view === shownView && !results
                      ? "bg-background font-medium shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="flex h-14 shrink-0 items-center gap-1 px-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="メニューを開く"
                onClick={() => setSidebarOpen(true)}
              >
                <MenuIcon className="size-5" />
              </Button>
              {searchOpen ? (
                <form
                  className="flex flex-1 items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runSearch(query);
                  }}
                >
                  <Input
                    autoFocus
                    type="search"
                    aria-label="予定を検索"
                    placeholder="予定を検索"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="検索を閉じる"
                    onClick={closeSearch}
                  >
                    <XIcon className="size-5" />
                  </Button>
                </form>
              ) : (
                <>
                  <h1 className="ml-1 font-display font-semibold text-xl">
                    {shortMonthTitle(shownView === "month" ? date : range.from)}
                  </h1>
                  <div className="ml-auto flex min-w-0 items-center gap-1">
                    {!online && (
                      <SyncIndicator
                        status={syncStatus}
                        short
                        className="mr-1"
                      />
                    )}
                    <ConflictsButton
                      count={conflicts.length}
                      compact
                      onClick={() => setConflictsOpen(true)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="予定を検索"
                      onClick={() => setSearchOpen(true)}
                    >
                      <SearchIcon className="size-5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="今日へ"
                      className="font-semibold text-xs"
                      onClick={() => goTo(today)}
                    >
                      {today.day}
                    </Button>
                  </div>
                </>
              )}
            </div>
            {!results && (
              <div className="mx-3 mb-2 grid shrink-0 grid-cols-4 rounded-lg bg-muted p-1">
                {views.map((entry) => (
                  <button
                    key={entry.view}
                    type="button"
                    aria-pressed={entry.view === shownView}
                    onClick={() => changeView(entry.view)}
                    className={cn(
                      "flex h-7 items-center justify-center rounded-md text-sm",
                      entry.view === shownView
                        ? "bg-background font-medium shadow-xs"
                        : "text-muted-foreground",
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <div
          className={cn("flex min-h-0 flex-1 flex-col", !medium && "border-t")}
          // スワイプで前後の期間へ動かすのは、アプリ版で足す。
        >
          {content}
        </div>
        {!medium && (
          <Button
            aria-label="予定を作成"
            // Mail の「作成」ボタンと同じ形と大きさ (タッチの端末では高さ 44px)。
            className="absolute right-4 bottom-4 z-10 h-14 gap-2 rounded-2xl px-5 text-base shadow-lg [&_svg]:size-5"
            onClick={() => openCreate(date, nextHour(now))}
          >
            <PlusIcon />
            作成
          </Button>
        )}
      </main>

      <EventDetail
        item={selectedItem}
        anchor={selected?.anchor ?? null}
        calendar={selectedCalendar}
        calendarLabel={[selectedCalendar?.name, selectedAccount?.email]
          .filter(Boolean)
          .join(" · ")}
        pending={selectedPending}
        offline={!online}
        onShowConflicts={() => {
          setSelected(null);
          setConflictsOpen(true);
        }}
        onEdit={
          selectedItem && !selectedItem.readOnly
            ? () => openEdit(selectedItem)
            : null
        }
        onDelete={
          selectedItem && !selectedItem.readOnly
            ? () => requestDelete(selectedItem)
            : null
        }
        onRespond={
          selectedItem && !selectedItem.readOnly
            ? (status) => respond(selectedItem, status)
            : null
        }
        accounts={accounts}
        onClose={() => setSelected(null)}
      />
      <EventEditor
        open={editor !== null}
        title={editor?.title ?? ""}
        initial={editor?.form ?? null}
        existing={Boolean(editor?.item)}
        role={editor?.item ? inviteRole(editor.item.event) : "organizer"}
        online={online}
        organizer={editor?.item?.event.organizer ?? null}
        accounts={accounts}
        onChooseSender={online ? openSenderSetting : null}
        calendars={
          editor?.item
            ? // 予定を別のカレンダーへ移すのは、まだできない。
              writable.filter(
                (calendar) => calendar.id === editor.form.calendarId,
              )
            : writable
        }
        colorOf={colorOf}
        timeZone={timeZone}
        busy={false}
        error={saveError}
        onSave={(form) => save(form, null)}
        onClose={() => setEditor(null)}
      />
      <ScopeDialog
        action={scope?.action ?? null}
        note={
          scope
            ? scopeNote(scope, calendarOf(scope.item.event.calendarId))
            : null
        }
        onChoose={(chosen) => {
          const current = scope;
          setScope(null);
          if (!current) return;
          if (current.action === "save") save(current.form, chosen);
          else remove(current.item, chosen);
        }}
        onCancel={() => setScope(null)}
      />
      <ConflictList
        open={conflictsOpen}
        items={conflicts}
        calendarOf={calendarOf}
        colorOf={colorOf}
        eventOf={(id) => (id ? eventsById.get(id) : undefined)}
        timeZone={timeZone}
        busy={conflictBusy}
        onAction={(item, action) => void resolveConflict(item, action)}
        onClose={() => setConflictsOpen(false)}
      />
      <ImipSenderDialog
        calendar={senderCalendar}
        accounts={accounts}
        busy={senderBusy}
        error={senderError}
        onSave={(accountId) => void saveSender(accountId)}
        onOpenSettings={() => navigateApp("/settings")}
        onClose={() => setSenderCalendar(null)}
      />
      <AddCalendarDialog
        open={addOpen}
        busy={addBusy}
        error={addError}
        onCreate={(input) => void addCalendar(input)}
        onClose={() => setAddOpen(false)}
      />
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDelete?.mode === "decline"
                ? "不参加にして削除しますか？"
                : "予定を削除しますか？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.mode === "decline"
                ? confirmDelete.item.event.parentId
                  ? "この回に不参加で返事をして、カレンダーから削除します。"
                  : confirmDelete.item.repeating
                    ? "すべての回に不参加で返事をして、カレンダーから削除します。"
                    : "不参加で返事をして、カレンダーから削除します。"
                : confirmDelete
                  ? cancelNote(calendarOf(confirmDelete.item.event.calendarId))
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (!target) return;
                if (target.mode === "decline") declineAndRemove(target.item);
                else remove(target.item, null);
              }}
            >
              {confirmDelete?.mode === "decline" ? "不参加にして削除" : "削除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing?.source === "ics"
                ? `「${removing?.name}」の購読をやめますか？`
                : `「${removing?.name}」を削除しますか？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.source === "ics"
                ? "このカレンダーの予定が表示されなくなります。URL を登録し直せば、また表示できます。"
                : "このカレンダーの予定もすべて削除されます。元に戻せません。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void removeCalendar(target);
              }}
            >
              {removing?.source === "ics" ? "購読をやめる" : "削除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 同じ回か (原本と recurrenceId で比べる)。 */
function sameOccurrence(a: DisplayItem, b: DisplayItem): boolean {
  if (a.key === b.key) return true;
  return (
    a.local.occurrence.masterId === b.local.occurrence.masterId &&
    sameRecurrenceId(
      a.local.occurrence.recurrenceId,
      b.local.occurrence.recurrenceId,
    )
  );
}

/**
 * その回に関わる送信待ち。原本への「この回だけ」の操作は、その回のものだけを数える
 * (ほかの回の変更で、すべての回に「未送信」が出ないように)。
 */
function pendingOf(client: CalendarClient, item: DisplayItem): QueuedOp[] {
  const recurrenceId = itemRecurrenceId(item);
  return client
    .pendingFor(item.event.id)
    .filter(
      (op) =>
        op.recurrenceId === null ||
        recurrenceId === null ||
        sameRecurrenceId(op.recurrenceId, recurrenceId),
    );
}

/** 繰り返しの予定を消すとき、参加者に取り消しの連絡が届くなら添える (変更の連絡は編集画面で出す)。 */
function scopeNote(
  scope: { action: "save" | "delete"; item: DisplayItem },
  calendar: Calendar | undefined,
): string | null {
  const { event } = scope.item;
  if (
    scope.action !== "delete" ||
    inviteRole(event) !== "organizer" ||
    calendarScheduling(calendar) === "none" ||
    !event.attendees.some((attendee) => !attendee.self)
  ) {
    return null;
  }
  return cancelNote(calendar);
}

/** 削除を元に戻せなかった (もう送っていた) ときの知らせ。 */
function undoFailure(
  item: DisplayItem,
  calendar: Calendar | undefined,
): string {
  const role = inviteRole(item.event);
  const notified =
    role === "organizer" &&
    calendarScheduling(calendar) !== "none" &&
    item.event.attendees.some((attendee) => !attendee.self);
  if (!notified)
    return "すでにサーバーへ反映済みのため、元に戻せませんでした。";
  return calendarScheduling(calendar) === "mail"
    ? "すでに参加者に取り消しのメールを送ったため、元に戻せませんでした。"
    : "すでに参加者に取り消しの連絡が届いているため、元に戻せませんでした。";
}

/** 参加者のいる自分の予定を消すときの注記 (Orbit が送るならメール、サービスなら連絡)。 */
function cancelNote(calendar: Calendar | undefined): string {
  return calendarScheduling(calendar) === "mail"
    ? "参加者に取り消しのメールを送ります。"
    : "参加者に取り消しの連絡が届きます。";
}

/** 書き込めなかった理由。 */
function writeFailure(error: unknown): string {
  return error instanceof OfflineUnavailableError
    ? OFFLINE_SAVE_ERROR
    : SAVE_ERROR;
}

/** 回の recurrenceId (元の開始。サーバーが返した回の値)。 */
function itemRecurrenceId(item: DisplayItem): string | null {
  return item.local.occurrence.recurrenceId;
}

/** 新しい予定の開始 (次の正時。23 時を過ぎたら 23 時)。 */
function nextHour(now: Temporal.ZonedDateTime): number {
  return Math.min(now.hour + 1, 23) * 60;
}

/** カレンダーを足せなかった理由。購読はサーバーが理由の文を返す。 */
function addFailure(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。";
  }
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === "string") return message;
    if (error.code === "too_many_calendars") {
      return "これ以上カレンダーを追加できません。";
    }
  }
  return "追加できませんでした。もう一度お試しください。";
}
