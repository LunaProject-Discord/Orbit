"use client";

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
import { Temporal } from "temporal-polyfill";
import {
  AddCalendarDialog,
  type AddCalendarInput,
} from "@/components/calendar/add-calendar-dialog";
import { AgendaList } from "@/components/calendar/agenda-list";
import { CalendarSidebar } from "@/components/calendar/calendar-sidebar";
import { calendarColor } from "@/components/calendar/colors";
import { EventDetail } from "@/components/calendar/event-detail";
import { EventEditor } from "@/components/calendar/event-editor";
import { MobileMonth } from "@/components/calendar/mobile-month";
import { MonthGrid } from "@/components/calendar/month-grid";
import {
  type ChangeScope,
  ScopeDialog,
} from "@/components/calendar/scope-dialog";
import { SearchResults } from "@/components/calendar/search-results";
import { TimeGrid } from "@/components/calendar/time-grid";
import type { DisplayItem, SelectHandler } from "@/components/calendar/types";
import { showNotice } from "@/components/mail/toasts";
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
import {
  type Account,
  ApiError,
  listAccounts,
  NetworkError,
  type User,
} from "@/lib/api";
import { navigateApp } from "@/lib/app-navigation";
import {
  type Calendar,
  type CalendarEvent,
  createCaldavAccount,
  createCalendar,
  createEvent,
  deleteCalendar,
  deleteEvent,
  deleteOccurrence,
  type EventFields,
  type EventRange,
  listCalendars,
  listEvents,
  refreshCalendar,
  searchEvents,
  subscribeCalendar,
  updateCalendar,
  updateEvent,
  updateOccurrence,
} from "@/lib/calendar/api";
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
  type EventForm,
  eventFormOf,
  formChanges,
  newEventForm,
  shiftMasterTime,
} from "@/lib/calendar/event-form";
import { groupCalendars } from "@/lib/calendar/groups";
import { buildCalendarRoute, parseCalendarRoute } from "@/lib/calendar/route";
import { subscribeEvents } from "@/lib/events";
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

