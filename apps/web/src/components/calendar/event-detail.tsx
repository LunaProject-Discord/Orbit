"use client";

import { cn } from "cn";
import {
  BellIcon,
  CalendarDaysIcon,
  ClockIcon,
  MapPinIcon,
  PencilIcon,
  RepeatIcon,
  Trash2Icon,
  UsersIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { useEffect } from "react";
import { PendingBadge } from "@/components/calendar/pending-badge";
import {
  RsvpButtons,
  type RsvpChoice,
} from "@/components/calendar/rsvp-buttons";
import { type DisplayItem, itemTitle } from "@/components/calendar/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import type {
  Attendee,
  Calendar,
  CalendarEvent,
  Reminder,
} from "@/lib/calendar/api";
import type { PendingState } from "@/lib/calendar/conflict-labels";
import { formatMonthDayWeekday, formatTimeRange } from "@/lib/calendar/dates";
import type { ImipAccount } from "@/lib/calendar/imip";
import {
  allDayDefault,
  allDayReminderLabel,
  type CalendarNotificationSettingsState,
  refreshCalendarNotificationSettings,
  useCalendarNotificationSettings,
} from "@/lib/calendar/notification-settings";
import { describeRule } from "@/lib/calendar/recurrence-label";
import {
  canRespondTo,
  type RsvpAccount,
  rsvpDelivery,
} from "@/lib/calendar/rsvp";

const STATUS: Record<Attendee["status"], { label: string; tone: string }> = {
  accepted: { label: "参加", tone: "text-emerald-600" },
  declined: { label: "不参加", tone: "text-rose-500" },
  tentative: { label: "未定", tone: "text-amber-600" },
  needs_action: { label: "未返信", tone: "text-muted-foreground" },
  delegated: { label: "代理", tone: "text-muted-foreground" },
};

export function reminderLabel(reminder: Reminder): string {
  const { minutes } = reminder;
  const unit =
    minutes === 0
      ? "予定の時刻"
      : minutes % 10080 === 0
        ? `${minutes / 10080} 週間前`
        : minutes % 1440 === 0
          ? `${minutes / 1440} 日前`
          : minutes % 60 === 0
            ? `${minutes / 60} 時間前`
            : `${minutes} 分前`;
  return reminder.method === "email" ? `${unit}にメール` : `${unit}に通知`;
}

/**
 * 予定の通知の表示。終日の予定は「当日 9:00 に通知」の形で出し、既定の通知は
 * カレンダーの既定ではなく利用者ごとの「終日の予定の通知」を使う (段取り 9、設計 2.1)。
 * サーバーが予定の通知に対応していない (古いサーバー) ときは、今までどおりカレンダーの既定。
 */
export function eventReminderLabels(
  event: Pick<CalendarEvent, "useDefaultReminders" | "reminders">,
  allDay: boolean,
  calendar: Pick<Calendar, "defaultReminders"> | undefined,
  settings: CalendarNotificationSettingsState,
): string[] {
  if (!allDay) {
    const list = event.useDefaultReminders
      ? (calendar?.defaultReminders ?? [])
      : event.reminders;
    return list.map(reminderLabel);
  }
  if (!event.useDefaultReminders)
    return event.reminders.map(allDayReminderLabel);
  if (settings.status === "unsupported") {
    return (calendar?.defaultReminders ?? []).map(allDayReminderLabel);
  }
  const fallback = allDayDefault(settings);
  return fallback
    ? [allDayReminderLabel({ method: "display", minutes: fallback.minutes })]
    : [];
}

/**
 * 出欠のボタンの下の注記。繰り返しでは返事が届く範囲を、Orbit が返事のメールを送る
 * カレンダーでは送信元のアドレスを、主催者に届かないカレンダーではそのことを添える
 * (10 章の 4: 推奨 A、imip-design 12.3)。
 */
