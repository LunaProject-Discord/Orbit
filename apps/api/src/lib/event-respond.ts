import {
  correctClientTime,
  eventRespondKey,
  type ImipPlan,
  type InvitePerson,
  type InviteRole,
  inviteRole,
  MY_RESPONSE_FIELD,
  type NotifyBlocked,
  planImip,
  type RespondNotify,
} from "@orbit/core";
import {
  accounts,
  calendars,
  type Database,
  enqueueImip as defaultEnqueueImip,
  type EventWithExtras,
  eventAttendees,
  eventReminders,
  events,
} from "@orbit/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  calendarIdentities,
  ownAddresses,
  selfIsMe,
} from "./calendar-identity.js";
import { recordChanges } from "./changes.js";
import {
  InviteLimitError,
  imipEventOf,
  loadEventsWithExtras,
  loadSchedulingInfo,
  recordInviteFailed,
} from "./event-imip.js";
import {
  enqueueEventOperation,
  isProviderCalendar,
  lockEventForWrite,
  providerWriteBlocked,
} from "./event-outbox.js";
import { pickImipSenderForAddress } from "./imip-sender.js";

/**
 * 自分の出欠の返事 (POST /calendars/events/:id/respond) の中身。通知のボタンからの返事
 * (POST /v1/notification-actions/event、段取り 9 の設計 4.2) でも同じ処理を使う。
 * 予定の行の読み方 (参加者・役割・書き込めるか) と、招待メールを積む処理も、
 * calendars.ts と共有するためにここに置く。
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type EventRow = typeof events.$inferSelect;
type CalendarRow = typeof calendars.$inferSelect;

export type EventExtras = {
  reminders: { method: "display" | "email"; minutes: number }[];
  attendees: {
    email: string;
    name: string | null;
    role: string;
    status: string;
    self: boolean;
    /** 返事のコメント。 */
    comment: string | null;
    /** 最後に反映した返事 (メールの REPLY) の DTSTAMP。 */
    repliedAt: string | null;
  }[];
};

/**
 * Orbit から予定を書き込めるカレンダーか。Orbit 内のカレンダーと、書き戻しに対応した
 * プロバイダ (writable、既定は CALENDAR_WRITEBACK_SOURCES) のアカウントのカレンダー。
 */
export function isWritable(
  row: CalendarRow,
  writable: ReadonlySet<string>,
): boolean {
  if (row.readOnly) return false;
  if (row.source === "local") return true;
  return writable.has(row.source) && row.accountId !== null;
}

/** カレンダーごとの、そのアカウントの自分のアドレス。アカウントの無いカレンダーは入らない。 */
export async function calendarAddresses(
  db: Database | Tx,
  calendarIds: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (calendarIds.length === 0) return map;
  const rows = await db
    .select({
      calendarId: calendars.id,
      email: accounts.email,
      username: accounts.username,
    })
    .from(calendars)
    .innerJoin(accounts, eq(accounts.id, calendars.accountId))
    .where(inArray(calendars.id, [...new Set(calendarIds)]));
  for (const row of rows) map.set(row.calendarId, ownAddresses(row));
  return map;
}

/**
 * 主催者に self の印を補う (設計の 3.1)。印の無い行 (段取り 8 より前に取り込んだ行や、
 * etag が同じで取り込みが触らなかった行) は、主催者のアドレスがカレンダーのアカウントの
 * アドレスと同じかで決める。
 */
export function resolveOrganizer(
  organizer: EventRow["organizer"],
  addresses: ReadonlySet<string> | undefined,
): (InvitePerson & { self: boolean }) | null {
  if (!organizer) return null;
  if (typeof organizer.self === "boolean") {
    return { ...organizer, self: organizer.self };
  }
  return {
    ...organizer,
    self: addresses?.has(organizer.email.trim().toLowerCase()) ?? false,
  };
}

export async function loadExtras(
  db: Database | Tx,
  ids: string[],
): Promise<Map<string, EventExtras>> {
  const map = new Map<string, EventExtras>();
  for (const id of ids) map.set(id, { reminders: [], attendees: [] });
  if (ids.length === 0) return map;
  const [reminderRows, attendeeRows] = await Promise.all([
    db
      .select()
      .from(eventReminders)
      .where(inArray(eventReminders.eventId, ids))
      .orderBy(asc(eventReminders.minutes)),
    db
      .select()
      .from(eventAttendees)
      .where(inArray(eventAttendees.eventId, ids))
      .orderBy(asc(eventAttendees.id)),
  ]);
  for (const row of reminderRows) {
    map.get(row.eventId)?.reminders.push({
      method: row.method,
      minutes: row.minutes,
    });
  }
  for (const row of attendeeRows) {
    map.get(row.eventId)?.attendees.push({
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      self: row.self,
      comment: row.comment,
      repliedAt: row.repliedAt?.toISOString() ?? null,
    });
  }
  return map;
}