const LOAD_ERROR = "予定を読み込めませんでした。接続を確かめてください。";
const SAVE_ERROR = "保存できませんでした。もう一度お試しください。";
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

  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [data, setData] = useState<EventRange | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarShown, setSidebarShown] = useState(true);
  const [selected, setSelected] = useState<{
    item: DisplayItem;
    anchor: HTMLElement;
  } | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scope, setScope] = useState<
    | { action: "save"; form: EventForm; item: DisplayItem }
    | { action: "delete"; item: DisplayItem }
    | null
  >(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Calendar | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CalendarEvent[] | null>(null);

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
      const route = parseCalendarRoute(window.location.pathname);
      if (route.view) setView(route.view);
      if (route.date) setDate(route.date);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const range = useMemo(() => viewRange(shownView, date), [shownView, date]);

  const loadCalendars = useCallback(async () => {
    try {
      const [nextCalendars, nextAccounts] = await Promise.all([
        listCalendars(),
        listAccounts().catch(() => null),
      ]);
      setCalendars(nextCalendars);
      if (nextAccounts) setAccounts(nextAccounts);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  const requestRef = useRef(0);
  const loadRange = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await listEvents({
        from: range.from.toString(),
        to: range.to.toString(),
        timeZone,
      });
      if (request !== requestRef.current) return;
      setData(next);
      setLoadFailed(false);
    } catch {
      if (request === requestRef.current) setLoadFailed(true);
    }
  }, [range, timeZone]);

  useEffect(() => {
    void loadCalendars();
  }, [loadCalendars]);
  useEffect(() => {
    void loadRange();
  }, [loadRange]);

  // ほかの端末での変更を受けたら、読み込み直す。
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => {
    void loadCalendars();
    void loadRange();
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeEvents((event) => {
      if (event.event !== "change") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

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
        repeating:
          occurrence.recurrenceId !== null &&
          Boolean(master?.rrule || master?.rdates.length),
        readOnly: entry?.calendar.readOnly ?? true,
      });
    }
    return result;
  }, [data, eventsById, calendarIndex, timeZone]);

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

  const reportRejected = (rejected: string[]) => {
    if (rejected.length > 0) {
      showNotice(
        "ほかの端末で後から変更された項目があったので、その項目は変更しませんでした。",
        "info",
      );
    }
  };

  const save = async (form: EventForm, chosen: ChangeScope | null) => {
    if (!editor) return;
    const { item } = editor;
    setSaving(true);
    setSaveError(null);
    try {
      if (!item) {
        const fields = formChanges(form, timeZone, null);
        if (!fields?.time) throw new Error("invalid");
        await createEvent({
          ...fields,
          time: fields.time,
          id: randomUuid(),
          calendarId: form.calendarId,
        });
      } else {
        const before = eventFormOf(item.event, item.local);
        const changes = formChanges(form, timeZone, before);
        if (!changes) throw new Error("invalid");
        if (Object.keys(changes).length > 0) {
          const recurrenceId = itemRecurrenceId(item);
          if (item.repeating && chosen === null) {
            setScope({ action: "save", form, item });
            setSaving(false);
            return;
          }
          if (item.repeating && chosen === "this" && recurrenceId) {
            const { recurrence: _ignored, ...rest } = changes;
            const masterId = item.event.parentId ?? item.event.id;
            reportRejected(
              (await updateOccurrence(masterId, recurrenceId, rest)).rejected,
            );
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
            reportRejected((await updateEvent(master.id, forMaster)).rejected);
          } else {
            reportRejected(
              (await updateEvent(item.event.id, changes)).rejected,
            );
          }
        }
      }
      setEditor(null);
      await loadRange();
    } catch {
      setSaveError(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: DisplayItem, chosen: ChangeScope | null) => {
    if (item.repeating && chosen === null) {
      setScope({ action: "delete", item });
      return;
    }
    setSelected(null);
    try {
      if (item.repeating && chosen === "this") {
        const recurrenceId = itemRecurrenceId(item);
        const masterId = item.event.parentId ?? item.event.id;
        if (recurrenceId) await deleteOccurrence(masterId, recurrenceId);
      } else if (item.repeating && chosen === "all") {
        await deleteEvent(item.event.parentId ?? item.event.id);
      } else {
        await deleteEvent(item.event.id);
      }
      await loadRange();
    } catch {
      showNotice("削除できませんでした。もう一度お試しください。");
    }
  };

  const toggleCalendar = async (calendar: Calendar) => {
    const visible = !calendar.visible;
    setCalendars(
      (current) =>
        current?.map((entry) =>
          entry.id === calendar.id ? { ...entry, visible } : entry,
        ) ?? null,
    );
    try {
      await updateCalendar(calendar.id, { visible });
    } catch {
      showNotice("表示を切り替えられませんでした。");
      void loadCalendars();
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
        );
        void loadCalendars();
        return;
      }
      const created =
        input.kind === "local"
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
            });
      setCalendars((current) => [...(current ?? []), created]);
      setAddOpen(false);
      if (input.kind === "subscription") void loadRange();
    } catch (error) {
      setAddError(addFailure(error));
    } finally {
      setAddBusy(false);
    }
  };

  const refreshSubscription = async (calendar: Calendar) => {
    try {
      const next = await refreshCalendar(calendar.id);
      setCalendars(
        (current) =>
          current?.map((entry) => (entry.id === next.id ? next : entry)) ??
          current,
      );
      if (next.lastError) showNotice(next.lastError);
      else showNotice(`「${next.name}」を更新しました。`);
      void loadRange();
    } catch {
      showNotice("更新できませんでした。");
    }
  };

  const removeCalendar = async (calendar: Calendar) => {
    try {
      await deleteCalendar(calendar.id);
      setCalendars(
        (current) =>
          current?.filter((entry) => entry.id !== calendar.id) ?? null,
      );
      void loadRange();
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
    try {
      setResults(await searchEvents(trimmed));
    } catch {
      showNotice("検索できませんでした。");
    }
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setResults(null);
  };

  const selectedItem = selected?.item ?? null;
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
            <form
              className="relative ml-auto w-64 shrink"
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
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="予定を検索"
                    className="ml-auto"
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
        {loadFailed && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-sm">
            {LOAD_ERROR}
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={() => reloadRef.current()}
            >
              再読み込み
            </Button>
          </div>
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
            className="absolute right-4 bottom-6 size-14 rounded-2xl shadow-lg"
            onClick={() => openCreate(date, nextHour(now))}
          >
            <PlusIcon className="size-6" />
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
        onEdit={
          selectedItem && !selectedItem.readOnly
            ? () => openEdit(selectedItem)
            : null
        }
        onDelete={
          selectedItem && !selectedItem.readOnly
            ? () => void remove(selectedItem, null)
            : null
        }
        onClose={() => setSelected(null)}
      />
      <EventEditor
        open={editor !== null}
        title={editor?.title ?? ""}
        initial={editor?.form ?? null}
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
        busy={saving}
        error={saveError}
        onSave={(form) => void save(form, null)}
        onClose={() => setEditor(null)}
      />
      <ScopeDialog
        action={scope?.action ?? null}
        onChoose={(chosen) => {
          const current = scope;
          setScope(null);
          if (!current) return;
          if (current.action === "save") void save(current.form, chosen);
          else void remove(current.item, chosen);
        }}
        onCancel={() => setScope(null)}
      />
      <AddCalendarDialog
        open={addOpen}
        busy={addBusy}
        error={addError}
        onCreate={(input) => void addCalendar(input)}
        onClose={() => setAddOpen(false)}
      />
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
