"use client";

import { cn } from "cn";
import {
  CalendarClockIcon,
  CalendarX2Icon,
  MapPinIcon,
  RepeatIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Temporal } from "temporal-polyfill";
import { OrbitAppIcon } from "@/components/brand/orbit-logo";
import { PendingBadge } from "@/components/calendar/pending-badge";
import { RsvpButtons } from "@/components/calendar/rsvp-buttons";
import { Button } from "@/components/ui/button";
import {
  type Attachment,
  fetchMessageInvite,
  type MessageInvite,
} from "@/lib/api";
import { navigateApp } from "@/lib/app-navigation";
import { hasInvitePart } from "@/lib/attachments";
import type {
  Calendar,
  CalendarEvent,
  EventRange,
  Occurrence,
} from "@/lib/calendar/api";
import { pendingState } from "@/lib/calendar/conflict-labels";
import {
  formatMonthDayWeekday,
  formatTimeRange,
  localTimeZone,
  toLocal,
} from "@/lib/calendar/dates";
import {
  type CalendarClient,
  type EventRangeQuery,
  useCalendarData,
} from "@/lib/calendar/offline";
import { buildCalendarRoute } from "@/lib/calendar/route";
import {
  canRespondTo,
  needsAccounts,
  type RsvpAccount,
} from "@/lib/calendar/rsvp";
import { listAccounts } from "@/lib/offline";
import { useOnline } from "@/lib/offline/network";

/**
 * メールの招待カード (calendar-dev/invites-design.md の 6.1 と 7.3)。
 * 本文の上に、招待の日時・場所・主催者と、カレンダーに同じ予定 (UID) があるときは出欠のボタンを出す。
 *
 * 8a ではメールの中身から予定を作る・変える・消すことはしない。カレンダーに同じ予定があるときは、
 * 表示もカレンダーの値を使い、返事はその予定に対して CalendarClient.respond で送る
 * (偽のメールでできるのは「本物の予定のカードを出す」ことだけ。9 章)。
 */

export type InviteState = {
  /** 招待の中身。招待が無い・読めない・オフラインなら null。 */
  invite: MessageInvite | null;
};

/**
 * メールの招待を読む。添付に招待 (text/calendar か .ics) があり、つながっているときだけ API を呼ぶ。
 * 読めなかったとき (エラーを含む) は invite: null で、カードを出さない。
 */
export function useMessageInvite(message: {
  id: string;
  attachments: readonly Pick<Attachment, "contentType" | "filename">[];
}): InviteState {
  const online = useOnline();
  const wanted = hasInvitePart(message.attachments);
  const [loaded, setLoaded] = useState<{
    id: string;
    invite: MessageInvite | null;
  } | null>(null);
  const messageId = message.id;
  const shouldFetch = wanted && online && loaded?.id !== messageId;
  useEffect(() => {
    if (!shouldFetch) return;
    const controller = new AbortController();
    fetchMessageInvite(messageId, controller.signal)
      .then((invite) => setLoaded({ id: messageId, invite }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ id: messageId, invite: null });
        }
      });
    return () => controller.abort();
  }, [shouldFetch, messageId]);
  // オフラインのときはカードを出さない (6.1)。
  if (!wanted || !online || loaded?.id !== messageId) return { invite: null };
  return { invite: loaded.invite };
}

/**
 * アカウントの一覧。渡されていればそれを使い、無ければ wanted のときだけ端末の控えから読む
 * (self の参加者がアカウントの持ち主かを見るため)。
 */
function useRsvpAccounts(
  given: readonly RsvpAccount[] | null | undefined,
  wanted: boolean,
): readonly RsvpAccount[] | null {
  const [loaded, setLoaded] = useState<readonly RsvpAccount[] | null>(null);
  const load = wanted && loaded === null;
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    listAccounts(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setLoaded(list);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [load]);
  return given !== undefined ? given : loaded;
}

type Shown = {
  summary: string | null;
  location: string | null;
  organizer: { email: string; name: string | null } | null;
  attendeeCount: number;
  rrule: string | null;
  occurrence: Occurrence;
};

function occurrenceOfTime(
  time: MessageInvite["time"],
  recurrenceId: string | null,
): Occurrence {
  return {
    eventId: "",
    masterId: "",
    recurrenceId,
    allDay: time.allDay,
    startAt: time.allDay ? null : time.startAt,
    endAt: time.allDay ? null : time.endAt,
    startDate: time.allDay ? time.startDate : null,
    endDate: time.allDay ? time.endDate : null,
  };
}

function occurrenceOfInvite(invite: MessageInvite): Occurrence {
  return occurrenceOfTime(invite.time, invite.recurrenceId);
}

function occurrenceOfEvent(event: CalendarEvent): Occurrence {
  return {
    eventId: event.id,
    masterId: event.parentId ?? event.id,
    recurrenceId: event.recurrenceId,
    allDay: event.allDay,
    startAt: event.startAt,
    endAt: event.endAt,
    startDate: event.startDate,
    endDate: event.endDate,
  };
}

