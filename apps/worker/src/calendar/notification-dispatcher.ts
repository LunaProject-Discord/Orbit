import {
  type CalendarNoticeNotification,
  type CalendarNotificationSettings,
  type CalendarPushMessage,
  CHANNEL_CALENDAR_NOTICE,
  calendarScheduling,
  cancelText,
  DEFAULT_REMINDER_TIME_ZONE,
  deviceCoversReminder,
  type EventNoticeSnapshot,
  inviteBatchTag,
  inviteBatchText,
  inviteTag,
  inviteText,
  isReminderLate,
  MAX_NOTICES_PER_MINUTE,
  MAX_SINGLE_INVITE_NOTIFICATIONS,
  MIN_REMINDER_LIFETIME_MS,
  type PlannedReminder,
  REMINDER_DISPATCH_INTERVAL_MS,
  readCalendarNotificationSettings,
  reminderTag,
  signEventNotificationAction,
  toReminderMessage,
  updateTag,
  updateText,
} from "@orbit/core";
import {
  calendars,
  type Database,
  eventNotices,
  eventOccurrences,
  eventReminderJobs,
  events,
  type StoredEventNoticeSnapshot,
  userSettings,
} from "@orbit/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { CalendarDelivery, CalendarPushSender } from "./calendar-push.js";
import { pruneEventNotices } from "./invite-notices.js";

/**
 * 予定の通知を送る (段取り 9、設計 4.1)。
 * - リマインダー: event_reminder_jobs の fire_at が来たものを FOR UPDATE SKIP LOCKED で取り、
 *   sent_at を付けてから送る。15 分より遅れたもの・予定が終わったものは送らずに済ませる。
 *   Android の端末は、自分で予約済み (deviceCoversReminder) なら省く。
 * - 招待・変更・取り消し: event_notices の sent_at の無い行を取り、Web Push・FCM と、
 *   CHANNEL_CALENDAR_NOTICE (API の EventsHub → SSE の "calendar") で送る。
 *   1 回分で同じカレンダーの招待が 4 件以上ならまとめ、1 分に 30 件を超えたら残りをまとめる。
 */

const JOB_BATCH = 200;
const NOTICE_BATCH = 500;
/** NOTIFY の payload の上限 (8000 バイト) に余裕を持たせた値。 */
const NOTIFY_PAYLOAD_LIMIT = 7000;
const PRUNE_INTERVAL_MS = 60 * 60_000;

export type RsvpConfig = {
  /** 合言葉の鍵 (API と同じ CREDENTIALS_ENCRYPTION_KEY)。 */
  key: Buffer;
  /** POST /v1/notification-actions/event の URL。 */
  url: string;
} | null;

type DispatcherOptions = {
  push?: CalendarPushSender | null;
  rsvp?: RsvpConfig;
  now?: () => number;
  log?: (message: string) => void;
};

type UserNoticeSettings = {
  settings: CalendarNotificationSettings;
  timeZone: string;
};

export type DispatchResult = { reminders: number; notices: number };

export class NotificationDispatcher {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private running: Promise<DispatchResult> | null = null;
  private again = false;
  private stopped = false;
  private lastPrune = 0;
  /** 利用者ごとの、直近 1 分に送った招待・変更の通知の時刻。 */
  private recent = new Map<string, number[]>();

