import {
  buildItip,
  calendarScheduling,
  IMIP_RECIPIENTS_PER_HOUR,
  type ImipEvent,
  type ImipPlan,
  imipRecipientCount,
  type MailAddress,
  type SchedulingBlocked,
  schedulingBlocked,
} from "@orbit/core";
import {
  type calendars,
  type Database,
  type EventWithExtras,
  eventAttendees,
  eventConflicts,
  eventReminders,
  events,
  imipLimitExceeded,
  outbox,
} from "@orbit/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  type ImipSender,
  loadSenderAccounts,
  pickImipSender,
  type SenderAccount,
} from "./imip-sender.js";

/**
 * 予定の API (calendars.ts) が招待メール (iMIP) を計画して積むための補助 (imip-design 3・4・6 章)。
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Pick<Database, "select">;
type EventRow = typeof events.$inferSelect;
type CalendarRow = typeof calendars.$inferSelect;

/**
 * 送信数の上限 (6.6) を超える変更。トランザクションを巻き戻して 409 にする。
 * - invite_limit: 直近の送信と合わせると上限を超える (しばらく待てば通る)。
 * - invite_too_many: 1 回の変更の宛先だけで 1 時間の上限を超える (待っても通らない。L5)。
 */
export class InviteLimitError extends Error {
  readonly code: "invite_limit" | "invite_too_many";
  constructor(code: "invite_limit" | "invite_too_many" = "invite_limit") {
    super(code);
    this.name = "InviteLimitError";
    this.code = code;
  }
}

/** Orbit が招待メールを送りうるカレンダー (Orbit 内と CalDAV)。 */
export const MAIL_CALENDAR_SOURCES: ReadonlySet<string> = new Set([
  "local",
  "caldav",
]);

/** カレンダーが招待をどう送るか (scheduling) と、その送信元。 */
export type CalendarSchedulingInfo = {
  scheduling: ReturnType<typeof calendarScheduling>;
  /** 解決した送信元 (Orbit 内と CalDAV のカレンダーだけ。ほかは null)。 */
  sender: ImipSender | null;
  blocked: SchedulingBlocked | null;
};

/**
 * カレンダーの scheduling を、送信元の解決 (4.2) と合わせて決める。readOnly は Orbit から
 * 書き込めないこと (書き戻しに対応していないプロバイダを含む)。list は利用者のアカウント。
 */
export function schedulingInfo(
  row: CalendarRow,
  readOnly: boolean,
  list: readonly SenderAccount[],
): CalendarSchedulingInfo {
  const resolution = MAIL_CALENDAR_SOURCES.has(row.source)
    ? pickImipSender(list, row)
    : null;
  const input = {
    source: row.source,
    readOnly,
    providerState: row.providerState,
    imipSender: resolution?.sender != null,
    senderBlocked: resolution?.blocked ?? null,
  };
  return {
    scheduling: calendarScheduling(input),
    sender: resolution?.sender ?? null,
    blocked: schedulingBlocked(input),
  };
}

/** schedulingInfo の、アカウントを読むところまで含めた形 (トランザクションの中で 1 件ずつ使う)。 */
export async function loadSchedulingInfo(
  db: Executor,
  row: CalendarRow,
  readOnly: boolean,
): Promise<CalendarSchedulingInfo & { accounts: SenderAccount[] }> {
  const list = MAIL_CALENDAR_SOURCES.has(row.source)
    ? await loadSenderAccounts(db, row.userId)
    : [];
  return { ...schedulingInfo(row, readOnly, list), accounts: list };
}

type AttendeeLike = {
  email: string;
  name: string | null;
  role: string;
  status: string;
  self: boolean;
  comment?: string | null;
};

