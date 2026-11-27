"use client";

import type {
  InviteAction,
  InviteApplyErrorCode,
  InviteApplyExpect,
  InviteApplyRequest,
  InviteApplyResult,
  InviteBlocked,
} from "@orbit/core/event-invite";
import { cn } from "cn";
import {
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarX2Icon,
  CircleAlertIcon,
  MapPinIcon,
  RepeatIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Temporal } from "temporal-polyfill";
import { OrbitAppIcon } from "@/components/brand/orbit-logo";
import { PendingBadge } from "@/components/calendar/pending-badge";
import {
  RsvpButtons,
  type RsvpChoice,
} from "@/components/calendar/rsvp-buttons";
import { SimpleSelect } from "@/components/calendar/simple-select";
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
import { Spinner } from "@/components/ui/spinner";
import {
  ApiError,
  type Attachment,
  applyMessageInvite,
  fetchMessageInvite,
  type MessageInvite,
  NetworkError,
} from "@/lib/api";
import { navigateApp } from "@/lib/app-navigation";
import { hasInvitePart } from "@/lib/attachments";
import type {
  Calendar,
  CalendarEvent,
  EventRange,
  Occurrence,
} from "@/lib/calendar/api";
import { errorReasonLabel, pendingState } from "@/lib/calendar/conflict-labels";
import {
  formatMonthDayWeekday,
  formatTimeRange,
  localTimeZone,
  toLocal,
} from "@/lib/calendar/dates";
import {
  type CalendarClient,
  type EventRangeQuery,
  OfflineCalendarClient,
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
  /** 読み直す (カードを出した後に状況が変わったとき)。 */
  reload: () => void;
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
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);
  const shouldFetch = wanted && online && loaded?.id !== messageId;
  // reload で読み直すときは、いまのカードを出したまま読む (消えてまた出るとちらつく)。
  const lastGeneration = useRef(generation);
  useEffect(() => {
    if (lastGeneration.current === generation) return;
    lastGeneration.current = generation;
    if (!wanted || !online) return;
    const controller = new AbortController();
    fetchMessageInvite(messageId, controller.signal)
      .then((invite) => setLoaded({ id: messageId, invite }))
      .catch(() => {});
    return () => controller.abort();
  }, [generation, wanted, online, messageId]);
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
  if (!wanted || !online || loaded?.id !== messageId) {
    return { invite: null, reload };
  }
  return { invite: loaded.invite, reload };
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

const RSVP_SHORT: Record<string, string> = {
  accepted: "参加",
  tentative: "未定",
  declined: "不参加",
  needs_action: "未返信",
  delegated: "代理",
};

/** 操作できない理由の文 (imip-design 12.5)。 */
export function inviteBlockedLabel(
  blocked: InviteBlocked | null | undefined,
  method: MessageInvite["method"],
): string | null {
  switch (blocked) {
    case "sender_mismatch":
      return method === "reply"
        ? "差出人と返事をした人が違うため、反映できません"
        : "差出人と主催者が違うため、反映できません";
    case "sender_unverified":
      return "送信元の確認に失敗したメールのため、反映できません";
    case "own_event":
      return "自分が主催する予定のため、メールからは変更できません";
    case "not_attendee_of_event":
      return "参加者に含まれていない人からの返事です";
    case "occurrence_unsupported":
      return "この回だけの返事は反映できません";
    case "no_calendar":
      return "追加できるカレンダーがありません";
    case "server_calendar":
      return "出欠はカレンダーのサービスが反映します";
    case "unsupported_method":
      return "この種類の招待メールには対応していません";
    default:
      return null;
  }
}

/** apply の失敗の文。changed は読み直しが要る。 */
function applyErrorLabel(
  error: unknown,
  method: MessageInvite["method"],
): string {
  if (error instanceof NetworkError) {
    return "接続していないので、いまは操作できません。";
  }
  if (error instanceof ApiError && error.status === 409) {
    const code = error.code as InviteApplyErrorCode | null;
    if (code === "changed") {
      return "カードを出した後に予定の状況が変わりました。表示を更新しました。";
    }
    const label = inviteBlockedLabel(code as InviteBlocked | null, method);
    if (label) return label;
    if (
      error.code === "calendar_disabled" ||
      error.code === "calendar_sync_stopped"
    ) {
      return `${errorReasonLabel(error.code)}。`;
    }
  }
  if (error instanceof ApiError && error.status === 404) {
    return "メールが見つかりませんでした。";
  }
  return "反映できませんでした。もう一度お試しください。";
}