/** 予定に対する自分の役割 (主催者の印を補ってから inviteRole で決める)。 */
export async function roleOf(
  tx: Tx,
  row: EventRow,
  extras?: EventExtras,
): Promise<InviteRole> {
  const attendees =
    extras?.attendees ??
    (await loadExtras(tx, [row.id])).get(row.id)?.attendees ??
    [];
  const addresses =
    row.organizer && typeof row.organizer.self !== "boolean"
      ? (await calendarAddresses(tx, [row.calendarId])).get(row.calendarId)
      : undefined;
  return inviteRole({
    organizer: resolveOrganizer(row.organizer, addresses),
    attendees,
  });
}

/** 浮動時刻と終了済みの判定に使うタイムゾーン。 */
export function calendarZone(calendar: CalendarRow): string {
  return calendar.timeZone ?? "UTC";
}

/**
 * Orbit 内のカレンダーなら、招待メールの計画をその場で imip_send に積む (同じトランザクション)。
 * CalDAV では event_* の payload に載せてあるので、書き戻しの成功後に worker が積む。
 */
export async function dispatchInvites(
  tx: Tx,
  enqueueImip: typeof defaultEnqueueImip,
  calendar: CalendarRow,
  plan: ImipPlan | null,
  rows: readonly EventWithExtras[],
  eventId: string,
  baseKey: string,
  title: string | null,
): Promise<void> {
  if (!plan || isProviderCalendar(calendar)) return;
  const result = await enqueueImip(tx, plan, rows, {
    userId: calendar.userId,
    calendarId: calendar.id,
    eventId,
    baseKey,
    defaultTimeZone: calendarZone(calendar),
  });
  // 受け付けた後に上限を使い切った (同時の変更)。保存ごと断る。
  if (result.skipped === "limit") throw new InviteLimitError();
  // 積めなかったメールは、変更は保存して invite_failed に残す (not_mail は送らないのが正しい)。
  const reason =
    result.skipped === "sender_unavailable"
      ? "送信元のメールアカウントから送信できません。"
      : result.skipped === "sender_mismatch"
        ? "送信元のアドレスが主催者 (返事では自分の参加者) のアドレスと違います。"
        : result.incomplete > 0
          ? "招待メールの本文を作れませんでした。"
          : null;
  if (reason) {
    await recordInviteFailed(tx, {
      userId: calendar.userId,
      calendarId: calendar.id,
      eventId,
      title,
      // 一部だけ積めたときは、積めなかったメッセージだけを記録する (L12)。
      plan:
        result.skipped === null
          ? { ...plan, messages: result.incompleteMessages }
          : plan,
      reason,
    });
    await recordChanges(tx, calendar.userId, "calendar", [calendar.id]);
  }
}

export type RespondStatus = "accepted" | "tentative" | "declined";

export type RespondInput = {
  status: RespondStatus;
  /** 省けばいまのコメントを残す。null で消す。 */
  comment?: string | null;
  /** 端末で返事をした時刻 (ISO 8601)。同じ返事の再送は同じ値で送る。 */
  respondedAt: string;
  clientNow?: string;
  /**
   * 書き戻しと REPLY の冪等キーを作る値。省けば respondedAt (/respond の動き)。
   * 通知からの返事で respondedAt が無く idempotencyKey があるときに使う。
   */
  keySource?: string;
  /**
   * true なら、自分の出欠が既に status のときは何も変えない (applied: false)。
   * 通知のボタンの再送 (respondedAt の無い要求) を 1 回として扱うため。/respond では使わない。
   */
  skipIfSame?: boolean;
};

export type RespondErrorCode = "organizer" | "not_attendee" | "cancelled";

export type RespondResult =
  | "not_found"
  | "read_only"
  | "calendar_disabled"
  | "calendar_sync_stopped"
  | { error: RespondErrorCode }
  | {
      row: EventRow;
      applied: boolean;
      notify: RespondNotify;
      notifyBlocked: NotifyBlocked | null;
    };

export type RespondDeps = {
  /** 予定を書き戻せるプロバイダの source。 */
  writable: ReadonlySet<string>;
  /** 招待メールを outbox に積む (テストで差し替える)。 */
  enqueueImip?: typeof defaultEnqueueImip;
};

/**
 * 自分の出欠を返事する (invites 設計の 4.1)。返事できるのは、自分が参加者 (self の行がある) で
 * 主催者でない予定だけ。返事の対象のアドレスは要求に含めず、サーバーが self の行を書き換える。
 * プロバイダのカレンダーなら返事の書き戻し (event_respond) を積む。招待を自分で送らない
 * CalDAV サーバーでは、自分のカレンダーにだけ記録され、主催者には届かない (notify が none)。
 * userId の予定だけを対象にする (他の利用者の予定は not_found)。
 */
