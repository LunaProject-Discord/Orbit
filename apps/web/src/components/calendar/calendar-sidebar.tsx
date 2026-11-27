"use client";

import { cn } from "cn";
import {
  BellIcon,
  BellOffIcon,
  BellRingIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EllipsisIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import type { Temporal } from "temporal-polyfill";
import { AppSwitcher } from "@/components/brand/app-switcher";
import { DefaultRemindersDialog } from "@/components/calendar/default-reminders-dialog";
import { MiniMonth } from "@/components/calendar/mini-month";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { showNotice } from "@/components/mail/toasts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { User } from "@/lib/api";
import {
  type Calendar,
  calendarDefaultRemindersEditable,
  calendarNotifySupported,
  type Reminder,
} from "@/lib/calendar/api";
import type { CalendarGroup } from "@/lib/calendar/groups";
import { imipConfigurable } from "@/lib/calendar/imip";
import {
  CalendarNotifyUnsupportedError,
  overlayCalendar,
  saveCalendarNotify,
} from "@/lib/calendar/notification-settings";
import type { SyncStatus } from "@/lib/sync-status";

/** オフライン中に押せないボタンに添える説明。 */
const NEEDS_CONNECTION = "接続していないときは使えません";

export function CalendarSidebar({
  user,
  groups,
  colorOf,
  today,
  selected,
  selectedRange,
  busyDays,
  canCreate,
  online = true,
  syncStatus = null,
  onSelectDate,
  onCreateEvent,
  onToggleCalendar,
  onAddCalendar,
  onRefreshCalendar,
  onRemoveCalendar,
  onChooseSender = null,
  onOpenSettings,
  onToggleSidebar,
  onNavigate,
  onCalendarUpdated,
}: {
  user: User;
  groups: CalendarGroup[];
  colorOf: (calendar: Calendar) => string;
  today: Temporal.PlainDate;
  selected: Temporal.PlainDate;
  selectedRange: { from: Temporal.PlainDate; to: Temporal.PlainDate };
  busyDays: ReadonlySet<string>;
  canCreate: boolean;
  /**
   * サーバーに届くか。届かない間は、接続が要る操作 (カレンダーの追加・削除、
   * 購読の更新) を押せなくする。
   */
  online?: boolean;
  /** 同期の表示 (null なら出さない)。 */
  syncStatus?: SyncStatus | null;
  onSelectDate: (date: Temporal.PlainDate) => void;
  onCreateEvent: () => void;
  onToggleCalendar: (calendar: Calendar) => void;
  onAddCalendar: () => void;
  /** 購読を今すぐ取得し直す。 */
  onRefreshCalendar: (calendar: Calendar) => void;
  /** カレンダーを消す (購読ならやめる)。確認は呼んだ側で出す。 */
  onRemoveCalendar: (calendar: Calendar) => void;
  /** カレンダーの「招待メールの送信元」を開く (無ければメニューに出さない)。 */
  onChooseSender?: ((calendar: Calendar) => void) | null;
  onOpenSettings: () => void;
  /** 広い画面でサイドバーを閉じる。null なら出さない。 */
  onToggleSidebar: (() => void) | null;
  /** アプリを切り替える前に呼ぶ。 */
  onNavigate?: () => void;
  /**
   * 通知の設定を保存したカレンダー (段取り 9)。渡さなくても、同期で控えが追い付くまで
   * サイドバーの中で保存した値を出す。
   */
  onCalendarUpdated?: (calendar: Calendar) => void;
}) {
  const notify = useCalendarNotifyState(onCalendarUpdated);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="relative flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        {onToggleSidebar && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="サイドバーを閉じる"
            className="text-muted-foreground"
            onClick={onToggleSidebar}
          >
            <MenuIcon className="size-5" />
          </Button>
        )}
        <AppSwitcher current="calendar" onNavigate={onNavigate} />
      </div>
      <div className="px-2 pb-2">
        <Button
          className="h-10 w-full"
          disabled={!canCreate}
          onClick={onCreateEvent}
        >
          <PlusIcon className="size-4" />
          予定を作成
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MiniMonth
          today={today}
          selected={selected}
          selectedRange={selectedRange}
          busyDays={busyDays}
          onSelect={onSelectDate}
        />
        <div className="flex flex-col gap-3 px-2 pb-4">
          {groups.map((group) => {
            const isFolded = folded.has(group.key);
            return (
              <div key={group.key}>
                <button
                  type="button"
                  aria-expanded={!isFolded}
                  onClick={() => toggleGroup(group.key)}
                  className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent"
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      isFolded && "-rotate-90",
                    )}
                  />
                  <span className="shrink-0 font-medium text-sm">
                    {group.name}
                  </span>
                  {group.error && (
                    <CircleAlertIcon
                      role="img"
                      aria-label="カレンダーを同期できません"
                      className="size-3.5 shrink-0 text-destructive"
                    />
                  )}
                  {group.sub && (
                    <span className="truncate text-muted-foreground text-xs">
                      {group.sub}
                    </span>
                  )}
                </button>
                {!isFolded && group.error && (
                  <p
                    title={group.error}
                    className="line-clamp-2 pr-2 pb-1 pl-7 text-muted-foreground text-xs"
                  >
                    同期できません: {group.error}
                  </p>
                )}
                {!isFolded &&
                  group.calendars.map((listed) => {
                    const calendar = notify.view(listed);
                    const color = colorOf(calendar);
                    const subscription = calendar.source === "ics";
                    const removable =
                      calendar.source === "local" || subscription;
                    const senderSetting =
                      onChooseSender !== null && imipConfigurable(calendar);
                    // 通知の項目は、サーバーが対応しているとき (応答に notify がある) だけ出す。
                    const notifySetting = calendarNotifySupported(calendar);
                    const reminderSetting =
                      calendarDefaultRemindersEditable(calendar);
                    const menu = removable || senderSetting || notifySetting;
                    // 種類の既定ではオンなのに、利用者がオフにしたカレンダーに印を出す。
                    const muted =
                      calendar.notify === false &&
                      calendar.notifyDefault !== false;
                    return (
                      <div
                        key={calendar.id}
                        className="group/calendar relative flex items-center rounded-md hover:bg-sidebar-accent has-[[aria-expanded=true]]:bg-sidebar-accent"
                      >
                        {/* biome-ignore lint/a11y/useSemanticElements: 色付きの四角を出すため、ボタンにチェックボックスの役割を持たせる */}
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={calendar.visible}
                          onClick={() => onToggleCalendar(calendar)}
                          className={cn(
                            "flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md pr-2 pl-7 text-left text-sm",
                            menu && "pr-9",
                          )}
                        >
                          <span
                            className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border-2"
                            style={{
                              borderColor: color,
                              background: calendar.visible
                                ? color
                                : "transparent",
                            }}
                          >
                            {calendar.visible && (
                              <CheckIcon
                                className="size-3 text-white"
                                strokeWidth={3}
                              />
                            )}
                          </span>
                          <span
                            className={cn(
                              "flex-1 truncate",
                              !calendar.visible && "text-muted-foreground",
                            )}
                          >
                            {calendar.name}
                          </span>
                          {muted && (
                            <BellOffIcon
                              role="img"
                              aria-label="通知オフ"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                          )}
                          {subscription && calendar.lastError && (
                            <CircleAlertIcon
                              className="size-4 shrink-0 text-destructive"
                              aria-label={calendar.lastError}
                            >
                              <title>{calendar.lastError}</title>
                            </CircleAlertIcon>
                          )}
                        </button>
                        {menu && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`「${calendar.name}」のメニュー`}
                              className="absolute right-1 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 group-hover/calendar:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
                            >
                              <EllipsisIcon className="size-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              {notifySetting && (
                                <DropdownMenuCheckboxItem
                                  checked={calendar.notify === true}
                                  disabled={!online}
                                  title={online ? undefined : NEEDS_CONNECTION}
                                  onCheckedChange={(checked) =>
                                    notify.toggle(calendar, checked)
                                  }
                                >
                                  <BellIcon />
                                  通知
                                </DropdownMenuCheckboxItem>
                              )}
                              {reminderSetting && (
                                <DropdownMenuItem
                                  disabled={!online}
                                  title={online ? undefined : NEEDS_CONNECTION}
                                  onClick={() => notify.openDefaults(calendar)}
                                >
                                  <BellRingIcon />
                                  既定の通知…
                                </DropdownMenuItem>
                              )}
                              {notifySetting &&
                                (subscription ||
                                  senderSetting ||
                                  removable) && <DropdownMenuSeparator />}
                              {subscription && (
                                <DropdownMenuItem
                                  disabled={!online}
                                  title={online ? undefined : NEEDS_CONNECTION}
                                  onClick={() => onRefreshCalendar(calendar)}
                                >
                                  <RefreshCwIcon />
                                  今すぐ更新
                                </DropdownMenuItem>
                              )}
                              {senderSetting && (
                                <DropdownMenuItem
                                  disabled={!online}
                                  title={online ? undefined : NEEDS_CONNECTION}
                                  onClick={() => onChooseSender?.(calendar)}
                                >
                                  <SendIcon />
                                  招待メールの送信元
                                </DropdownMenuItem>
                              )}
                              {removable && (
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={!online}
                                  title={online ? undefined : NEEDS_CONNECTION}
                                  onClick={() => onRemoveCalendar(calendar)}
                                >
                                  <Trash2Icon />
                                  {subscription ? "購読をやめる" : "削除"}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
          <button
            type="button"
            onClick={onAddCalendar}
            disabled={!online}
            title={online ? undefined : NEEDS_CONNECTION}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <PlusIcon className="size-4" />
            カレンダーを追加
          </button>
        </div>
      </div>
      {syncStatus && (
        <div className="flex h-10 shrink-0 items-center border-t px-4">
          <SyncIndicator status={syncStatus} />
        </div>
      )}
      <DefaultRemindersDialog
        calendar={notify.defaults}
        busy={notify.defaultsBusy}
        error={notify.defaultsError}
        onSave={notify.saveDefaults}
        onClose={notify.closeDefaults}
      />
      <div className="flex shrink-0 items-center gap-2 border-t py-3 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">{user.name}</p>
          <p className="truncate text-muted-foreground text-xs">{user.email}</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="設定"
          onClick={onOpenSettings}
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * カレンダーごとの通知のオン・オフと既定の通知 (段取り 9)。サーバーへ直接保存し、
 * 同期で控えが追い付くまでは保存した値を重ねて出す。
 */
function useCalendarNotifyState(
  onCalendarUpdated: ((calendar: Calendar) => void) | undefined,
) {
  const [saved, setSaved] = useState<ReadonlyMap<string, Calendar>>(new Map());
  const [pending, setPending] = useState<
    ReadonlyMap<string, Partial<Calendar>>
  >(new Map());
  const [defaults, setDefaults] = useState<Calendar | null>(null);
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);

  const remember = (calendar: Calendar) => {
    setSaved((current) => new Map(current).set(calendar.id, calendar));
    onCalendarUpdated?.(calendar);
  };
  const withPending = (id: string, value: Partial<Calendar> | null) =>
    setPending((current) => {
      const next = new Map(current);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });

  return {
    view: (calendar: Calendar) =>
      overlayCalendar(
        calendar,
        saved.get(calendar.id),
        pending.get(calendar.id),
      ),
    toggle: (calendar: Calendar, on: boolean) => {
      // 押してすぐ画面に反映し、保存できなければ元に戻す。
      withPending(calendar.id, { notify: on });
      saveCalendarNotify(calendar, { notify: on })
        .then(remember)
        .catch((error) =>
          showNotice(
            error instanceof CalendarNotifyUnsupportedError
              ? "このサーバーでは、カレンダーごとの通知を変えられません。"
              : "通知の設定を保存できませんでした。もう一度お試しください。",
          ),
        )
        .finally(() => withPending(calendar.id, null));
    },
    defaults,
    defaultsBusy,
    defaultsError,
    openDefaults: (calendar: Calendar) => {
      setDefaultsError(null);
      setDefaults(calendar);
    },
    closeDefaults: () => setDefaults(null),
    saveDefaults: (reminders: Reminder[]) => {
      const target = defaults;
      if (!target) return;
      setDefaultsBusy(true);
      setDefaultsError(null);
      saveCalendarNotify(target, { defaultReminders: reminders })
        .then((calendar) => {
          remember(calendar);
          setDefaults(null);
        })
        .catch((error) =>
          setDefaultsError(
            error instanceof CalendarNotifyUnsupportedError
              ? "このサーバーでは、既定の通知を変えられません。"
              : "保存できませんでした。もう一度お試しください。",
          ),
        )
        .finally(() => setDefaultsBusy(false));
    },
  };
}