/**
 * 予定を探す期間。カレンダーの予定の日時 (eventTime) があればそれ、無ければ (古いサーバー)
 * メールの日時の、前後 1 日 (端末のタイムゾーンでの日付)。
 * メールと予定の日時がずれていても (主催者が後から動かした等)、予定を見つけられる。
 */
export function inviteRange(
  invite: MessageInvite,
  timeZone: string,
): EventRangeQuery {
  const local = toLocal(
    invite.eventTime
      ? occurrenceOfTime(invite.eventTime, invite.recurrenceId)
      : occurrenceOfInvite(invite),
    timeZone,
  );
  const first = local?.firstDay ?? Temporal.Now.plainDateISO(timeZone);
  const last = local?.lastDay ?? first;
  return {
    from: first.subtract({ days: 1 }).toString(),
    to: last.add({ days: 2 }).toString(),
    timeZone,
  };
}

/** 日時の 1 行 (「12月10日(木) 10:00〜11:00」)。 */
export function inviteWhen(
  occurrence: Occurrence,
  timeZone: string,
): string | null {
  const local = toLocal(occurrence, timeZone);
  if (!local) return null;
  const range = formatTimeRange(local);
  if (
    local.allDay &&
    Temporal.PlainDate.compare(local.firstDay, local.lastDay) !== 0
  ) {
    return range;
  }
  return `${formatMonthDayWeekday(local.firstDay)} ${range}`;
}

/**
 * 同じ時間帯のほかの予定の数。招待の予定そのもの (同じ予定の回) と、取り消された予定は数えない。
 */
export function overlappingCount(
  data: EventRange,
  occurrence: Occurrence,
  timeZone: string,
  excludeEventId: string | null,
): number {
  const target = toLocal(occurrence, timeZone);
  if (!target) return 0;
  const byId = new Map(data.events.map((event) => [event.id, event]));
  const exclude = excludeEventId ? byId.get(excludeEventId) : undefined;
  const excluded = new Set(
    [excludeEventId, exclude?.parentId].filter(Boolean) as string[],
  );
  const cmp = Temporal.ZonedDateTime.compare;
  let count = 0;
  for (const item of data.occurrences) {
    if (excluded.has(item.eventId) || excluded.has(item.masterId)) continue;
    const event = byId.get(item.eventId);
    if (!event || event.status === "cancelled") continue;
    const local = toLocal(item, timeZone);
    if (!local) continue;
    if (cmp(local.start, target.end) < 0 && cmp(target.start, local.end) < 0) {
      count += 1;
    }
  }
  return count;
}

function personLabel(person: { email: string; name?: string | null }): string {
  return person.name?.trim() || person.email;
}

const REPLY_LABELS: Record<
  NonNullable<MessageInvite["reply"]>["status"],
  string
> = {
  accepted: "参加します",
  tentative: "未定です",
  declined: "参加しません",
  needs_action: "まだ返事をしていません",
  delegated: "代理を立てました",
};

/**
 * 招待のカード。invite は useMessageInvite で読んだもの。
 * client を渡すとそれを使う (テスト用)。渡さなければ開いている CalendarClient を使う。
 */