export async function respondToEvent(
  db: Database,
  userId: string,
  eventId: string,
  input: RespondInput,
  { writable, enqueueImip = defaultEnqueueImip }: RespondDeps,
): Promise<RespondResult> {
  const now = new Date();
  return db.transaction(async (tx): Promise<RespondResult> => {
    // 勧告ロック (プロバイダのカレンダー) → 予定の行のロックの順。
    const row = await lockEventForWrite(tx, userId, eventId);
    if (!row) return "not_found";
    const [calendar] = await tx
      .select()
      .from(calendars)
      .where(
        and(eq(calendars.id, row.calendarId), eq(calendars.userId, userId)),
      );
    if (!calendar || !isWritable(calendar, writable)) return "read_only";
    const blocked = await providerWriteBlocked(tx, calendar);
    if (blocked) return blocked;
    const extras = (await loadExtras(tx, [row.id])).get(row.id);
    const attendees = extras?.attendees ?? [];
    const role = await roleOf(tx, row, extras);
    if (role === "organizer") return { error: "organizer" };
    if (role !== "attendee") return { error: "not_attendee" };
    // 共有カレンダーの self は自分とは限らない (ほかの人の出欠を書き換えない)。
    const identity = (await calendarIdentities(tx, [row.calendarId])).get(
      row.calendarId,
    );
    if (!selfIsMe(attendees, identity)) return { error: "not_attendee" };
    if (row.status === "cancelled") return { error: "cancelled" };
    const info = await loadSchedulingInfo(tx, calendar, false);
    // 主催者へ知らせる方法 (imip-design 10.2)。mail は、自分の ATTENDEE のアドレスの
    // 送信できるアカウントがあるときだけ (From と ATTENDEE をそろえる。4.2)。
    const me = attendees.find((attendee) => attendee.self);
    const replySender =
      info.scheduling === "mail" && me
        ? pickImipSenderForAddress(info.accounts, me.email, calendar)
        : null;
    const notify: RespondNotify =
      info.scheduling === "server" ? "server" : replySender ? "mail" : "none";
    const notifyBlocked: NotifyBlocked | null =
      notify === "none" &&
      (info.scheduling === "mail" ||
        info.blocked === "no_sender" ||
        info.blocked === "receive_only")
        ? "no_sender"
        : null;
    const outcome = { notify, notifyBlocked };
    if (input.skipIfSame && me?.status === input.status) {
      return { row, applied: false, ...outcome };
    }
    const at = correctClientTime(input.respondedAt, input.clientNow, now);
    const previous = Date.parse(row.fieldUpdatedAt?.[MY_RESPONSE_FIELD] ?? "");
    // 後から別の返事をしていれば (同じ要求の再送も) 何も変えない。
    if (!Number.isNaN(previous) && previous >= at.getTime()) {
      return { row, applied: false, ...outcome };
    }
    const before = imipEventOf(row, attendees);
    await tx
      .update(eventAttendees)
      .set({
        status: input.status,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      })
      .where(
        and(eq(eventAttendees.eventId, row.id), eq(eventAttendees.self, true)),
      );
    const [next] = await tx
      .update(events)
      .set({
        fieldUpdatedAt: {
          ...(row.fieldUpdatedAt ?? {}),
          [MY_RESPONSE_FIELD]: at.toISOString(),
        },
      })
      .where(eq(events.id, row.id))
      .returning();
    await recordChanges(tx, userId, "event", [row.id]);
    // 主催者への返事 (REPLY)。送信数の上限には数えない。
    let plan: ImipPlan | null = null;
    let rows: EventWithExtras[] = [];
    if (replySender && me) {
      rows = await loadEventsWithExtras(tx, [row.id]);
      plan = planImip(
        before,
        imipEventOf(next ?? row, rows[0]?.attendees ?? []),
        {
          operation: "respond",
          stamp: now,
          defaultTimeZone: calendarZone(calendar),
        },
        role,
        replySender,
      );
    }
    const respondKey = eventRespondKey(
      row.id,
      input.status,
      input.keySource ?? input.respondedAt,
    );
    if (isProviderCalendar(calendar)) {
      let parentRemoteId: string | null = null;
      if (row.parentId) {
        const [master] = await tx
          .select({ remoteId: events.remoteId })
          .from(events)
          .where(eq(events.id, row.parentId));
        parentRemoteId = master?.remoteId ?? null;
      }
      await enqueueEventOperation(
        tx,
        calendar,
        {
          kind: "event_respond",
          payload: {
            eventId: row.id,
            calendarId: calendar.id,
            status: input.status,
            comment: input.comment ?? null,
            // 「不参加で返事をして削除」で、書き戻す前に行が消えても返事できるように。
            target: {
              eventId: row.id,
              calendarId: calendar.id,
              remoteId: row.remoteId,
              etag: row.etag,
              uid: row.uid,
              recurrenceId: row.recurrenceId,
              parentRemoteId,
            },
            ...(plan ? { imip: plan } : {}),
          },
        },
        respondKey,
      );
    }
    await dispatchInvites(
      tx,
      enqueueImip,
      calendar,
      plan,
      rows,
      row.id,
      respondKey,
      row.summary,
    );
    return { row: next ?? row, applied: true, ...outcome };
  });
}