/** 予定の行と参加者を、計画 (planImip) の入力にする。 */
export function imipEventOf(
  row: EventRow,
  attendees: readonly AttendeeLike[],
  reminders: readonly { method: "display" | "email"; minutes: number }[] = [],
): ImipEvent {
  return {
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    summary: row.summary,
    location: row.location,
    description: row.description,
    status: row.status,
    busy: row.busy,
    allDay: row.allDay,
    startAt: row.startAt,
    endAt: row.endAt,
    startDate: row.startDate,
    endDate: row.endDate,
    startTimeZone: row.startTimeZone,
    endTimeZone: row.endTimeZone,
    rrule: row.rrule,
    rdates: row.rdates,
    exdates: row.exdates,
    organizer: row.organizer
      ? {
          email: row.organizer.email,
          ...(row.organizer.name ? { name: row.organizer.name } : {}),
          ...(typeof row.organizer.self === "boolean"
            ? { self: row.organizer.self }
            : {}),
        }
      : null,
    attendees: attendees.map((attendee) => ({
      email: attendee.email,
      name: attendee.name,
      role: attendee.role as ImipEvent["attendees"][number]["role"],
      status: attendee.status as ImipEvent["attendees"][number]["status"],
      self: attendee.self,
      ...(attendee.comment === undefined ? {} : { comment: attendee.comment }),
    })),
    sequence: row.sequence,
    conferenceUrl: row.conferenceUrl,
    useDefaultReminders: row.useDefaultReminders,
    reminders,
  };
}

/** 予定の行を、参加者とリマインダー付きで読む (enqueueImip の eventRows)。順番は ids のまま。 */
export async function loadEventsWithExtras(
  db: Executor,
  ids: readonly string[],
): Promise<EventWithExtras[]> {
  if (ids.length === 0) return [];
  const list = [...new Set(ids)];
  const [rows, attendeeRows, reminderRows] = await Promise.all([
    db.select().from(events).where(inArray(events.id, list)),
    db
      .select()
      .from(eventAttendees)
      .where(inArray(eventAttendees.eventId, list))
      .orderBy(asc(eventAttendees.id)),
    db
      .select()
      .from(eventReminders)
      .where(inArray(eventReminders.eventId, list))
      .orderBy(asc(eventReminders.minutes)),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return list.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        ...row,
        attendees: attendeeRows.filter((item) => item.eventId === id),
        reminders: reminderRows
          .filter((item) => item.eventId === id)
          .map((item) => ({ method: item.method, minutes: item.minutes })),
      },
    ];
  });
}

/** 原本と、その例外 (scope が series の招待の本文に使う)。 */
export async function loadSeriesWithExtras(
  db: Executor,
  masterId: string,
): Promise<EventWithExtras[]> {
  const children = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.parentId, masterId))
    .orderBy(asc(events.recurrenceId));
  return loadEventsWithExtras(db, [masterId, ...children.map((row) => row.id)]);
}

/**
 * 計画の宛先を足すと送信数の上限 (1 時間 200 件、1 日 1000 件。REPLY は数えない) を超えるなら
 * InviteLimitError を投げる。数え方は worker と同じ imipLimitExceeded (積んだ imip_send と、
 * まだ書き戻していない CalDAV の event_* の計画)。同じ利用者の変更が同時に来ても上限を
 * 抜けないよう、利用者ごとの勧告ロックを取ってから数える。
 */
