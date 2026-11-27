import {
  calendarNotifies,
  calendarScheduling,
  EVENT_NOTICE_RETENTION_DAYS,
  type EventNoticeKind,
  type EventNoticeSnapshot,
  eventNoticeChanges,
  inviteRole,
} from "@orbit/core";
import {
  type Database,
  eventAttendees,
  eventNotices,
  events,
  type StoredEventNoticeSnapshot,
} from "@orbit/db";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Tx } from "../changes.js";
import type { AccountRow, CalendarRow } from "./provider.js";

/**
 * 相手側から来た予定の変更から、新しい招待・招待された予定の変更・取り消しを見つけ、
 * event_notices に足す (段取り 9、設計 2.2、2.3、6.2)。取り込み (ingestEventDelta) が予定を
 * 書いた直後に、同じトランザクションで 1 回だけ呼ぶ。送るのは NotificationDispatcher。
 *
 * - 対象は招待を相手側で配るカレンダー (Google、Microsoft、自動で配る CalDAV) の、
 *   自分が参加者で主催者でない予定 (共有カレンダーで self が自分でない予定は除く)。
 * - 最初の同期 (lastSyncedAt が null)、過去の予定、通知オフのカレンダー、自分が不参加の予定の変更は
 *   送らず、送信済みの行を静かに入れて「前に知らせた内容」だけを作る。
 * - 前に知らせた内容 (最新の行の snapshot) と比べ、日時か場所が変わったら update、
 *   取り消し (cancelled) か相手側で消えたら cancel。
 */

type EventRow = typeof events.$inferSelect;

type NoteInput = {
  account: Pick<AccountRow, "userId" | "email" | "username">;
  /** この同期の前の行 (lastSyncedAt が null なら最初の同期)。 */
  calendar: Pick<
    CalendarRow,
    | "id"
    | "source"
    | "notify"
    | "readOnly"
    | "providerState"
    | "accountId"
    | "lastSyncedAt"
    | "timeZone"
  >;
  upserted: readonly string[];
  deleted: readonly string[];
  now: Date;
};

const lower = (value: string) => value.trim().toLowerCase();

/** 自分のカレンダーか (Orbit 内、primary、accessRole が owner)。API の ownsCalendar と同じ。 */
function ownsCalendar(calendar: NoteInput["calendar"]): boolean {
  if (calendar.accountId === null) return true;
  const state = calendar.providerState ?? {};
  return state.primary === true || state.accessRole === "owner";
}

/** 予定の行から「知らせた内容」を作る。時刻が欠けていれば null。 */
export function noticeSnapshotOf(
  row: EventRow,
  calendarTimeZone: string | null,
): EventNoticeSnapshot | null {
  const organizer = row.organizer
    ? row.organizer.name?.trim() || row.organizer.email
    : null;
  const base = {
    title: row.summary,
    location: row.location,
    organizer,
    sequence: row.sequence,
    rrule: row.rrule,
    timeZone: row.startTimeZone ?? calendarTimeZone,
  };
  if (row.allDay) {
    if (!row.startDate) return null;
    return {
      ...base,
      allDay: true,
      startDate: row.startDate,
      endDate:
        row.endDate && row.endDate > row.startDate
          ? row.endDate
          : row.startDate,
    };
  }
  if (!row.startAt) return null;
  return {
    ...base,
    allDay: false,
    startAt: row.startAt.toISOString(),
    endAt: (row.endAt ?? row.startAt).toISOString(),
  };
}

/** snapshot の予定がまだ先か (終了が今より後)。繰り返す予定は常に先として扱う。 */
export function noticeIsUpcoming(
  snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
  now: Date,
): boolean {
  if (snapshot.rrule) return true;
  const end = snapshot.allDay
    ? Date.parse(`${snapshot.endDate}T00:00:00Z`)
    : Date.parse(snapshot.endAt ?? "");
  return Number.isFinite(end) ? end > now.getTime() : false;
}

/** 開始が先か (招待の通知の条件)。 */
function startsLater(snapshot: EventNoticeSnapshot, now: Date): boolean {
  if (snapshot.rrule) return true;
  const start = snapshot.allDay
    ? Date.parse(`${snapshot.startDate}T00:00:00Z`)
    : Date.parse(snapshot.startAt);
  return start > now.getTime();
}