export function InviteCard({
  invite,
  accountId,
  client: givenClient = null,
  accounts: givenAccounts,
  timeZone: givenTimeZone,
  className,
}: {
  invite: MessageInvite;
  /** メールのアカウント。「カレンダーにまだ届いていません」を出すかの判定に使う。 */
  accountId: string;
  client?: CalendarClient | null;
  /** アカウントの一覧。渡さなければ、要るときだけ読む。 */
  accounts?: readonly RsvpAccount[] | null;
  timeZone?: string;
  className?: string;
}) {
  const timeZone = givenTimeZone ?? localTimeZone();
  const online = useOnline();
  const range = useMemo(
    () => inviteRange(invite, timeZone),
    [invite, timeZone],
  );
  const { client, calendars, data, queue } = useCalendarData(
    range,
    givenClient,
  );
  const event = invite.eventId
    ? (data?.events.find((entry) => entry.id === invite.eventId) ?? null)
    : null;
  const calendar: Calendar | undefined = event
    ? calendars?.find((entry) => entry.id === event.calendarId)
    : undefined;
  const accounts = useRsvpAccounts(
    givenAccounts,
    needsAccounts(calendar) && givenAccounts === undefined,
  );

  // カレンダーに同じ予定があれば、表示はカレンダーの値を使う (9 章)。
  const shown: Shown = event
    ? {
        summary: event.summary,
        location: event.location,
        organizer: event.organizer
          ? { email: event.organizer.email, name: event.organizer.name ?? null }
          : null,
        attendeeCount: event.attendees.length,
        rrule: event.rrule,
        occurrence: occurrenceOfEvent(event),
      }
    : {
        summary: invite.summary,
        location: invite.location,
        organizer: invite.organizer,
        attendeeCount: invite.attendeeCount,
        rrule: invite.rrule,
        occurrence: occurrenceOfInvite(invite),
      };
  const when = inviteWhen(shown.occurrence, timeZone);
  const overlaps =
    data && invite.method !== "cancel" && invite.method !== "reply"
      ? overlappingCount(data, shown.occurrence, timeZone, invite.eventId)
      : 0;

  const request = invite.method === "request";
  const cancelled = invite.method === "cancel";
  const reply = invite.method === "reply" ? invite.reply : null;
  const latestSequence = event?.sequence ?? invite.eventSequence;
  // 「更新されています」は、カレンダーの予定を見つけて、その値を表示しているときだけ。
  const outdated =
    request &&
    event !== null &&
    latestSequence !== null &&
    invite.sequence < latestSequence;
  const me = event?.attendees.find((attendee) => attendee.self) ?? null;
  // ボタンを出すのは、カレンダーに同じ予定があり、自分 (アカウントの持ち主) が参加者として
  // 返事を送れるときだけ。読み込み中 (data が無い) は押せないボタンを出しておく。
  const showButtons =
    request &&
    invite.eventId !== null &&
    (event === null ? !data : canRespondTo(event, calendar, accounts));
  const buttonsDisabled =
    client === null ||
    event === null ||
    event.status === "cancelled" ||
    calendar?.readOnly === true;
  const notArrived =
    request &&
    invite.eventId === null &&
    (calendars ?? []).some(
      (entry) =>
        entry.accountId === accountId &&
        (entry.source === "google" || entry.source === "microsoft"),
    );
  const pending =
    invite.eventId && client
      ? pendingState(
          queue.filter(
            (op) => op.kind === "respond" && op.eventId === invite.eventId,
          ),
        )
      : null;
  const openDate = Temporal.PlainDate.from(
    shown.occurrence.allDay
      ? (shown.occurrence.startDate ?? Temporal.Now.plainDateISO(timeZone))
      : Temporal.Instant.from(
          shown.occurrence.startAt ?? Temporal.Now.instant().toString(),
        )
          .toZonedDateTimeISO(timeZone)
          .toPlainDate(),
  );

  return (
    <section
      aria-label="招待"
      data-slot="invite-card"
      className={cn(
        "mx-4 my-3 flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-xs sm:mx-6",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <OrbitAppIcon product="calendar" className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">
            {cancelled
              ? "予定の取り消し"
              : reply
                ? `${personLabel(reply)} さんからの出欠の返事`
                : "招待"}
          </p>
          <p
            className={cn(
              "break-words font-display font-semibold text-base leading-snug",
              cancelled && "text-muted-foreground line-through",
            )}
          >
            {shown.summary || "(タイトルなし)"}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 text-sm">
        {when && (
          <p className="flex items-center gap-3">
            <CalendarClockIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 break-words">{when}</span>
          </p>
        )}
        {shown.rrule && (
          <p className="flex items-center gap-3">
            <RepeatIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span>繰り返しの予定</span>
          </p>
        )}
        {shown.location && (
          <p className="flex items-start gap-3">
            <MapPinIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 break-words">{shown.location}</span>
          </p>
        )}
        {shown.organizer && (
          <p className="flex items-center gap-3">
            <UserRoundIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate">
              主催者: {personLabel(shown.organizer)}
            </span>
          </p>
        )}
        {shown.attendeeCount > 0 && (
          <p className="flex items-center gap-3">
            <UsersIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span>参加者 {shown.attendeeCount} 人</span>
          </p>
        )}
      </div>

      {overlaps > 0 && (
        <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-amber-800 text-xs dark:text-amber-300">
          この時間に {overlaps} 件の予定があります
        </p>
      )}

      {cancelled && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <CalendarX2Icon aria-hidden="true" className="size-4 shrink-0" />
          この予定は取り消されました
        </p>
      )}

      {reply && (
        <p className="text-sm">
          {personLabel(reply)} さん: {REPLY_LABELS[reply.status]}
        </p>
      )}

      {outdated && (
        <p className="text-muted-foreground text-xs">
          この招待は更新されています。最新の内容を表示しています。
        </p>
      )}

      {notArrived && (
        <p className="text-muted-foreground text-xs">
          カレンダーにまだ届いていません
        </p>
      )}

      {showButtons && invite.eventId && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <RsvpButtons
            value={me && me.status !== "needs_action" ? me.status : null}
            disabled={buttonsDisabled}
            onChange={(status) => {
              if (invite.eventId) client?.respond(invite.eventId, status);
            }}
            note={
              event?.rrule
                ? "すべての回に返事します"
                : event?.recurrenceId
                  ? "この回だけに返事します"
                  : null
            }
          />
          <PendingBadge state={pending} offline={!online} />
        </div>
      )}

      {invite.eventId && (
        <div className="flex">
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => navigateApp(buildCalendarRoute("day", openDate))}
          >
            カレンダーで開く
          </Button>
        </div>
      )}
    </section>
  );
}