/**
 * 済んだ操作の文 (done)。サーバーは取り込み済みの招待を update / done、取り消しで
 * 対象の予定が無いものを remove / done で返す。後者は「この予定は取り消されました」だけを
 * 出すので null。
 */
function doneLabel(
  action: InviteAction,
  invite: MessageInvite,
  justApplied: boolean,
): string | null {
  switch (action) {
    case "import":
      return "カレンダーに追加しました";
    case "update":
      return justApplied ? "更新を反映しました" : "カレンダーに追加済みです";
    case "remove":
      return justApplied ? "カレンダーから削除しました" : null;
    case "apply_reply":
      return justApplied && invite.reply
        ? `${personLabel(invite.reply)} さんの返事 (${RSVP_SHORT[invite.reply.status]}) を予定に反映しました`
        : "反映済みです";
    default:
      return "反映済みです";
  }
}

type ApplyFn = (
  body: InviteApplyRequest,
) => Promise<InviteApplyResult<CalendarEvent>>;

/**
 * 招待のカード。invite は useMessageInvite で読んだもの。
 * client を渡すとそれを使う (テスト用)。渡さなければ開いている CalendarClient を使う。
 */
export function InviteCard({
  invite,
  accountId,
  messageId = null,
  apply: givenApply,
  onReload,
  client: givenClient = null,
  accounts: givenAccounts,
  timeZone: givenTimeZone,
  className,
}: {
  invite: MessageInvite;
  /** メールの ID (取り込み・反映の apply に使う)。無ければ操作を出さない。 */
  messageId?: string | null;
  /** apply の呼び出し (テスト用)。渡さなければ API を呼ぶ。 */
  apply?: ApplyFn;
  /** 招待を読み直す (apply が 409 changed のとき)。 */
  onReload?: () => void;
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
  // 8b: サーバーが決めた操作 (古いサーバーでは無い)。
  const action = invite.action;
  const imip = action !== undefined;
  const apply: ApplyFn | null =
    givenApply ??
    (messageId
      ? (body) => applyMessageInvite<CalendarEvent>(messageId, body)
      : null);
  /** この画面で済ませた操作 (サーバーの結果)。 */
  const [result, setResult] = useState<{
    action: InviteApplyExpect;
    eventId: string | null;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notAddressed, setNotAddressed] = useState(false);
  /** 確認を挟む取り込み (送信元を確認できていない)。status は一緒に返す出欠。 */
  const [confirming, setConfirming] = useState<{
    status: RsvpChoice | null;
  } | null>(null);
  const defaultCalendarId =
    invite.calendars?.find((entry) => entry.default)?.id ??
    invite.calendars?.[0]?.id ??
    "";
  const [targetCalendarId, setTargetCalendarId] = useState(defaultCalendarId);
  useEffect(() => {
    setTargetCalendarId(defaultCalendarId);
  }, [defaultCalendarId]);
  // 別の招待を出したら、この画面の結果を捨てる。
  const inviteKey = `${messageId ?? ""}|${invite.uid}|${invite.sequence}|${invite.action ?? ""}|${invite.actionState ?? ""}`;
  const lastKey = useRef(inviteKey);
  useEffect(() => {
    if (lastKey.current === inviteKey) return;
    lastKey.current = inviteKey;
    setResult(null);
    setApplyError(null);
    setNotAddressed(false);
  }, [inviteKey]);

  const eventId = result ? result.eventId : invite.eventId;
  const event = eventId
    ? (data?.events.find((entry) => entry.id === eventId) ?? null)
    : null;
  const calendar: Calendar | undefined = event
    ? calendars?.find((entry) => entry.id === event.calendarId)
    : undefined;
  const accounts = useRsvpAccounts(
    givenAccounts,
    needsAccounts(calendar) && givenAccounts === undefined,
  );

  // カレンダーに同じ予定があれば、表示はカレンダーの値を使う (9 章)。ただし更新を
  // 反映する前の「更新を反映」では、メールの新しい内容を見せる。
  const showEvent =
    event !== null &&
    !(
      action === "update" &&
      result === null &&
      (invite.actionState === "ready" || invite.actionState === "confirm")
    );
  const shown: Shown =
    event && showEvent
      ? {
          summary: event.summary,
          location: event.location,
          organizer: event.organizer
            ? {
                email: event.organizer.email,
                name: event.organizer.name ?? null,
              }
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
      ? overlappingCount(data, shown.occurrence, timeZone, eventId)
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
    eventId !== null &&
    (event === null ? !data : canRespondTo(event, calendar, accounts));
  const buttonsDisabled =
    client === null ||
    event === null ||
    event.status === "cancelled" ||
    calendar?.readOnly === true;
  const notArrived =
    request &&
    eventId === null &&
    (!imip || action === "none") &&
    (calendars ?? []).some(
      (entry) =>
        entry.accountId === accountId &&
        (entry.source === "google" || entry.source === "microsoft"),
    );
  const pending =
    eventId && client
      ? pendingState(
          queue.filter((op) => op.kind === "respond" && op.eventId === eventId),
        )
      : null;
  const authPending = invite.sender?.auth === "pending";
  // 自動の反映 (auto) はやめた (8b のレビュー指摘 1)。古い API が auto を返しても、ボタンで反映する。
  const state =
    result !== null
      ? "done"
      : invite.actionState === "auto"
        ? "ready"
        : invite.actionState;
  const shownAction: InviteAction | undefined = result?.action ?? action;

  const run = async (
    expect: InviteApplyExpect,
    options: { confirmed?: boolean; status?: RsvpChoice | null } = {},
  ) => {
    if (!apply) return;
    setApplying(true);
    setApplyError(null);
    try {
      const response = await apply({
        expect,
        ...(expect === "import" && targetCalendarId
          ? { calendarId: targetCalendarId }
          : {}),
        ...(options.confirmed ? { confirmed: true } : {}),
      });
      const nextId =
        expect === "remove" ? null : (response.eventId ?? eventId ?? null);
      setResult({ action: expect, eventId: nextId });
      // 取り込んだ予定を、SSE を待たずに端末の控えへ入れる。
      if (client instanceof OfflineCalendarClient) {
        await client.pull().catch(() => {});
      }
      if (options.status && nextId) {
        // 取り込んだ予定に自分の参加者がいなければ (転送された招待など)、返事はしない。
        const addressed = response.event
          ? response.event.attendees.some((attendee) => attendee.self)
          : true;
        if (addressed) client?.respond(nextId, options.status);
        else setNotAddressed(true);
      }
    } catch (error) {
      setApplyError(applyErrorLabel(error, invite.method));
      if (error instanceof ApiError && error.code === "changed") onReload?.();
    } finally {
      setApplying(false);
    }
  };
  const start = (expect: InviteApplyExpect, status: RsvpChoice | null) => {
    if (applying || authPending) return;
    if (invite.actionState === "confirm") setConfirming({ status });
    else void run(expect, { status });
  };

  const calendarOptions = (invite.calendars ?? []).map((entry) => ({
    value: entry.id,
    label:
      calendars?.find((calendar) => calendar.id === entry.id)?.name ??
      "カレンダー",
  }));
  const actionDisabled = applying || authPending || apply === null;
  const replyLabel = reply
    ? `${personLabel(reply)} さんからの出欠の返事 (${RSVP_SHORT[reply.status]})`
    : null;
  // 送信元の確認がまだなら、送信元の理由で止めていても「確認中」を先に出す。
  const blockedLabel =
    state === "blocked" &&
    !(authPending && invite.blocked === "sender_unverified")
      ? inviteBlockedLabel(invite.blocked, invite.method)
      : null;
  const done =
    state === "done" && shownAction
      ? doneLabel(shownAction, invite, result !== null)
      : null;
  const senderNote =
    invite.sender && !invite.sender.matches && shown.organizer
      ? `差出人 (${invite.sender.email}) と主催者 (${shown.organizer.email}) が違います`
      : null;
  const confirmReason =
    invite.actionState === "confirm"
      ? (invite.confirmReason ??
        (action === "import" ? "sender_failed" : "sender_unverified"))
      : null;
  const unverifiedNote =
    confirmReason === "sequence_jump"
      ? "招待の版 (SEQUENCE) が大きく飛んでいます。主催者からの連絡か確かめてから反映してください。"
      : confirmReason !== null ||
          (invite.sender?.auth === "unknown" && state === "ready")
        ? action === "import"
          ? "このメールは送信元を確認できませんでした。差出人をよく確かめてから追加してください。"
          : "送信元を確認できていません。主催者からの連絡か確かめてから反映してください。"
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

      {outdated && !imip && (
        <p className="text-muted-foreground text-xs">
          この招待は更新されています。最新の内容を表示しています。
        </p>
      )}

      {notArrived && (
        <p className="text-muted-foreground text-xs">
          カレンダーにまだ届いていません
        </p>
      )}

      {imip && (action !== "none" || state === "blocked") && (
        <div className="flex flex-col gap-2.5 border-t pt-3 text-sm">
          {done && (
            <p className="flex items-center gap-2">
              <CalendarCheckIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500"
              />
              {done}
            </p>
          )}
          {state === "stale" && (
            <p className="text-muted-foreground">
              {invite.method === "reply"
                ? "変更前の予定への返事です"
                : "この招待は更新されています"}
            </p>
          )}
          {authPending && state !== "done" && state !== "stale" && (
            <p className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              送信元を確認中です
            </p>
          )}
          {blockedLabel && (
            <p className="flex items-start gap-2 text-muted-foreground">
              <CircleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500"
              />
              {blockedLabel}
            </p>
          )}
          {(state === "ready" || state === "confirm") && (
            <>
              {unverifiedNote && (
                <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-amber-800 text-xs dark:text-amber-300">
                  {unverifiedNote}
                </p>
              )}
              {senderNote && action === "import" && (
                <p className="text-muted-foreground text-xs">{senderNote}</p>
              )}
              {action === "import" && (
                <div className="flex flex-wrap items-center gap-2">
                  {calendarOptions.length > 1 ? (
                    <SimpleSelect
                      label="追加するカレンダー"
                      value={targetCalendarId}
                      options={calendarOptions}
                      disabled={actionDisabled}
                      onChange={setTargetCalendarId}
                      className="min-w-0 max-w-full flex-1 justify-between sm:flex-none"
                    />
                  ) : calendarOptions[0] ? (
                    <span className="min-w-0 truncate text-muted-foreground">
                      {calendarOptions[0].label}
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={actionDisabled}
                    onClick={() => start("import", null)}
                  >
                    {applying && <Spinner />}
                    カレンダーに追加
                  </Button>
                </div>
              )}
              {action === "update" && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>この招待は更新されています</span>
                  <Button
                    size="sm"
                    disabled={actionDisabled}
                    onClick={() => start("update", null)}
                  >
                    {applying && <Spinner />}
                    更新を反映
                  </Button>
                </div>
              )}
              {action === "remove" && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    カレンダーにある予定を削除できます
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionDisabled}
                    className="text-destructive"
                    onClick={() => start("remove", null)}
                  >
                    {applying && <Spinner />}
                    カレンダーから削除
                  </Button>
                </div>
              )}
              {action === "apply_reply" && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">{replyLabel}</span>
                  <Button
                    size="sm"
                    disabled={actionDisabled}
                    onClick={() => start("apply_reply", null)}
                  >
                    {applying && <Spinner />}
                    出欠に反映
                  </Button>
                </div>
              )}
              {action === "import" && request && (
                <RsvpButtons
                  value={null}
                  disabled={actionDisabled}
                  onChange={(status) => start("import", status)}
                  note="押すと、カレンダーに追加してから返事をします"
                />
              )}
            </>
          )}
          {notAddressed && (
            <p className="text-muted-foreground text-xs">
              あなた宛ての招待ではないため、出欠は返せません
            </p>
          )}
          {applyError && (
            <p role="alert" className="text-destructive text-xs">
              {applyError}
            </p>
          )}
        </div>
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {action === "import"
                ? "送信元を確認できていない招待を追加しますか?"
                : confirmReason === "sequence_jump"
                  ? "版が大きく飛んだ招待を反映しますか?"
                  : "送信元を確認できていないメールを反映しますか?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {action !== "import" &&
                "主催者からの連絡か確かめてから反映してください。"}
              差出人: {invite.sender?.email ?? "不明"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (target && action && action !== "none") {
                  void run(action, {
                    confirmed: true,
                    status: target.status,
                  });
                }
              }}
            >
              {action === "import" ? "追加する" : "反映する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showButtons && eventId && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <RsvpButtons
            value={me && me.status !== "needs_action" ? me.status : null}
            disabled={buttonsDisabled}
            onChange={(status) => {
              if (eventId) client?.respond(eventId, status);
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

      {eventId && !(shownAction === "remove" && state === "done") && (
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