export function rsvpNote(
  item: Pick<DisplayItem, "repeating"> & {
    event: Pick<CalendarEvent, "parentId"> &
      Partial<Pick<CalendarEvent, "attendees">>;
  },
  calendar: Calendar | undefined,
  accounts: readonly ImipAccount[] | null = null,
): string | null {
  const notes: string[] = [];
  if (item.event.parentId) notes.push("この回だけに返事します");
  else if (item.repeating) notes.push("すべての回に返事します");
  if (calendar?.source === "caldav" || calendar?.source === "local") {
    const delivery = rsvpDelivery(
      { attendees: item.event.attendees ?? [] },
      calendar,
      accounts,
    );
    if (delivery.via === "mail") {
      notes.push(`返事は ${delivery.from} から主催者にメールで送ります`);
    } else if (delivery.via === "none") {
      notes.push(
        delivery.reason === "no_sender"
          ? "主催者には通知されません (返事を送れるメールアカウントがありません)"
          : "主催者には通知されません (このカレンダーにだけ記録します)",
      );
    }
  }
  return notes.length > 0 ? notes.join("\n") : null;
}

/** 招待メールの送信の状態の文言 (imip-design 6.5、12.3)。送り終えていれば null。 */
export function inviteDeliveryLabel(
  event: Pick<CalendarEvent, "inviteDelivery">,
): string | null {
  switch (event.inviteDelivery) {
    case "pending":
      return "招待メールを送信中";
    case "failed":
      return "招待メールを送れませんでした";
    default:
      return null;
  }
}

/** 自分の出欠 (未返信と代理は null)。 */
function myStatus(event: CalendarEvent): Attendee["status"] | null {
  const status = event.attendees.find((attendee) => attendee.self)?.status;
  return status === "accepted" ||
    status === "tentative" ||
    status === "declined"
    ? status
    : null;
}

/** HTML のメモ (Graph などから届く) を、そのまま文字として見せられる形にする。 */
function plainText(value: string): string {
  if (!/<[a-z][\s\S]*>/i.test(value)) return value;
  const doc = new DOMParser().parseFromString(value, "text/html");
  return doc.body.textContent ?? "";
}

type DetailProps = {
  calendar: Calendar | undefined;
  calendarLabel: string;
  /** 送信待ちの状態 (無ければ null)。 */
  pending?: PendingState | null;
  /** サーバーに届かない状態か。 */
  offline?: boolean;
  /** 送信できなかった操作の「確認する」(反映されなかった変更の一覧を開く)。 */
  onShowConflicts?: (() => void) | null;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
  /** 出欠を返す (返せない予定・画面では null)。 */
  onRespond?: ((status: RsvpChoice) => void) | null;
  /**
   * アカウントの一覧 (self の参加者がアカウントの持ち主かの判定と、返事のメールの
   * 送信元に使う)。
   */
  accounts?: readonly (RsvpAccount & ImipAccount)[] | null;
  onClose: () => void;
};