export async function noteRemoteEvents(
  tx: Tx | Database,
  input: NoteInput,
): Promise<void> {
  const { account, calendar, now } = input;
  if (input.upserted.length === 0 && input.deleted.length === 0) return;
  if (
    calendarScheduling({
      source: calendar.source,
      readOnly: calendar.readOnly,
      providerState: calendar.providerState,
    }) !== "server"
  ) {
    return;
  }
  const userId = account.userId;
  // 送る条件を満たさないもの (最初の同期・通知オフ) は、送信済みとして基準だけ作る。
  const quiet = calendar.lastSyncedAt === null || !calendarNotifies(calendar);
  const owned = ownsCalendar(calendar);
  const me = new Set(
    [account.email, account.username]
      .filter((value) => value.includes("@"))
      .map(lower),
  );

  const ids = [...new Set([...input.upserted, ...input.deleted])];
  const latest = new Map<
    string,
    { kind: EventNoticeKind; snapshot: StoredEventNoticeSnapshot }
  >();
  for (const batch of chunks(ids)) {
    const rows = await tx
      .selectDistinctOn([eventNotices.eventId], {
        eventId: eventNotices.eventId,
        kind: eventNotices.kind,
        snapshot: eventNotices.snapshot,
      })
      .from(eventNotices)
      .where(
        and(
          eq(eventNotices.userId, userId),
          inArray(eventNotices.eventId, batch),
        ),
      )
      .orderBy(
        eventNotices.eventId,
        desc(eventNotices.createdAt),
        desc(eventNotices.id),
      );
    for (const row of rows) latest.set(row.eventId, row);
  }

  const inserts: (typeof eventNotices.$inferInsert)[] = [];
  const add = (
    eventId: string,
    kind: EventNoticeKind,
    snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
    send: boolean,
  ) => {
    inserts.push({
      userId,
      calendarId: calendar.id,
      eventId,
      kind,
      snapshot: snapshot as StoredEventNoticeSnapshot,
      sentAt: send ? null : now,
    });
  };

  // 相手側で消えた予定: 前に知らせたことがあれば取り消し。
  const upsertedSet = new Set(input.upserted);
  for (const id of input.deleted) {
    if (upsertedSet.has(id)) continue;
    const previous = latest.get(id);
    if (!previous || previous.kind === "cancel") continue;
    add(
      id,
      "cancel",
      previous.snapshot,
      !quiet && noticeIsUpcoming(previous.snapshot, now),
    );
  }

  // 作った・変わった予定。
  const rows: EventRow[] = [];
  for (const batch of chunks([...upsertedSet])) {
    rows.push(
      ...(await tx
        .select()
        .from(events)
        .where(and(eq(events.userId, userId), inArray(events.id, batch)))),
    );
  }
  const attendees = new Map<
    string,
    { email: string; self: boolean; status: string }[]
  >();
  for (const batch of chunks(rows.map((row) => row.id))) {
    for (const row of await tx
      .select({
        eventId: eventAttendees.eventId,
        email: eventAttendees.email,
        self: eventAttendees.self,
        status: eventAttendees.status,
      })
      .from(eventAttendees)
      .where(inArray(eventAttendees.eventId, batch))) {
      const list = attendees.get(row.eventId) ?? [];
      list.push(row);
      attendees.set(row.eventId, list);
    }
  }
  for (const row of rows) {
    const list = attendees.get(row.id) ?? [];
    if (
      inviteRole({ organizer: row.organizer, attendees: list }) !== "attendee"
    ) {
      continue;
    }
    const self = list.find((attendee) => attendee.self);
    if (!self) continue;
    if (!owned && !me.has(lower(self.email))) continue;
    const snapshot = noticeSnapshotOf(row, calendar.timeZone);
    if (!snapshot) continue;
    const previous = latest.get(row.id);
    const upcoming = noticeIsUpcoming(snapshot, now);

    if (row.status === "cancelled") {
      if (previous && previous.kind !== "cancel") {
        add(row.id, "cancel", snapshot, !quiet && upcoming);
      }
      continue;
    }
    if (!previous || previous.kind === "cancel") {
      // 新しい招待 (取り消しのあとに出し直された招待を含む)。
      // 繰り返しの例外は、原本の招待と一緒に来たか原本を知らせ済みなら、原本の 1 件にまとめる。
      const partOfSeries =
        row.parentId !== null &&
        (upsertedSet.has(row.parentId) || latest.has(row.parentId));
      const send =
        !quiet &&
        !partOfSeries &&
        self.status === "needs_action" &&
        startsLater(snapshot, now);
      add(row.id, "invite", snapshot, send);
      continue;
    }
    const changed = eventNoticeChanges(
      previous.snapshot as EventNoticeSnapshot,
      snapshot,
    );
    if (!changed.when && !changed.location) continue;
    add(
      row.id,
      "update",
      snapshot,
      !quiet && upcoming && self.status !== "declined",
    );
  }

  for (const batch of chunks(inserts, 200)) {
    await tx.insert(eventNotices).values(batch);
  }
}

/**
 * 予定の終了から 7 日たった、送信済みの行を消す (繰り返す予定は終わりが分からないので残す)。
 * 返すのは消した数。
 */
export async function pruneEventNotices(
  db: Database,
  now: Date,
): Promise<number> {
  const before = new Date(
    now.getTime() - EVENT_NOTICE_RETENTION_DAYS * 24 * 60 * 60_000,
  );
  const removed = await db
    .delete(eventNotices)
    .where(
      and(
        isNotNull(eventNotices.sentAt),
        isNull(sql`${eventNotices.snapshot}->>'rrule'`),
        sql`coalesce((${eventNotices.snapshot}->>'endAt')::timestamptz, ((${eventNotices.snapshot}->>'endDate')::date)::timestamptz) < ${before.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: eventNotices.id });
  return removed.length;
}

function chunks<T>(values: readonly T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}
