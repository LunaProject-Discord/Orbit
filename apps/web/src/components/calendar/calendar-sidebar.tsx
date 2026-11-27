"use client";

import { cn } from "cn";
import {
  BellIcon,
  BellOffIcon,
  BellRingIcon,
  CalendarDaysIcon,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  MenuIcon,
  PlusIcon,
  RefreshCwIcon,
  RssIcon,
  SendIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import type { Temporal } from "temporal-polyfill";
import { AppSwitcher } from "@/components/brand/app-switcher";
import { DefaultRemindersDialog } from "@/components/calendar/default-reminders-dialog";
import { MiniMonth } from "@/components/calendar/mini-month";
import { Hint } from "@/components/hint";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { showNotice } from "@/components/mail/toasts";
import { SidebarAddButton } from "@/components/sidebar-add-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountMark } from "@/lib/account-icons";
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
      {/* 余白と並びはメールのサイドバー (account-sidebar.tsx) と同じにする。 */}
      {/* デスクトップ版では、この行がタイトルバーを兼ねる (components/desktop/title-bar.tsx)。 */}
      <div
        data-titlebar=""
        className="flex h-14 shrink-0 items-center gap-2 px-4"
      >
        {onToggleSidebar && (
          <Hint label="サイドバーを閉じる">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="サイドバーを閉じる"
              className="-ml-2"
              onClick={onToggleSidebar}
            >
              <MenuIcon />
            </Button>
          </Hint>
        )}
        <span className="flex flex-1 items-center">
          <AppSwitcher
            current="calendar"
            className="-ml-2"
            // 「Orbit Calendar」は「Orbit Mail」より長く、開閉ボタンと並ぶと幅 256px に
            // 28px の高さでは収まらない (矢印が切れる)。そのときだけ 24px にする。
            logoClassName={onToggleSidebar ? "h-6" : undefined}
            onNavigate={onNavigate}
          />
        </span>
      </div>
      {/* 左右の端は、下の項目の行 (選択中の背景) と同じ位置にする。 */}
      <div className="shrink-0 px-2 pb-2">
        <Button
          className="w-full justify-center gap-2"
          disabled={!canCreate}
          onClick={onCreateEvent}
        >
          <PlusIcon />
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
        <nav
          aria-label="カレンダー"
          className="flex flex-col gap-0.5 px-2 py-1"
        >
          {groups.map((group) => {
            const isFolded = folded.has(group.key);
            // カレンダーが無い (同期の失敗だけを見せている) まとまりは開閉できない。
            const foldable = group.calendars.length > 0;
            const toggle = () => toggleGroup(group.key);
            const mark = group.error ? (
              <CircleAlertIcon
                className="size-4 text-destructive"
                aria-hidden="true"
              />
            ) : (
              <GroupMark group={group} />
            );
            const label = (
              <span className="min-w-0 flex-1">
                <span className="block truncate">{group.name}</span>
                {group.sub && (
                  <span className="block truncate font-normal text-muted-foreground text-xs">
                    {group.sub}
                  </span>
                )}
                {group.error && (
                  <span
                    title={group.error}
                    className="mt-0.5 line-clamp-3 block font-normal text-destructive text-xs"
                  >
                    同期できません: {group.error}
                  </span>
                )}
              </span>
            );
            return (
              <div key={group.key} className="relative mt-2 first:mt-0">
                <div className="flex items-start">
                  <GroupToggle
                    open={!isFolded}
                    label={`${group.name} のカレンダー`}
                    onClick={foldable ? toggle : null}
                  >
                    {mark}
                  </GroupToggle>
                  {foldable ? (
                    <button
                      type="button"
                      aria-expanded={!isFolded}
                      onClick={toggle}
                      className={cn(GROUP_LABEL, GROUP_LABEL_ACTIVE)}
                    >
                      {label}
                    </button>
                  ) : (
                    <div className={GROUP_LABEL}>{label}</div>
                  )}
                </div>
                {!isFolded && foldable && (
                  <div className="flex flex-col gap-0.5">
                    {group.calendars.map((listed) => {
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
                        // 字下げはメールのアカウントの中のフォルダと同じ (色の四角は x40、名前は x64)。
                        <div
                          key={calendar.id}
                          className="flex items-center pl-1.5"
                        >
                          <span
                            className="size-5 shrink-0"
                            aria-hidden="true"
                          />
                          <div className="group/calendar relative flex min-w-0 flex-1 items-center rounded-md transition-colors hover:bg-sidebar-accent has-[[aria-expanded=true]]:bg-sidebar-accent">
                            {/* biome-ignore lint/a11y/useSemanticElements: 色付きの四角を出すため、ボタンにチェックボックスの役割を持たせる */}
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={calendar.visible}
                              onClick={() => onToggleCalendar(calendar)}
                              className={cn(
                                "flex min-w-0 flex-1 touch-manipulation select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-left text-sm pointer-coarse:min-h-11 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                                menu && "pr-9 pointer-coarse:pr-11",
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
                                  "min-w-0 flex-1 truncate",
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
                                  className="absolute right-1 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 group-hover/calendar:opacity-100 aria-expanded:opacity-100 pointer-coarse:size-9 [@media(hover:none)]:opacity-100"
                                >
                                  <EllipsisIcon className="size-4" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="w-52"
                                >
                                  {notifySetting && (
                                    <DropdownMenuCheckboxItem
                                      checked={calendar.notify === true}
                                      disabled={!online}
                                      title={
                                        online ? undefined : NEEDS_CONNECTION
                                      }
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
                                      title={
                                        online ? undefined : NEEDS_CONNECTION
                                      }
                                      onClick={() =>
                                        notify.openDefaults(calendar)
                                      }
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
                                      title={
                                        online ? undefined : NEEDS_CONNECTION
                                      }
                                      onClick={() =>
                                        onRefreshCalendar(calendar)
                                      }
                                    >
                                      <RefreshCwIcon />
                                      今すぐ更新
                                    </DropdownMenuItem>
                                  )}
                                  {senderSetting && (
                                    <DropdownMenuItem
                                      disabled={!online}
                                      title={
                                        online ? undefined : NEEDS_CONNECTION
                                      }
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
                                      title={
                                        online ? undefined : NEEDS_CONNECTION
                                      }
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
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {/* 追加のボタン。メールの「アカウントを追加」と同じ部品。 */}
          <div className="mt-1 flex flex-col gap-0.5">
            <SidebarAddButton
              icon={<PlusIcon />}
              onClick={onAddCalendar}
              disabled={!online}
              title={online ? undefined : NEEDS_CONNECTION}
            >
              カレンダーを追加
            </SidebarAddButton>
          </div>
        </nav>
      </div>
      {syncStatus && (
        <SyncIndicator
          status={syncStatus}
          // アイコンと文字を、上の項目のアイコンの列 (16px) と文字の列 (40px) に揃える。
          className="shrink-0 gap-2.5 border-t py-2 pr-2 pl-4"
        />
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
        <Hint label="設定" side="top">
          <Button
            variant="outline"
            size="icon"
            aria-label="設定"
            onClick={onOpenSettings}
          >
            <SettingsIcon />
          </Button>
        </Hint>
      </div>
    </div>
  );
}

/** まとまりの見出し (名前と補足の 2 行)。メールのアカウントの行 (SidebarItem) と同じ作り。 */
const GROUP_LABEL =
  "flex min-w-0 flex-1 items-start gap-2 rounded-md py-1.5 pr-2 pl-1 text-left text-sm pointer-coarse:py-3";
const GROUP_LABEL_ACTIVE =
  "outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50";

/** まとまりの印。アカウントならメールと同じアカウントの印、それ以外は種類のアイコン。 */
function GroupMark({ group }: { group: CalendarGroup }) {
  if (group.mark) {
    return (
      <AccountMark
        accounts={group.mark.accounts}
        account={group.mark.account}
      />
    );
  }
  const Icon =
    group.key === "local"
      ? CalendarIcon
      : group.key === "ics"
        ? RssIcon
        : CalendarDaysIcon;
  return <Icon className="size-4 text-muted-foreground" aria-hidden="true" />;
}

/**
 * まとまりの印。印の上にポインターを置くか、キーボードで選ぶと開閉の矢印に入れ替わり、
 * 押すとカレンダーの一覧を折りたたむ / 開く。メールの AccountToggle と同じ動き。
 */
function GroupToggle(props: {
  open: boolean;
  label: string;
  /** null なら開閉できない (印だけを出す)。 */
  onClick: (() => void) | null;
  children: React.ReactNode;
}) {
  // 左に 4px 空けて、印の中心をアイコンの列 (24px) に揃える。
  // タッチ操作では名前の行が上下に 6px ずつ広がるので、同じだけ下げて中心を揃える。
  const frame =
    "mt-1 ml-1 flex size-6 shrink-0 items-center justify-center pointer-coarse:mt-2.5";
  if (!props.onClick) return <span className={frame}>{props.children}</span>;
  return (
    <Hint label={props.open ? "折りたたむ" : "開く"}>
      <button
        type="button"
        aria-expanded={props.open}
        aria-label={`${props.label}を${props.open ? "折りたたむ" : "開く"}`}
        onClick={props.onClick}
        className={cn(
          frame,
          "group/toggle relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 rounded-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        <span className="flex transition-opacity group-hover/toggle:opacity-0 group-focus-visible/toggle:opacity-0">
          {props.children}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100",
            props.open && "rotate-90",
          )}
        />
      </button>
    </Hint>
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