function DetailBody({
  item,
  calendar,
  calendarLabel,
  pending = null,
  offline = false,
  onShowConflicts = null,
  onEdit,
  onDelete,
  onRespond = null,
  accounts = null,
  onClose,
}: DetailProps & { item: DisplayItem }) {
  const { event, local } = item;
  // 出欠のボタン: 招待された予定で、取り消されておらず、カレンダーに書き込めるとき (7.1)。
  // 出欠に対応していない古いサーバーと、self がアカウントの持ち主でない共有カレンダーでは出さない。
  const canRespond =
    onRespond !== null &&
    !item.readOnly &&
    event.status !== "cancelled" &&
    canRespondTo(event, calendar, accounts);
  const notificationSettings = useCalendarNotificationSettings();
  useEffect(() => {
    if (local.allDay) void refreshCalendarNotificationSettings();
  }, [local.allDay]);
  const reminders = eventReminderLabels(
    event,
    local.allDay,
    calendar,
    notificationSettings,
  );
  // カレンダーの通知がオフなら、通知の時刻に添えて知らせる (段取り 9、設計 2.5)。
  const muted = calendar?.notify === false;
  const counts = event.attendees.reduce(
    (acc, attendee) => {
      acc[attendee.status] = (acc[attendee.status] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<Attendee["status"], number>>,
  );
  const delivery = inviteDeliveryLabel(event);
  const date = formatMonthDayWeekday(local.firstDay);
  const range = formatTimeRange(local);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span
          className="mt-1.5 size-3 shrink-0 rounded-sm"
          style={{ background: item.color }}
        />
        <div className="min-w-0 flex-1">
          <p className="break-words font-display font-semibold text-lg leading-snug">
            {itemTitle(item)}
          </p>
          <p className="text-muted-foreground text-sm">
            {local.allDay && range !== "終日" ? range : `${date} ${range}`}
          </p>
        </div>
        <div className="-mt-1 -mr-1 flex shrink-0">
          {onEdit && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="編集"
              onClick={onEdit}
            >
              <PencilIcon />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="削除"
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="閉じる"
            onClick={onClose}
            className="max-sm:hidden"
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <PendingBadge
        state={pending}
        offline={offline}
        onShowDetails={onShowConflicts}
        className="ml-6"
      />
      <div className="flex flex-col gap-2 text-sm">
        {item.repeating && (
          <p className="flex items-center gap-3">
            <RepeatIcon className="size-4 shrink-0 text-muted-foreground" />
            {describeRule(item.event.rrule) ?? "繰り返し"}
          </p>
        )}
        {event.conferenceUrl && (
          <p className="flex min-w-0 items-center gap-3">
            <VideoIcon className="size-4 shrink-0 text-muted-foreground" />
            <a
              href={event.conferenceUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate text-primary underline-offset-4 hover:underline"
            >
              オンライン会議に参加
            </a>
          </p>
        )}
        {event.location && (
          <p className="flex items-start gap-3">
            <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="break-words">{event.location}</span>
          </p>
        )}
        {reminders.length > 0 && (
          <p className="flex items-start gap-3">
            <BellIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className={cn(muted && "text-muted-foreground")}>
                {reminders.join("、")}
              </span>
              {muted && (
                <span className="block text-muted-foreground text-xs">
                  このカレンダーの通知はオフです
                </span>
              )}
            </span>
          </p>
        )}
        <p className="flex items-center gap-3">
          <CalendarDaysIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{calendarLabel}</span>
        </p>
        {event.attendees.length > 0 && (
          <div className="flex items-start gap-3">
            <UsersIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p>
                参加者 {event.attendees.length} 人{" "}
                <span className="text-muted-foreground text-xs">
                  {(
                    [
                      "accepted",
                      "tentative",
                      "declined",
                      "needs_action",
                    ] as const
                  )
                    .filter((status) => counts[status])
                    .map(
                      (status) => `${STATUS[status].label} ${counts[status]}`,
                    )
                    .join(" · ")}
                </span>
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {event.attendees.map((attendee) => {
                  const name = attendee.name || attendee.email;
                  const organizer =
                    event.organizer?.email.toLowerCase() ===
                    attendee.email.toLowerCase();
                  const comment = attendee.comment?.trim();
                  return (
                    <li
                      key={attendee.email}
                      className="flex items-start gap-2 text-sm"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px]">
                        {name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="flex min-h-6 min-w-0 flex-1 flex-col justify-center">
                        <span className="truncate">
                          {name}
                          {attendee.self && " (自分)"}{" "}
                          {organizer && (
                            <span className="text-muted-foreground text-xs">
                              主催者
                            </span>
                          )}
                        </span>
                        {comment && (
                          <span className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground text-xs">
                            {comment}
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs leading-6",
                          STATUS[attendee.status].tone,
                        )}
                      >
                        {STATUS[attendee.status].label}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {delivery && (
                <p
                  className={cn(
                    "mt-1.5 flex flex-wrap items-center gap-x-2 text-xs",
                    event.inviteDelivery === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {delivery}
                  {event.inviteDelivery === "failed" && onShowConflicts && (
                    <button
                      type="button"
                      onClick={onShowConflicts}
                      className="text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      確認する
                    </button>
                  )}
                </p>
              )}
            </div>
          </div>
        )}
        {event.description && (
          <p className="flex items-start gap-3">
            <ClockIcon className="invisible size-4 shrink-0" />
            <span className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
              {plainText(event.description)}
            </span>
          </p>
        )}
      </div>
      {canRespond && onRespond && (
        <div className="border-t pt-3">
          <RsvpButtons
            value={myStatus(event)}
            onChange={onRespond}
            note={rsvpNote(item, calendar, accounts)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 予定の詳細。広い画面では予定の横に出し、狭い画面では下から出るシートにする。
 */
export function EventDetail({
  item,
  anchor,
  onClose,
  ...rest
}: DetailProps & {
  item: DisplayItem | null;
  anchor: HTMLElement | null;
}) {
  return (
    <Popover
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item && (
        <PopoverContent
          anchor={anchor}
          side="right"
          align="start"
          sideOffset={8}
          className="w-[380px] max-w-[calc(100vw-2rem)] p-4"
        >
          <DetailBody item={item} onClose={onClose} {...rest} />
        </PopoverContent>
      )}
    </Popover>
  );
}