  constructor(
    private readonly db: Database,
    private readonly options: DispatcherOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  start() {
    this.timer = setInterval(() => this.wake(), REMINDER_DISPATCH_INTERVAL_MS);
    this.wake();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    await this.running?.catch(() => {});
  }

  /** すぐに確かめる (Indexer の作り直しのあと、定期の確認、次の時刻のタイマー)。 */
  wake() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.dispatch()
      .catch((error) => {
        this.log(
          `予定の通知を送れませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { reminders: 0, notices: 0 };
      })
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.wake();
        } else {
          void this.scheduleNext();
        }
      });
  }

  /** 次の job の時刻が定期の確認より前なら、その時刻にタイマーを張る。 */
  private async scheduleNext() {
    if (this.stopped) return;
    const [row] = await this.db
      .select({ fireAt: sql<Date | null>`min(${eventReminderJobs.fireAt})` })
      .from(eventReminderJobs)
      .where(isNull(eventReminderJobs.sentAt))
      .catch(() => [] as { fireAt: Date | null }[]);
    if (!row?.fireAt) return;
    const delay = new Date(row.fireAt).getTime() - this.now();
    if (delay >= REMINDER_DISPATCH_INTERVAL_MS) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this.wake(), Math.max(delay, 0) + 50);
  }

  /** 時刻の来たリマインダーと、送信待ちの招待・変更をすべて送る。 */
  async dispatch(): Promise<DispatchResult> {
    const result: DispatchResult = { reminders: 0, notices: 0 };
    for (;;) {
      const count = await this.dispatchReminders();
      result.reminders += count;
      if (count < JOB_BATCH || this.stopped) break;
    }
    for (;;) {
      const count = await this.dispatchNotices();
      result.notices += count;
      if (count < NOTICE_BATCH || this.stopped) break;
    }
    const now = this.now();
    if (now - this.lastPrune >= PRUNE_INTERVAL_MS) {
      this.lastPrune = now;
      await pruneEventNotices(this.db, new Date(now)).catch((error) => {
        this.log(`古い予定の通知の記録を消せませんでした: ${String(error)}`);
      });
    }
    return result;
  }

  private async noticeSettings(
    userIds: readonly string[],
  ): Promise<Map<string, UserNoticeSettings>> {
    const rows =
      userIds.length > 0
        ? await this.db
            .select({
              userId: userSettings.userId,
              timeZone: userSettings.timeZone,
              calendarNotifications: userSettings.calendarNotifications,
            })
            .from(userSettings)
            .where(inArray(userSettings.userId, [...userIds]))
        : [];
    const map = new Map(
      rows.map((row) => [
        row.userId,
        {
          settings: readCalendarNotificationSettings(row.calendarNotifications),
          timeZone: row.timeZone ?? DEFAULT_REMINDER_TIME_ZONE,
        },
      ]),
    );
    for (const userId of userIds) {
      if (!map.has(userId)) {
        map.set(userId, {
          settings: readCalendarNotificationSettings(null),
          timeZone: DEFAULT_REMINDER_TIME_ZONE,
        });
      }
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // リマインダー
  // -------------------------------------------------------------------------

  /** 返すのは取った job の数 (送らずに済ませたものを含む)。 */
  async dispatchReminders(): Promise<number> {
    const now = this.now();
    const claimed = await this.db.transaction(async (tx) => {
      const jobs = await tx
        .select({
          id: eventReminderJobs.id,
          userId: eventReminderJobs.userId,
          minutes: eventReminderJobs.minutes,
          fireAt: eventReminderJobs.fireAt,
          changeSeq: eventReminderJobs.changeSeq,
          occurrenceId: eventReminderJobs.occurrenceId,
        })
        .from(eventReminderJobs)
        .where(
          and(
            isNull(eventReminderJobs.sentAt),
            lte(eventReminderJobs.fireAt, new Date(now)),
          ),
        )
        .orderBy(asc(eventReminderJobs.fireAt))
        .limit(JOB_BATCH)
        .for("update", { skipLocked: true });
      if (jobs.length === 0) return [];
      await tx
        .update(eventReminderJobs)
        .set({ sentAt: new Date(now) })
        .where(
          inArray(
            eventReminderJobs.id,
            jobs.map((job) => job.id),
          ),
        );
      return jobs;
    });
    if (claimed.length === 0) return 0;

    const occurrences = await this.db
      .select({
        id: eventOccurrences.id,
        masterId: eventOccurrences.masterId,
        recurrenceId: eventOccurrences.recurrenceId,
        calendarId: eventOccurrences.calendarId,
        allDay: eventOccurrences.allDay,
        startAt: eventOccurrences.startAt,
        endAt: eventOccurrences.endAt,
        startDate: eventOccurrences.startDate,
        endDate: eventOccurrences.endDate,
        eventId: eventOccurrences.eventId,
        summary: events.summary,
        location: events.location,
      })
      .from(eventOccurrences)
      .innerJoin(events, eq(events.id, eventOccurrences.eventId))
      .where(
        inArray(
          eventOccurrences.id,
          claimed.map((job) => job.occurrenceId),
        ),
      );
    const byId = new Map(occurrences.map((row) => [row.id, row]));
    const users = await this.noticeSettings([
      ...new Set(claimed.map((job) => job.userId)),
    ]);
    const deliveries = new Map<string, CalendarDelivery[]>();
    for (const job of claimed) {
      const occurrence = byId.get(job.occurrenceId);
      const user = users.get(job.userId);
      if (!occurrence || !user) continue;
      const fireAt = job.fireAt.getTime();
      if (isReminderLate(fireAt, now)) continue;
      const planned = plannedOf(occurrence, job, user.timeZone);
      if (!planned || planned.expiresAt <= now) continue;
      const message = toReminderMessage(planned, occurrence, {
        timeZone: user.timeZone,
        now,
        detail: user.settings.detail,
      });
      const list = deliveries.get(job.userId) ?? [];
      list.push({
        message,
        skipDevice: (cover) =>
          deviceCoversReminder(cover, { fireAt, changeSeq: job.changeSeq }),
      });
      deliveries.set(job.userId, list);
    }
    const push = this.options.push;
    if (push?.enabled) {
      for (const [userId, list] of deliveries) {
        await push.deliver(userId, list, now);
      }
    }
    return claimed.length;
  }

  // -------------------------------------------------------------------------
  // 招待・変更・取り消し
  // -------------------------------------------------------------------------

  /** 返すのは取った行の数 (設定で送らなかったものを含む)。 */
  async dispatchNotices(): Promise<number> {
    const now = this.now();
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(eventNotices)
        .where(isNull(eventNotices.sentAt))
        .orderBy(asc(eventNotices.createdAt), asc(eventNotices.id))
        .limit(NOTICE_BATCH)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      await tx
        .update(eventNotices)
        .set({ sentAt: new Date(now) })
        .where(
          inArray(
            eventNotices.id,
            rows.map((row) => row.id),
          ),
        );
      return rows;
    });
    if (claimed.length === 0) return 0;

    const users = await this.noticeSettings([
      ...new Set(claimed.map((row) => row.userId)),
    ]);
    const calendarRows = await this.db
      .select({
        id: calendars.id,
        source: calendars.source,
        readOnly: calendars.readOnly,
        providerState: calendars.providerState,
      })
      .from(calendars)
      .where(
        inArray(calendars.id, [
          ...new Set(claimed.map((row) => row.calendarId)),
        ]),
      );
    const calendarById = new Map(calendarRows.map((row) => [row.id, row]));

    const byUser = new Map<string, typeof claimed>();
    for (const row of claimed) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    for (const [userId, rows] of byUser) {
      const user = users.get(userId);
      if (!user) continue;
      const options = {
        timeZone: user.timeZone,
        now,
        detail: user.settings.detail,
      };
      const messages: CalendarPushMessage[] = [];
      // 招待はカレンダーごとにまとめる。
      const invites = new Map<string, typeof rows>();
      for (const row of rows) {
        const snapshot = row.snapshot as EventNoticeSnapshot;
        if (row.kind === "invite") {
          if (!user.settings.invites) continue;
          const list = invites.get(row.calendarId) ?? [];
          list.push(row);
          invites.set(row.calendarId, list);
          continue;
        }
        if (!user.settings.changes) continue;
        if (row.kind === "cancel") {
          messages.push({
            kind: "event-cancel",
            ...cancelText(snapshot, options),
            tag: updateTag(row.eventId),
            eventId: row.eventId,
            expiresAt: snapshotEnd(snapshot),
            calendarId: row.calendarId,
          });
          continue;
        }
        const previous = await this.previousSnapshot(row);
        if (!previous) continue;
        messages.push({
          kind: "event-update",
          ...updateText(previous, snapshot, options),
          tag: updateTag(row.eventId),
          eventId: row.eventId,
          expiresAt: snapshotEnd(snapshot),
          calendarId: row.calendarId,
        });
      }
      for (const [calendarId, list] of invites) {
        if (list.length > MAX_SINGLE_INVITE_NOTIFICATIONS) {
          messages.push(batchMessage(calendarId, list, options));
          continue;
        }
        const calendar = calendarById.get(calendarId);
        const canRespond =
          !!this.options.rsvp &&
          !!calendar &&
          !calendar.readOnly &&
          calendarScheduling(calendar) === "server";
        for (const row of list) {
          const snapshot = row.snapshot as EventNoticeSnapshot;
          const rsvp = this.options.rsvp;
          messages.push({
            kind: "event-invite",
            ...inviteText(snapshot, options),
            tag: inviteTag(row.eventId),
            eventId: row.eventId,
            expiresAt: snapshotEnd(snapshot),
            calendarId,
            ...(canRespond && rsvp
              ? {
                  rsvp: {
                    url: rsvp.url,
                    token: signEventNotificationAction(
                      rsvp.key,
                      userId,
                      row.eventId,
                      now,
                    ),
                  },
                }
              : {}),
          });
        }
      }
      const limited = this.limit(userId, messages, now, options);
      if (limited.length === 0) continue;
      await this.announce(userId, limited);
      const push = this.options.push;
      if (push?.enabled) {
        await push.deliver(
          userId,
          limited.map((message) => ({ message })),
          now,
        );
      }
    }
    return claimed.length;
  }

  /** 1 分に MAX_NOTICES_PER_MINUTE を超える分は、まとめの 1 件にする。 */
  private limit(
    userId: string,
    messages: CalendarPushMessage[],
    now: number,
    options: { detail: CalendarNotificationSettings["detail"] },
  ): CalendarPushMessage[] {
    const recent = (this.recent.get(userId) ?? []).filter(
      (at) => at > now - 60_000,
    );
    const room = Math.max(MAX_NOTICES_PER_MINUTE - recent.length, 0);
    let result = messages;
    if (messages.length > room) {
      const kept = messages.slice(0, Math.max(room - 1, 0));
      const rest = messages.slice(kept.length);
      const first = rest.find((message) => message.eventId)?.eventId ?? "-";
      result = [
        ...kept,
        {
          kind: "event-invites-batch",
          ...inviteBatchText([], rest.length, options),
          tag: inviteBatchTag("all", first),
          eventId: null,
        },
      ];
      // 上限を超えた分も、少なくともまとめの 1 件は出す。
      if (room === 0) result = result.slice(-1);
    }
    for (const _ of result) recent.push(now);
    this.recent.set(userId, recent);
    return result;
  }

  /** 開いている画面へ (API の EventsHub → SSE)。出欠の合言葉は載せない。 */
  private async announce(userId: string, messages: CalendarPushMessage[]) {
    const plain = messages.map(({ rsvp: _rsvp, ...rest }) => rest);
    let batch: CalendarPushMessage[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const payload: CalendarNoticeNotification = {
        userId,
        notifications: batch,
      };
      await this.db.execute(
        sql`select pg_notify(${CHANNEL_CALENDAR_NOTICE}, ${JSON.stringify(payload)})`,
      );
      batch = [];
    };
    for (const message of plain) {
      const next = [...batch, message];
      if (
        batch.length > 0 &&
        Buffer.byteLength(JSON.stringify({ userId, notifications: next })) >
          NOTIFY_PAYLOAD_LIMIT
      ) {
        await flush();
        batch = [message];
      } else {
        batch = next;
      }
    }
    await flush();
  }

  /** 変更の通知の比較相手 (その行より前に知らせた内容)。 */
  private async previousSnapshot(row: {
    id: string;
    eventId: string;
    userId: string;
    createdAt: Date;
  }): Promise<EventNoticeSnapshot | null> {
    const [previous] = await this.db
      .select({ snapshot: eventNotices.snapshot })
      .from(eventNotices)
      .where(
        and(
          eq(eventNotices.userId, row.userId),
          eq(eventNotices.eventId, row.eventId),
          ne(eventNotices.id, row.id),
          lt(eventNotices.createdAt, row.createdAt),
        ),
      )
      .orderBy(desc(eventNotices.createdAt), desc(eventNotices.id))
      .limit(1);
    return (previous?.snapshot as EventNoticeSnapshot | undefined) ?? null;
  }
}

function batchMessage(
  calendarId: string,
  rows: { eventId: string; snapshot: StoredEventNoticeSnapshot }[],
  options: { detail: CalendarNotificationSettings["detail"] },
): CalendarPushMessage {
  const first = rows[0]?.eventId ?? "-";
  return {
    kind: "event-invites-batch",
    ...inviteBatchText(
      rows.map((row) => row.snapshot.organizer),
      rows.length,
      options,
    ),
    tag: inviteBatchTag(calendarId, first),
    eventId: null,
    calendarId,
  };
}

/** snapshot の予定の終了 (epoch ms)。終日は UTC の日付の 0:00 で近似する。 */
function snapshotEnd(snapshot: EventNoticeSnapshot): number | undefined {
  const end = snapshot.allDay
    ? Date.parse(`${snapshot.endDate}T00:00:00Z`)
    : Date.parse(snapshot.endAt);
  return Number.isFinite(end) ? end : undefined;
}

/** job と回の行から、文言と tag の材料 (PlannedReminder の形) を作る。 */
function plannedOf(
  occurrence: {
    masterId: string;
    recurrenceId: string | null;
    calendarId: string;
    eventId: string;
    allDay: boolean;
    startAt: Date | null;
    endAt: Date | null;
    startDate: string | null;
    endDate: string | null;
  },
  job: { minutes: number; fireAt: Date },
  timeZone: string,
): PlannedReminder | null {
  const base = {
    tag: reminderTag(occurrence.masterId, occurrence.recurrenceId, job.minutes),
    masterId: occurrence.masterId,
    eventId: occurrence.eventId,
    calendarId: occurrence.calendarId,
    recurrenceId: occurrence.recurrenceId,
    minutes: job.minutes,
    fireAt: job.fireAt.getTime(),
  };
  if (occurrence.allDay) {
    if (!occurrence.startDate || !occurrence.endDate) return null;
    const dayStart = (date: string) => zonedDayStart(date, timeZone);
    const startMs = dayStart(occurrence.startDate);
    const endMs = dayStart(occurrence.endDate);
    return {
      ...base,
      expiresAt: Math.max(endMs, startMs + MIN_REMINDER_LIFETIME_MS),
      allDay: true,
      startDate: occurrence.startDate,
      endDate: occurrence.endDate,
    };
  }
  if (!occurrence.startAt) return null;
  const startMs = occurrence.startAt.getTime();
  const endMs = (occurrence.endAt ?? occurrence.startAt).getTime();
  return {
    ...base,
    expiresAt: Math.max(endMs, startMs + MIN_REMINDER_LIFETIME_MS),
    allDay: false,
    startAt: occurrence.startAt.toISOString(),
    endAt: (occurrence.endAt ?? occurrence.startAt).toISOString(),
  };
}

/** その日の 0:00 (timeZone) の epoch ms。Intl でオフセットを求める (worker は Temporal を直接持たない)。 */
export function zonedDayStart(date: string, timeZone: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return (
      Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour"),
        get("minute"),
        get("second"),
      ) - at
    );
  };
  try {
    let result = utc - offset(utc);
    result = utc - offset(result);
    return result;
  } catch {
    return utc;
  }
}
