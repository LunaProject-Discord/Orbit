"use client";

import type { InviteRole } from "@orbit/core/event-invite";
import { clampReminderMinutes } from "@orbit/core/reminders";
import { cn } from "cn";
import {
  BellIcon,
  CalendarDaysIcon,
  ClockIcon,
  MapPinIcon,
  PlusIcon,
  RepeatIcon,
  TextIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { reminderLabel } from "@/components/calendar/event-detail";
import { SimpleSelect } from "@/components/calendar/simple-select";
import { RecipientInput } from "@/components/mail/recipient-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { Account } from "@/lib/api";
import {
  type Calendar,
  type CalendarEvent,
  calendarScheduling,
  type Reminder,
} from "@/lib/calendar/api";
import {
  type EventForm,
  formTime,
  inviteFormView,
} from "@/lib/calendar/event-form";
import { blockedSenderAddress, inviteSenderAddress } from "@/lib/calendar/imip";
import {
  ALL_DAY_REMINDER_DAYS,
  ALL_DAY_REMINDER_NEW,
  allDayDaysLabel,
  allDayReminderParts,
  allDayReminderText,
  allDayReminderValue,
  parseTimeInput,
  refreshCalendarNotificationSettings,
  timeInputValue,
  useCalendarNotificationSettings,
} from "@/lib/calendar/notification-settings";
import { describeRule } from "@/lib/calendar/recurrence-label";

export const REMINDER_MINUTES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

function timeZoneLabel(timeZone: string): string {
  const offset = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value;
  return offset ? `${timeZone} (${offset})` : timeZone;
}

function Field({
  icon: Icon,
  children,
}: {
  icon: typeof ClockIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-2.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

/** 参加者の欄を囲む枠 (Input と同じ見た目)。 */
const ATTENDEE_BOX =
  "flex min-h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent px-1.5 py-1 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30";

/**
 * 終日 ⇄ 時刻ありを切り替えたときの、予定ごとの通知 (レビュー L10)。分の意味が変わる
 * (時刻ありは開始の何分前、終日は開始日の 0:00 の何分前) ので、値はそのまま使わず、
 * 終日なら allDayMinutes (終日の予定の既定)、時刻ありなら 10 分前に置き換える。同じ値は 1 つにまとめる。
 */
export function switchedReminders(
  reminders: readonly Reminder[],
  wasAllDay: boolean,
  allDay: boolean,
  allDayMinutes: number,
): Reminder[] {
  if (wasAllDay === allDay) return [...reminders];
  const minutes =
    clampReminderMinutes(allDay ? allDayMinutes : 10, allDay) ?? 0;
  const seen = new Set<string>();
  return reminders
    .map((reminder) => ({ ...reminder, minutes }))
    .filter((reminder) => {
      const key = `${reminder.method}:${reminder.minutes}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 予定の作成・編集。 */
export function EventEditor({
  open,
  title,
  initial,
  existing = false,
  role = "organizer",
  online = true,
  organizer = null,
  accounts = null,
  calendars,
  colorOf,
  timeZone,
  busy,
  error,
  onSave,
  onChooseSender = null,
  onClose,
}: {
  open: boolean;
  title: string;
  initial: EventForm | null;
  /** 既にある予定の編集か (initial が開いたときの値になる)。 */
  existing?: boolean;
  /** 予定に対する自分の役割 (新しい予定は organizer)。 */
  role?: InviteRole;
  /** サーバーに届くか (注記の言い方を変える)。 */
  online?: boolean;
  /** 既にある予定の主催者 (招待メールの送信元のアドレスになる)。 */
  organizer?: CalendarEvent["organizer"];
  /** アカウントの一覧 (受信専用の送信元のアドレスを出すのに使う)。 */
  accounts?: readonly Pick<Account, "id" | "email">[] | null;
  /** 予定を入れられるカレンダー。 */
  calendars: Calendar[];
  colorOf: (calendar: Calendar) => string;
  timeZone: string;
  busy: boolean;
  error: string | null;
  onSave: (form: EventForm) => void;
  /** カレンダーの「招待メールの送信元」を開く (無ければ「送信元を選ぶ」を出さない)。 */
  onChooseSender?: ((calendar: Calendar) => void) | null;
  onClose: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<EventForm | null>(initial);
  useEffect(() => {
    setForm(initial);
  }, [initial]);
  const notificationSettings = useCalendarNotificationSettings();
  useEffect(() => {
    if (open) void refreshCalendarNotificationSettings();
  }, [open]);
  if (!form) return null;
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));
  const valid = formTime(form, timeZone) !== null;
  const selectedCalendar = calendars.find(
    (calendar) => calendar.id === form.calendarId,
  );
  const invite = inviteFormView({
    form,
    before: existing ? initial : null,
    role,
    scheduling: calendarScheduling(selectedCalendar),
    timeZone,
    online,
    sender: inviteSenderAddress(selectedCalendar, existing ? organizer : null),
    schedulingBlocked: selectedCalendar?.schedulingBlocked ?? null,
    blockedAddress: selectedCalendar
      ? blockedSenderAddress(selectedCalendar, accounts)
      : null,
  });
  const locked = invite.locked;
  const canSave = valid && invite.blocked === null;

  // 開始を動かしたら、終わりも同じだけ動かす (長さを保つ)。
  const moveStart = (date: string, time: string) => {
    setForm((current) => {
      if (!current) return current;
      const before = formTime(current, timeZone);
      const next = { ...current, startDate: date, startTime: time };
      if (!before || before.allDay) {
        if (current.allDay && date > current.endDate) next.endDate = date;
        return next;
      }
      const length = Date.parse(before.endAt) - Date.parse(before.startAt);
      const start = formTime(
        { ...next, endDate: date, endTime: time },
        timeZone,
      );
      if (!start || start.allDay) return next;
      const end = new Date(Date.parse(start.startAt) + length);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(end);
      const part = (type: string) =>
        parts.find((entry) => entry.type === type)?.value ?? "";
      next.endDate = `${part("year")}-${part("month")}-${part("day")}`;
      next.endTime = `${part("hour")}:${part("minute")}`;
      return next;
    });
  };

  const repeatOptions = [
    { value: "none", label: "繰り返さない" },
    { value: "daily", label: "毎日" },
    { value: "weekly", label: "毎週" },
    { value: "monthly", label: "毎月" },
    { value: "yearly", label: "毎年" },
    ...(form.customRule
      ? [
          {
            value: "custom",
            label: describeRule(form.customRule) ?? "カスタム",
          },
        ]
      : []),
  ];
  const reminderOptions = REMINDER_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: reminderLabel({ method: "display", minutes }),
  }));
  // 予定の通知に対応したサーバーだけが、終日の予定の「当日 ○時」(負の分) を受け付ける。
  const notificationsReady = notificationSettings.status === "ready";
  const allDayDefault = notificationsReady
    ? notificationSettings.value.calendarNotifications.allDay
    : null;
  // 終日に切り替えたときの通知の値: 終日の予定の既定 (オフなら当日 9:00)。古いサーバーは前日 9:00。
  const switchedAllDayMinutes = notificationsReady
    ? (allDayDefault?.minutes ?? ALL_DAY_REMINDER_NEW)
    : 900;
  // Google・Microsoft には当日の時刻 (負の分) を書けないので、Orbit の中だけで鳴らす (A2)。
  const providerName =
    selectedCalendar?.source === "google"
      ? "Google カレンダー"
      : selectedCalendar?.source === "microsoft"
        ? "Outlook"
        : null;
  const orbitOnlyNote =
    form.allDay &&
    providerName &&
    form.reminders.some((reminder) => reminder.minutes < 0)
      ? `当日の時刻の通知は ${providerName} には登録されず、Orbit だけで通知します。`
      : null;
  const updateReminder = (index: number, reminder: Reminder | null) => {
    const list = [...form.reminders];
    if (reminder) list[index] = reminder;
    else list.splice(index, 1);
    set("reminders", list);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      {/* 広い画面は中央のダイアログ。狭い画面は Mail の作成画面と同じ全画面にし、
          上の帯に「閉じる」・題・「保存」を並べる (compose-window.tsx と同じ作り)。
          中身 (フォーム) だけをスクロールさせ、見出しと「保存」はいつも見える位置に置く。 */}
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex flex-col gap-4 sm:max-w-[560px]",
          "max-sm:inset-0 max-sm:top-(--titlebar-height) max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:gap-0 max-sm:rounded-none max-sm:p-0 max-sm:ring-0 max-sm:data-closed:animate-none max-sm:data-open:animate-none",
        )}
      >
        <div
          // 狭い画面の全画面の帯は、デスクトップ版ではタイトルバーを兼ねる。
          data-titlebar=""
          className="flex shrink-0 items-center gap-1 max-sm:h-14 max-sm:border-b max-sm:px-2 sm:pr-8"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="閉じる"
            disabled={busy}
            onClick={onClose}
            className="sm:hidden"
          >
            <XIcon />
          </Button>
          <DialogTitle className="min-w-0 flex-1 truncate font-semibold text-base sm:text-lg">
            {title}
          </DialogTitle>
          <Button
            type="submit"
            form={`${id}-form`}
            disabled={!canSave || busy}
            className="shrink-0 sm:hidden"
          >
            {busy && <Spinner />}
            {invite.saveLabel}
          </Button>
        </div>
        <form
          id={`${id}-form`}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-0.5 pb-0.5 max-sm:px-4 max-sm:pt-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-h-[min(70dvh,640px)]"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !busy) onSave(form);
          }}
        >
          <Input
            autoFocus
            aria-label="タイトル"
            placeholder="タイトル"
            disabled={locked}
            value={form.summary}
            onChange={(event) => set("summary", event.target.value)}
            // フォームがスクロールするほど長いときに、縦に縮まないようにする。
            className="shrink-0"
          />
          <Field icon={ClockIcon}>
            <div className="flex flex-wrap items-center gap-2">
              {/* 開始・終了をそれぞれ「日付 時刻」でまとめ、狭い画面では行ごとに折り返す */}
              <div className="flex items-center gap-2">
                <DatePicker
                  aria-label="開始日"
                  disabled={locked}
                  value={form.startDate}
                  onChange={(value) => {
                    // 開始日は空にできない (「クリア」は無視する)。
                    if (value) moveStart(value, form.startTime);
                  }}
                />
                {!form.allDay && (
                  <Input
                    type="time"
                    aria-label="開始時刻"
                    disabled={locked}
                    step={300}
                    value={form.startTime}
                    onChange={(event) =>
                      moveStart(form.startDate, event.target.value)
                    }
                    className="w-auto tabular-nums"
                  />
                )}
                <span className="text-muted-foreground">〜</span>
              </div>
              <div className="flex items-center gap-2">
                <DatePicker
                  aria-label="終了日"
                  disabled={locked}
                  value={form.endDate}
                  onChange={(value) => {
                    if (value) set("endDate", value);
                  }}
                />
                {!form.allDay && (
                  <Input
                    type="time"
                    aria-label="終了時刻"
                    disabled={locked}
                    step={300}
                    value={form.endTime}
                    onChange={(event) => set("endTime", event.target.value)}
                    className="w-auto tabular-nums"
                  />
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox が中の入力になる */}
              <label className="flex items-center gap-2">
                <Checkbox
                  disabled={locked}
                  checked={form.allDay}
                  onCheckedChange={(checked) =>
                    setForm((current) =>
                      current
                        ? {
                            ...current,
                            allDay: checked === true,
                            reminders: switchedReminders(
                              current.reminders,
                              current.allDay,
                              checked === true,
                              switchedAllDayMinutes,
                            ),
                          }
                        : current,
                    )
                  }
                />
                終日
              </label>
              {!form.allDay && (
                <span className="text-muted-foreground">
                  タイムゾーン: {timeZoneLabel(timeZone)}
                </span>
              )}
            </div>
            {!valid && (
              <p className="text-destructive text-sm">
                終わりが始まりより前になっています。
              </p>
            )}
          </Field>
          <Field icon={RepeatIcon}>
            <div className="flex flex-wrap items-center gap-2">
              <SimpleSelect
                label="繰り返し"
                disabled={locked}
                value={form.preset}
                options={repeatOptions}
                onChange={(value) =>
                  set("preset", value as EventForm["preset"])
                }
              />
              {form.preset !== "none" && form.preset !== "custom" && (
                // biome-ignore lint/a11y/noLabelWithoutControl: Input が中の入力になる
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">終わり</span>
                  <DatePicker
                    aria-label="繰り返しの最後の日"
                    disabled={locked}
                    value={form.until}
                    min={form.startDate}
                    onChange={(value) => set("until", value)}
                  />
                </label>
              )}
            </div>
          </Field>
          <Field icon={UsersIcon}>
            {invite.attendees === "edit" ? (
              <div className={ATTENDEE_BOX}>
                <RecipientInput
                  id={`${id}-attendees`}
                  value={form.attendees}
                  onChange={(value) => set("attendees", value)}
                  placeholder="参加者を追加"
                />
              </div>
            ) : (
              <div
                className={cn(
                  ATTENDEE_BOX,
                  "flex-wrap gap-1.5",
                  invite.attendees === "disabled" &&
                    "cursor-not-allowed opacity-60",
                )}
              >
                {form.attendees.list.length === 0 && (
                  <span className="px-1 text-muted-foreground text-sm">
                    参加者を追加
                  </span>
                )}
                {form.attendees.list.map((entry) => {
                  const name = entry.name?.trim() || entry.address;
                  return (
                    <span
                      key={entry.address}
                      title={entry.address}
                      className={cn(
                        "inline-flex h-7 max-w-full pointer-coarse:h-9 items-center gap-1 rounded-full border bg-muted/60 pl-2.5 text-sm",
                        invite.attendees === "remove_only" ? "pr-1" : "pr-2.5",
                      )}
                    >
                      <span className="truncate">{name}</span>
                      {invite.attendees === "remove_only" && (
                        <button
                          type="button"
                          aria-label={`${name} を参加者から外す`}
                          onClick={() =>
                            set("attendees", {
                              list: form.attendees.list.filter(
                                (other) => other !== entry,
                              ),
                              text: "",
                            })
                          }
                          className="relative flex size-5 shrink-0 items-center justify-center rounded-full pointer-coarse:size-7 text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            {invite.note && (
              <p
                className={cn(
                  "text-xs",
                  invite.warning ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {invite.note}
                {invite.chooseSender && onChooseSender && selectedCalendar && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => onChooseSender(selectedCalendar)}
                      className="whitespace-nowrap text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      送信元を選ぶ
                    </button>
                  </>
                )}
              </p>
            )}
          </Field>
          <Field icon={MapPinIcon}>
            <Input
              aria-label="場所"
              disabled={locked}
              placeholder="場所またはオンライン会議"
              value={form.location}
              onChange={(event) => set("location", event.target.value)}
            />
          </Field>
          <Field icon={BellIcon}>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox が中の入力になる */}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.useDefaultReminders}
                onCheckedChange={(checked) =>
                  set("useDefaultReminders", checked === true)
                }
              />
              {form.allDay && notificationsReady
                ? "終日の予定の既定の通知を使う"
                : "カレンダーの既定の通知を使う"}
              {form.allDay && notificationsReady && (
                <span className="text-muted-foreground">
                  (
                  {allDayDefault
                    ? allDayReminderText(allDayDefault.minutes)
                    : "通知しない"}
                  )
                </span>
              )}
            </label>
            {!form.useDefaultReminders && (
              <div className="flex flex-col gap-2">
                {form.reminders.map((reminder, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同じ時刻の通知も並べられる
                    key={index}
                    className="flex items-center gap-1"
                  >
                    {form.allDay ? (
                      <AllDayReminderInput
                        minutes={reminder.minutes}
                        allowSameDay={notificationsReady}
                        onChange={(minutes) =>
                          updateReminder(index, {
                            method: reminder.method,
                            minutes,
                          })
                        }
                      />
                    ) : (
                      <SimpleSelect
                        label="通知"
                        value={String(reminder.minutes)}
                        options={
                          REMINDER_MINUTES.includes(reminder.minutes)
                            ? reminderOptions
                            : [
                                ...reminderOptions,
                                {
                                  value: String(reminder.minutes),
                                  label: reminderLabel(reminder),
                                },
                              ]
                        }
                        onChange={(value) =>
                          updateReminder(index, {
                            method: reminder.method,
                            minutes: Number(value),
                          })
                        }
                      />
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="通知を削除"
                      onClick={() => updateReminder(index, null)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
                {form.reminders.length < 5 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start text-muted-foreground"
                    onClick={() =>
                      set("reminders", [
                        ...form.reminders,
                        {
                          method: "display",
                          minutes: form.allDay
                            ? notificationsReady
                              ? ALL_DAY_REMINDER_NEW
                              : 900
                            : 10,
                        },
                      ])
                    }
                  >
                    <PlusIcon />
                    通知を追加
                  </Button>
                )}
                {orbitOnlyNote && (
                  <p
                    className="text-muted-foreground text-xs"
                    data-orbit-only-reminder
                  >
                    {orbitOnlyNote}
                  </p>
                )}
              </div>
            )}
          </Field>
          <Field icon={CalendarDaysIcon}>
            <div className="flex min-w-0 items-center gap-2">
              <SimpleSelect
                label="カレンダー"
                value={form.calendarId}
                disabled={locked}
                options={calendars.map((calendar) => ({
                  value: calendar.id,
                  label: calendar.name,
                }))}
                onChange={(value) => set("calendarId", value)}
                className="min-w-0 flex-1 justify-between"
              />
              <SimpleSelect
                label="予定あり / 空き"
                value={form.busy ? "busy" : "free"}
                options={[
                  { value: "busy", label: "予定あり" },
                  { value: "free", label: "空き" },
                ]}
                onChange={(value) => set("busy", value === "busy")}
                className="shrink-0"
              />
            </div>
            {(() => {
              const current = calendars.find((c) => c.id === form.calendarId);
              return current ? (
                <span className="flex items-center gap-2 text-muted-foreground text-xs">
                  <span
                    className="size-2.5 rounded-sm"
                    style={{ background: colorOf(current) }}
                  />
                  {current.name}
                </span>
              ) : null;
            })()}
          </Field>
          <Field icon={TextIcon}>
            <Textarea
              aria-label="メモ"
              placeholder="メモ"
              disabled={locked}
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
              className="min-h-20"
            />
            {invite.descriptionNote && (
              <p className="text-muted-foreground text-xs">
                {invite.descriptionNote}
              </p>
            )}
          </Field>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </form>
        {/* 狭い画面では「保存」を上の帯に置くので、下のボタンは出さない (Mail の作成画面と同じ)。 */}
        <DialogFooter className="shrink-0 max-sm:hidden">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={!canSave || busy}>
            {busy && <Spinner />}
            {invite.saveLabel}
          </Button>
        </DialogFooter>
        {/* 広い画面の「閉じる」(共通の部品と同じ位置)。狭い画面では上の帯の × を使う。 */}
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-4 max-sm:hidden"
            />
          }
        >
          <XIcon />
          <span className="sr-only">閉じる</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 終日の予定の通知 1 つ: 「何日前 (当日・1 日前…)」と「何時何分」(段取り 9)。
 * 値は開始日の 0:00 の何分前か (当日 9:00 = -540、1 日前 9:00 = 900)。
 * allowSameDay が false (古いサーバー) なら、負の分になる「当日」は選べない。
 */
function AllDayReminderInput({
  minutes,
  allowSameDay,
  onChange,
}: {
  minutes: number;
  allowSameDay: boolean;
  onChange: (minutes: number) => void;
}) {
  const parts = allDayReminderParts(minutes);
  const days = parts.daysBefore;
  const choices = ALL_DAY_REMINDER_DAYS.filter(
    (value) => allowSameDay || value > 0,
  );
  if (!choices.includes(days)) choices.push(days);
  choices.sort((a, b) => a - b);
  const change = (next: Partial<typeof parts>) => {
    let value = allDayReminderValue({ ...parts, ...next });
    // 当日を選べないときは、当日 0:00 (0 分) より後にしない。
    if (!allowSameDay && value < 0) value = 0;
    onChange(value);
  };
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-all-day-reminder
    >
      <SimpleSelect
        label="通知の日"
        value={String(days)}
        options={choices.map((value) => ({
          value: String(value),
          label: allDayDaysLabel(value),
        }))}
        onChange={(value) => change({ daysBefore: Number(value) })}
      />
      <Input
        type="time"
        aria-label="通知の時刻"
        step={300}
        value={timeInputValue(parts)}
        onChange={(event) => {
          const next = parseTimeInput(event.target.value);
          if (next !== null) change(next);
        }}
        className="w-auto tabular-nums"
      />
    </div>
  );
}