export async function assertInviteLimit(
  tx: Tx,
  userId: string,
  plan: ImipPlan | null,
  now: Date,
): Promise<void> {
  if (!plan || imipRecipientCount(plan) === 0) return;
  if (imipRecipientCount(plan) > IMIP_RECIPIENTS_PER_HOUR) {
    throw new InviteLimitError("invite_too_many");
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`imip-limit:${userId}`}, 0))`,
  );
  if (await imipLimitExceeded(tx, userId, plan, { now })) {
    throw new InviteLimitError();
  }
}

/**
 * 招待メールを送れなかったことを記録する (4.3: 既にある予定の主催者アドレスのアカウントが
 * 無い・受信専用になった)。変更は保存し、送れなかったメールごとに invite_failed を 1 件残す。
 * outboxId は null (積んでいないので「もう一度送る」はできない)。
 */
export async function recordInviteFailed(
  tx: Tx,
  input: {
    userId: string;
    calendarId: string;
    eventId: string;
    title: string | null;
    plan: ImipPlan;
    reason: string;
  },
): Promise<void> {
  const rows = input.plan.messages.map((message) => ({
    userId: input.userId,
    calendarId: input.calendarId,
    eventId: input.eventId,
    kind: "invite_failed" as const,
    lost: {
      outboxId: null,
      method: message.method,
      to: message.to.map((to) => to.address),
    },
    title: input.title,
    reason:
      message.method === "REPLY"
        ? `出欠の返事を主催者へ送れませんでした: ${input.reason}`
        : message.method === "CANCEL"
          ? `取り消しのメールを送れませんでした: ${input.reason}`
          : `招待メールを送れませんでした: ${input.reason}`,
  }));
  if (rows.length > 0) await tx.insert(eventConflicts).values(rows);
}

/**
 * 消す予定 (eventIds) に向けた、まだ書き戻していない変更 (event_update) の計画のうち、
 * 参加者を外した人への取り消し (CANCEL、reason remove。持ち越したものも含む) の宛先を集める
 * (imip レビュー M3)。予定を消すと、その変更は計画ごと取り消されるので、外した人への取り消しを
 * 削除の取り消しと一緒に送るのに使う。cancelPendingWrites の前に呼ぶ。
 */
export async function pendingRemovalRecipients(
  tx: Tx,
  accountId: string,
  eventIds: readonly string[],
): Promise<{ senderAccountId: string; to: MailAddress[] } | null> {
  if (eventIds.length === 0) return null;
  const rows = await tx
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, accountId),
        eq(outbox.kind, "event_update"),
        eq(outbox.status, "pending"),
        inArray(sql<string>`${outbox.payload}->>'eventId'`, [...eventIds]),
      ),
    );
  let senderAccountId: string | null = null;
  const seen = new Set<string>();
  const to: MailAddress[] = [];
  for (const row of rows) {
    const plan = (row.payload as { imip?: ImipPlan | null }).imip;
    if (!plan) continue;
    if (senderAccountId !== null && plan.senderAccountId !== senderAccountId) {
      continue;
    }
    for (const message of plan.messages) {
      if (message.method !== "CANCEL" || message.reason !== "remove") continue;
      for (const entry of message.to) {
        const key = entry.address.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        senderAccountId = plan.senderAccountId;
        to.push(entry);
      }
    }
  }
  return senderAccountId && to.length > 0 ? { senderAccountId, to } : null;
}

/**
 * 削除の計画に、外した人への取り消し (pendingRemovalRecipients) を足す。本文は消す前の予定から
 * 作る (行が消えるため)。いまの参加者 (削除の CANCEL の宛先) にいる人は除く。
 */
export function withRemovalCancels(
  plan: ImipPlan | null,
  removals: { senderAccountId: string; to: MailAddress[] } | null,
  event: ImipEvent,
  now: Date,
  defaultTimeZone: string,
): ImipPlan | null {
  if (!removals) return plan;
  const current = new Set(
    event.attendees.map((attendee) => attendee.email.trim().toLowerCase()),
  );
  const to = removals.to.filter(
    (entry) => !current.has(entry.address.trim().toLowerCase()),
  );
  if (to.length === 0) return plan;
  if (plan && plan.senderAccountId !== removals.senderAccountId) return plan;
  const attendees = to.map((entry) => entry.address);
  const message = {
    method: "CANCEL" as const,
    to,
    scope: "series" as const,
    attendees,
    reason: "remove" as const,
    ...(event.recurrenceId === null
      ? {}
      : { recurrenceId: event.recurrenceId }),
    content: buildItip({
      method: "CANCEL",
      events: [event],
      attendees,
      dtstamp: now,
      defaultTimeZone,
    }),
  };
  return plan
    ? { ...plan, messages: [...plan.messages, message] }
    : {
        senderAccountId: removals.senderAccountId,
        stamp: now.toISOString(),
        messages: [message],
      };
}
