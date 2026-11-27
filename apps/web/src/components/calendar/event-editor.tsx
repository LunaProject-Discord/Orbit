"use client";

import type { InviteRole } from "@orbit/core/event-invite";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
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
import { describeRule } from "@/lib/calendar/recurrence-label";

const REMINDER_MINUTES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

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
      <DialogContent sheet className="gap-4 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">{title}</DialogTitle>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="flex max-h-[min(70dvh,640px)] flex-col gap-4 overflow-y-auto px-0.5 pb-0.5"
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
            className="h-11 text-base"
          />
          <Field icon={ClockIcon}>
            <div className="flex flex-wrap items-center gap-2">
              {/* 開始・終了をそれぞれ「日付 時刻」でまとめ、狭い画面では行ごとに折り返す */}
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  aria-label="開始日"
                  disabled={locked}
                  value={form.startDate}
                  onChange={(event) =>
                    moveStart(event.target.value, form.startTime)
                  }
                  className="w-auto"
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
                <Input
                  type="date"
                  aria-label="終了日"
                  disabled={locked}
                  value={form.endDate}
                  onChange={(event) => set("endDate", event.target.value)}
                  className="w-auto"
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
                  onCheckedChange={(checked) => set("allDay", checked === true)}
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
                  <Input
                    type="date"
                    aria-label="繰り返しの最後の日"
                    disabled={locked}
                    value={form.until}
                    min={form.startDate}
                    onChange={(event) => set("until", event.target.value)}
                    className="w-auto"
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
              カレンダーの既定の通知を使う
            </label>
            {!form.useDefaultReminders && (
              <div className="flex flex-col gap-2">
                {form.reminders.map((reminder, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同じ時刻の通知も並べられる
                    key={index}
                    className="flex items-center gap-1"
                  >
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
                        { method: "display", minutes: 10 },
                      ])
                    }
                  >
                    <PlusIcon />
                    通知を追加
                  </Button>
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={!canSave || busy}>
            {busy && <Spinner />}
            {invite.saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
