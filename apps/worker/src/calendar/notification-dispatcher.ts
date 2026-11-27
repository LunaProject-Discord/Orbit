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
  NOTICE_OVERFLOW_TAG,
  noticeOverflowText,
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
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { CalendarDelivery, CalendarPushSender } from "./calendar-push.js";
import { pruneEventNotices } from "./invite-notices.js";
import { safeNoticeOccurrence, zonedDayStart } from "./notice-timing.js";

export { zonedDayStart };

/**
 * 予定の通知を送る (段取り 9、設計 4.1)。
 * - リマインダー: event_reminder_jobs の fire_at が来たものを FOR UPDATE SKIP LOCKED で取り
 *   (claimed_at を付ける)、送り終えたら sent_at を付ける。取ったまま CLAIM_LEASE_MS たったもの
 *   (worker の停止など) は取り直し、MAX_ATTEMPTS 回取っても済まないものは送らずに済ませる。
 *   15 分より遅れたもの・予定が終わったものは送らずに済ませる。
 *   Android の端末は、自分で予約済み (deviceCoversReminder) なら省く。
 * - 招待・変更・取り消し: event_notices の sent_at の無い行を同じように取り、Web Push・FCM と、
 *   CHANNEL_CALENDAR_NOTICE (API の EventsHub → SSE の "calendar") で送る。
 *   1 回分で同じカレンダーの招待が 4 件以上ならまとめ、1 分に 30 件を超えたら残りをまとめる
 *   (直近 1 分に送った行の数は DB で数えるので、再起動や複数台でも同じ上限になる)。
 * - 送信は利用者ごとに切り離して並べ (同時に USER_CONCURRENCY 人まで)、1 人分に
 *   DELIVER_TIMEOUT_MS の上限を付ける。1 人の遅さや失敗で、ほかの利用者を待たせない。
 */

const JOB_BATCH = 200;
const NOTICE_BATCH = 500;
/** NOTIFY の payload の上限 (8000 バイト) に余裕を持たせた値。 */
const NOTIFY_PAYLOAD_LIMIT = 7000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** 取ったまま送り終えていない行を、取り直してよくなるまでの時間。 */
export const CLAIM_LEASE_MS = 2 * 60_000;
/** 1 つの行を取る回数の上限。超えたら送らずに済ませる。 */
export const MAX_DISPATCH_ATTEMPTS = 3;
/** 同時に送る利用者の数。 */
const USER_CONCURRENCY = 8;
/** 利用者 1 人分の送信の上限。過ぎたら待たずに次へ進む (送信そのものは裏で続く)。 */
const DELIVER_TIMEOUT_MS = 60_000;

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
  /** 利用者 1 人分の送信の上限 (テスト用)。 */
  deliverTimeoutMs?: number;
};

type UserNoticeSettings = {
  settings: CalendarNotificationSettings;
  timeZone: string;
};

export type DispatchResult = { reminders: number; notices: number };

type NoticeRow = typeof eventNotices.$inferSelect;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class NotificationDispatcher {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private running: Promise<DispatchResult> | null = null;
  private again = false;
  private stopped = false;
  private lastPrune = 0;

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
        this.log(`予定の通知を送れませんでした: ${errorText(error)}`);
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
      .where(
        and(
          isNull(eventReminderJobs.sentAt),
          // 取ったままの行は、取り直せる時刻まで定期の確認に任せる (すぐに起こし続けない)。
          isNull(eventReminderJobs.claimedAt),
        ),
      )
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
      const claimed = await this.dispatchReminders();
      result.reminders += claimed;
      if (claimed < JOB_BATCH || this.stopped) break;
    }
    for (;;) {
      const claimed = await this.dispatchNotices();
      result.notices += claimed;
      if (claimed < NOTICE_BATCH || this.stopped) break;
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

  /**
   * 利用者ごとの仕事を並べて走らせる (同時に USER_CONCURRENCY 人まで)。1 人分には上限の時間を
   * 付け、過ぎたら待たずに done を呼ぶ。投げた利用者は done を呼ばない (取ったまま残し、
   * CLAIM_LEASE_MS の後に取り直す)。
   */
  private async perUser(
    userIds: readonly string[],
    work: (userId: string) => Promise<void>,
    done: (userId: string) => Promise<void>,
  ) {
    const timeoutMs = this.options.deliverTimeoutMs ?? DELIVER_TIMEOUT_MS;
    const queue = [...userIds];
    const runner = async () => {
      for (;;) {
        const userId = queue.shift();
        if (userId === undefined) return;
        let timer: NodeJS.Timeout | undefined;
        try {
          const timedOut = await Promise.race([
            work(userId).then(() => false),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(true), timeoutMs);
            }),
          ]);
          if (timedOut) {
            this.log(
              `利用者 ${userId} への予定の通知の送信が ${timeoutMs / 1000} 秒で終わりませんでした。待たずに次へ進みます`,
            );
          }
          await done(userId);
        } catch (error) {
          this.log(
            `利用者 ${userId} への予定の通知を送れませんでした (後でやり直します): ${errorText(error)}`,
          );
        } finally {
          clearTimeout(timer);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(USER_CONCURRENCY, userIds.length) },
        runner,
      ),
    );
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
          attempts: eventReminderJobs.attempts,
        })
        .from(eventReminderJobs)
        .where(
          and(
            isNull(eventReminderJobs.sentAt),
            lte(eventReminderJobs.fireAt, new Date(now)),
            or(
              isNull(eventReminderJobs.claimedAt),
              lt(eventReminderJobs.claimedAt, new Date(now - CLAIM_LEASE_MS)),
            ),
            // 例外の行が消えて中身の無い回は、Indexer が作り直すまで取らない。
            sql`exists (select 1 from ${eventOccurrences} where ${eventOccurrences.id} = ${eventReminderJobs.occurrenceId} and ${eventOccurrences.eventId} is not null)`,
          ),
        )
        .orderBy(asc(eventReminderJobs.fireAt))
        .limit(JOB_BATCH)
        .for("update", { skipLocked: true });
      if (jobs.length === 0) return [];
      const ids = jobs.map((job) => job.id);
      const exhausted = jobs
        .filter((job) => job.attempts >= MAX_DISPATCH_ATTEMPTS)
        .map((job) => job.id);
      await tx
        .update(eventReminderJobs)
        .set({
          claimedAt: new Date(now),
          attempts: sql`${eventReminderJobs.attempts} + 1`,
        })
        .where(inArray(eventReminderJobs.id, ids));
      if (exhausted.length > 0) {
        await tx
          .update(eventReminderJobs)
          .set({ sentAt: new Date(now) })
          .where(inArray(eventReminderJobs.id, exhausted));
      }
      return jobs.filter((job) => job.attempts < MAX_DISPATCH_ATTEMPTS);
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
        eventId: events.id,
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
    const jobIds = new Map<string, string[]>();
    for (const job of claimed) {
      const ids = jobIds.get(job.userId) ?? [];
      ids.push(job.id);
      jobIds.set(job.userId, ids);
      try {
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
      } catch (error) {
        // 1 件の文言の組み立ての失敗で、まとまりのほかの通知を落とさない。
        this.log(
          `リマインダー ${job.id} を組み立てられませんでした: ${errorText(error)}`,
        );
      }
    }
    const push = this.options.push;
    await this.perUser(
      [...jobIds.keys()],
      async (userId) => {
        const list = deliveries.get(userId);
        if (push?.enabled && list) await push.deliver(userId, list, now);
      },
      async (userId) => {
        await this.db
          .update(eventReminderJobs)
          .set({ sentAt: new Date(now) })
          .where(inArray(eventReminderJobs.id, jobIds.get(userId) ?? []));
      },
    );
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
        .where(
          and(
            isNull(eventNotices.sentAt),
            or(
              isNull(eventNotices.claimedAt),
              lt(eventNotices.claimedAt, new Date(now - CLAIM_LEASE_MS)),
            ),
          ),
        )
        .orderBy(asc(eventNotices.createdAt), asc(eventNotices.id))
        .limit(NOTICE_BATCH)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];
      const exhausted = rows
        .filter((row) => row.attempts >= MAX_DISPATCH_ATTEMPTS)
        .map((row) => row.id);
      await tx
        .update(eventNotices)
        .set({
          claimedAt: new Date(now),
          attempts: sql`${eventNotices.attempts} + 1`,
        })
        .where(
          inArray(
            eventNotices.id,
            rows.map((row) => row.id),
          ),
        );
      if (exhausted.length > 0) {
        await tx
          .update(eventNotices)
          .set({ sentAt: new Date(now), claimedAt: null })
          .where(inArray(eventNotices.id, exhausted));
      }
      return rows.filter((row) => row.attempts < MAX_DISPATCH_ATTEMPTS);
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

    const byUser = new Map<string, NoticeRow[]>();
    for (const row of claimed) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    /** 実際に通知になった行 (直近 1 分の数に入れる)。ほかは claimedAt を外して済ませる。 */
    const delivered = new Set<string>();
    await this.perUser(
      [...byUser.keys()],
      async (userId) => {
        const user = users.get(userId);
        const rows = byUser.get(userId) ?? [];
        if (!user) return;
        const messages = await this.noticeMessages(
          userId,
          rows,
          user,
          calendarById,
          now,
          delivered,
        );
        const limited = await this.limit(userId, rows, messages, now);
        if (limited.length === 0) return;
        await this.announce(userId, limited);
        const push = this.options.push;
        if (push?.enabled) {
          await push.deliver(
            userId,
            limited.map((message) => ({ message })),
            now,
          );
        }
      },
      async (userId) => {
        const rows = byUser.get(userId) ?? [];
        const sent = rows.filter((row) => delivered.has(row.id));
        const skipped = rows.filter((row) => !delivered.has(row.id));
        if (sent.length > 0) {
          await this.db
            .update(eventNotices)
            .set({ sentAt: new Date(now) })
            .where(
              inArray(
                eventNotices.id,
                sent.map((row) => row.id),
              ),
            );
        }
        if (skipped.length > 0) {
          await this.db
            .update(eventNotices)
            .set({ sentAt: new Date(now), claimedAt: null })
            .where(
              inArray(
                eventNotices.id,
                skipped.map((row) => row.id),
              ),
            );
        }
      },
    );
    return claimed.length;
  }

  /** 利用者 1 人分の行から、送る通知を作る。通知にした行は delivered に入れる。 */
  private async noticeMessages(
    userId: string,
    rows: readonly NoticeRow[],
    user: UserNoticeSettings,
    calendarById: Map<
      string,
      Pick<
        typeof calendars.$inferSelect,
        "id" | "source" | "readOnly" | "providerState"
      >
    >,
    now: number,
    delivered: Set<string>,
  ): Promise<CalendarPushMessage[]> {
    const options = {
      timeZone: user.timeZone,
      now,
      detail: user.settings.detail,
    };
    const messages: CalendarPushMessage[] = [];
    // 招待はカレンダーごとにまとめる。
    const invites = new Map<string, NoticeRow[]>();
    for (const row of rows) {
      try {
        // 消えたカレンダーの行は送らない (L5)。
        if (!calendarById.has(row.calendarId)) continue;
        const snapshot = row.snapshot as EventNoticeSnapshot;
        // 繰り返す予定は次の回の日時と期限を使い、次の回が無ければ送らない (H1)。
        const occurrence = safeNoticeOccurrence(snapshot, now, user.timeZone);
        if (!occurrence) continue;
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
            ...cancelText(snapshot, options, occurrence.timing),
            tag: updateTag(row.eventId),
            eventId: row.eventId,
            ...(occurrence.end !== undefined
              ? { expiresAt: occurrence.end }
              : {}),
            calendarId: row.calendarId,
          });
          delivered.add(row.id);
          continue;
        }
        const previous = await this.previousSnapshot(row);
        if (!previous) continue;
        messages.push({
          kind: "event-update",
          ...updateText(previous, snapshot, options, occurrence.timing),
          tag: updateTag(row.eventId),
          eventId: row.eventId,
          ...(occurrence.end !== undefined
            ? { expiresAt: occurrence.end }
            : {}),
          calendarId: row.calendarId,
        });
        delivered.add(row.id);
      } catch (error) {
        this.log(
          `予定の通知 ${row.id} を組み立てられませんでした: ${errorText(error)}`,
        );
      }
    }
    for (const [calendarId, list] of invites) {
      if (list.length > MAX_SINGLE_INVITE_NOTIFICATIONS) {
        messages.push(batchMessage(calendarId, list, options));
        for (const row of list) delivered.add(row.id);
        continue;
      }
      const calendar = calendarById.get(calendarId);
      const canRespond =
        !!this.options.rsvp &&
        !!calendar &&
        !calendar.readOnly &&
        calendarScheduling(calendar) === "server";
      for (const row of list) {
        try {
          const snapshot = row.snapshot as EventNoticeSnapshot;
          const occurrence = safeNoticeOccurrence(snapshot, now, user.timeZone);
          if (!occurrence) continue;
          const rsvp = this.options.rsvp;
          messages.push({
            kind: "event-invite",
            ...inviteText(snapshot, options, occurrence.timing),
            tag: inviteTag(row.eventId),
            eventId: row.eventId,
            ...(occurrence.end !== undefined
              ? { expiresAt: occurrence.end }
              : {}),
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
          delivered.add(row.id);
        } catch (error) {
          this.log(
            `予定の通知 ${row.id} を組み立てられませんでした: ${errorText(error)}`,
          );
        }
      }
    }
    return messages;
  }

  /**
   * 1 分に MAX_NOTICES_PER_MINUTE を超える分は、まとめの 1 件にする (L3)。直近 1 分に送った数は
   * DB で数える (今回取った行は除く)。まとめの tag は毎回同じなので、溜まらずに置き換わる。
   */
  private async limit(
    userId: string,
    rows: readonly NoticeRow[],
    messages: CalendarPushMessage[],
    now: number,
  ): Promise<CalendarPushMessage[]> {
    if (messages.length === 0) return messages;
    const [row] = await this.db
      .select({ value: count() })
      .from(eventNotices)
      .where(
        and(
          eq(eventNotices.userId, userId),
          isNotNull(eventNotices.sentAt),
          gt(eventNotices.claimedAt, new Date(now - 60_000)),
          notInArray(
            eventNotices.id,
            rows.map((item) => item.id),
          ),
        ),
      );
    const recent = Number(row?.value ?? 0);
    const room = Math.max(MAX_NOTICES_PER_MINUTE - recent, 0);
    if (messages.length <= room) return messages;
    const kept = messages.slice(0, Math.max(room - 1, 0));
    const rest = messages.slice(kept.length);
    return [
      ...kept,
      {
        kind: "event-invites-batch",
        ...noticeOverflowText(rest.length),
        tag: NOTICE_OVERFLOW_TAG,
        eventId: null,
      },
    ];
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
          // 同じ取り込みで入れた行 (created_at が同じ) は id (uuidv7) の順。created_at は
          // マイクロ秒まであり JS の Date では比べられないので、DB の中で比べる。
          sql`(${eventNotices.createdAt}, ${eventNotices.id}) < (select n.created_at, n.id from ${eventNotices} n where n.id = ${row.id})`,
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
