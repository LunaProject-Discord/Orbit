import {
  calendarNotifies,
  calendarScheduling,
  DEFAULT_REMINDER_TIME_ZONE,
  EVENT_NOTICE_RETENTION_DAYS,
  type EventNoticeKind,
  type EventNoticeSnapshot,
  eventNoticeChanges,
  inviteRole,
} from "@orbit/core";
import {
  accounts,
  calendars,
  type Database,
  eventAttendees,
  eventNotices,
  events,
  type StoredEventNoticeSnapshot,
  userSettings,
  workerCursors,
} from "@orbit/db";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { Tx } from "../changes.js";
import { safeNoticeOccurrence } from "./notice-timing.js";
import type { AccountRow, CalendarRow } from "./provider.js";

/**
 * 相手側から来た予定の変更から、新しい招待・招待された予定の変更・取り消しを見つけ、
 * event_notices に足す (段取り 9、設計 2.2、2.3、6.2)。取り込み (ingestEventDelta) が予定を
 * 書いた直後と、書き戻しの競合で相手側の内容を書いた直後 (writeRemoteEvents の note) に、
 * 同じトランザクションで呼ぶ。送るのは NotificationDispatcher。
 *
 * - 対象は招待を相手側で配るカレンダー (Google、Microsoft、自動で配る CalDAV) の、
 *   自分が参加者で主催者でない予定 (共有カレンダーで self が自分でない予定は除く)。
 * - 最初の同期 (lastSyncedAt が null)、過去の予定、通知オフのカレンダー、自分が不参加の予定の変更は
 *   送らず、送信済みの行を静かに入れて「前に知らせた内容」だけを作る。
 * - 基準の無い既存の行 (導入前からある招待) が変わったときも、新しい招待とはせず基準だけ作る (M3)。
 * - 前に知らせた内容 (最新の行の snapshot) と比べ、日時か場所が変わったら update。
 * - 知らせ済みの繰り返しの新しい例外は、元の回 (recurrenceId と原本の長さ・場所) と比べ、
 *   違えば update、取り消された回なら cancel (1 回だけの変更・取り消し。M4)。
 * - 取り消しは、行が cancelled で主催者の取り消しと分かるときだけ送る。相手側で行が消えたときと
 *   Google の cancelled は、自分が Google の画面で消した場合と見分けられないので記録だけにする
 *   (M9。誤って「取り消されました」と出さない側に倒す)。直前の自分の出欠が不参加なら送らない (L2)。
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
  /** upserted のうち、今回新しく作った行 (基準の無い既存の行と見分ける)。 */
  created: readonly string[];
  deleted: readonly string[];
  now: Date;
};

const lower = (value: string) => value.trim().toLowerCase();
const DAY_MS = 24 * 60 * 60_000;

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
  selfStatus: string | null = null,
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
    selfStatus,
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

/**
 * snapshot の予定がまだ先か (終了が今より後。繰り返す予定は次の回があるか)。timeZone は
 * 終日の終わりを決める利用者のタイムゾーン。計算できない繰り返しは先として扱う。
 */
export function noticeIsUpcoming(
  snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
  now: Date,
  timeZone: string = DEFAULT_REMINDER_TIME_ZONE,
): boolean {
  return safeNoticeOccurrence(snapshot, now.getTime(), timeZone) !== null;
}

/** 開始が先か (招待の通知の条件)。繰り返す予定は次の回があるか。 */
function startsLater(
  snapshot: EventNoticeSnapshot,
  now: Date,
  timeZone: string,
): boolean {
  const occurrence = safeNoticeOccurrence(snapshot, now.getTime(), timeZone);
  if (!occurrence) return false;
  if (snapshot.rrule || occurrence.start === undefined) return true;
  return occurrence.start > now.getTime();
}

/**
 * 繰り返しの例外の「元の回」(変える前の内容)。原本の snapshot の長さと場所を、recurrenceId の
 * 開始に当てる。題名などは例外の snapshot のまま。作れなければ null。
 */
function originalOccurrence(
  parent: EventNoticeSnapshot | StoredEventNoticeSnapshot,
  recurrenceId: string,
  exception: EventNoticeSnapshot,
): EventNoticeSnapshot | null {
  const base = {
    title: exception.title,
    organizer: exception.organizer,
    sequence: exception.sequence,
    timeZone: exception.timeZone,
    selfStatus: exception.selfStatus ?? null,
    location: parent.location,
    rrule: null,
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(recurrenceId)) {
    if (!parent.allDay || !parent.startDate) return null;
    const start = Date.parse(`${parent.startDate}T00:00:00Z`);
    const end = Date.parse(`${parent.endDate ?? parent.startDate}T00:00:00Z`);
    const days = Math.max(Math.round((end - start) / DAY_MS), 0);
    const first = Date.parse(`${recurrenceId}T00:00:00Z`);
    if (!Number.isFinite(first)) return null;
    return {
      ...base,
      allDay: true,
      startDate: recurrenceId,
      endDate: new Date(first + days * DAY_MS).toISOString().slice(0, 10),
    };
  }
  const start = Date.parse(recurrenceId);
  if (parent.allDay || !Number.isFinite(start) || !parent.startAt) return null;
  const length = Math.max(
    Date.parse(parent.endAt ?? parent.startAt) - Date.parse(parent.startAt),
    0,
  );
  if (!Number.isFinite(length)) return null;
  return {
    ...base,
    allDay: false,
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + length).toISOString(),
  };
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
  // 取り消しを送ってよいか (M9)。Google は自分の画面での削除も cancelled で届くため送らない。
  const cancelsAreOrganizers = calendar.source !== "google";
  const owned = ownsCalendar(calendar);
  const me = new Set(
    [account.email, account.username]
      .filter((value) => value.includes("@"))
      .map(lower),
  );
  const [settingsRow] = await tx
    .select({ timeZone: userSettings.timeZone })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  const timeZone = settingsRow?.timeZone ?? DEFAULT_REMINDER_TIME_ZONE;
  const upcomingOf = (
    snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
  ) => noticeIsUpcoming(snapshot, now, timeZone);

  const upsertedSet = new Set(input.upserted);
  const createdSet = new Set(input.created);
  const rows: EventRow[] = [];
  for (const batch of chunks([...upsertedSet])) {
    rows.push(
      ...(await tx
        .select()
        .from(events)
        .where(and(eq(events.userId, userId), inArray(events.id, batch)))),
    );
  }

  // 前に知らせた内容。例外の比べる相手として、原本の分も読む。
  const ids = [
    ...new Set([
      ...input.upserted,
      ...input.deleted,
      ...rows.flatMap((row) => (row.parentId ? [row.parentId] : [])),
    ]),
  ];
  const latest = new Map<
    string,
    { kind: EventNoticeKind; snapshot: StoredEventNoticeSnapshot }
  >();
  for (const batch of chunks(ids)) {
    const found = await tx
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
    for (const row of found) latest.set(row.eventId, row);
  }

  const inserts: (typeof eventNotices.$inferInsert)[] = [];
  const add = (
    eventId: string,
    kind: EventNoticeKind,
    snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot,
    send: boolean,
    /** 同じ取り込みのほかの行より前の行にする (比べる相手を先に入れるとき)。 */
    earlier = false,
  ) => {
    inserts.push({
      userId,
      calendarId: calendar.id,
      eventId,
      kind,
      snapshot: snapshot as StoredEventNoticeSnapshot,
      sentAt: send ? null : now,
      // 同じトランザクションの行は created_at (now()) が同じで、uuidv7 の id も同じミリ秒の
      // うちは順に並ばないので、DB の時計で 1 ミリ秒前にする。
      ...(earlier
        ? {
            createdAt: sql`now() - interval '1 millisecond'` as unknown as Date,
          }
        : {}),
    });
  };
  const declined = (
    snapshot: EventNoticeSnapshot | StoredEventNoticeSnapshot | undefined,
  ) => snapshot?.selfStatus === "declined";

  // 相手側で消えた予定: 前に知らせたことがあれば取り消しとして記録する。自分が消した場合と
  // 見分けられないので送らない (M9)。
  for (const id of input.deleted) {
    if (upsertedSet.has(id)) continue;
    const previous = latest.get(id);
    if (!previous || previous.kind === "cancel") continue;
    add(id, "cancel", previous.snapshot, false);
  }

  // 作った・変わった予定。
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
  // 今回届いた原本の snapshot (例外の元の回を、新しい原本の内容で作るため)。
  const fresh = new Map<string, EventNoticeSnapshot>();
  for (const row of rows) {
    if (row.parentId) continue;
    const self = (attendees.get(row.id) ?? []).find((item) => item.self);
    const snapshot = noticeSnapshotOf(
      row,
      calendar.timeZone,
      self?.status ?? null,
    );
    if (snapshot) fresh.set(row.id, snapshot);
  }
  /** 前の同期までに知らせ済みの原本 (取り消していない) の内容。 */
  const knownParent = (row: EventRow) => {
    if (!row.parentId) return null;
    const previous = latest.get(row.parentId);
    if (!previous || previous.kind === "cancel") return null;
    return fresh.get(row.parentId) ?? previous.snapshot;
  };

  for (const row of rows) {
    const previous = latest.get(row.id);
    const parent = knownParent(row);

    // 知らせ済みの繰り返しの、新しく取り消された回 (取り消しの例外には参加者が無いことがある)。
    if (row.status === "cancelled" && row.recurrenceId && parent && !previous) {
      const exception = noticeSnapshotOf(
        row,
        calendar.timeZone,
        parent.selfStatus ?? null,
      );
      const original = exception
        ? originalOccurrence(parent, row.recurrenceId, exception)
        : null;
      if (original) {
        add(
          row.id,
          "cancel",
          original,
          !quiet &&
            cancelsAreOrganizers &&
            !declined(parent) &&
            upcomingOf(original),
        );
      }
      continue;
    }

    const list = attendees.get(row.id) ?? [];
    if (
      inviteRole({ organizer: row.organizer, attendees: list }) !== "attendee"
    ) {
      continue;
    }
    const self = list.find((attendee) => attendee.self);
    if (!self) continue;
    if (!owned && !me.has(lower(self.email))) continue;
    const snapshot = noticeSnapshotOf(row, calendar.timeZone, self.status);
    if (!snapshot) continue;
    const upcoming = upcomingOf(snapshot);

    if (row.status === "cancelled") {
      if (previous && previous.kind !== "cancel") {
        add(
          row.id,
          "cancel",
          snapshot,
          !quiet &&
            cancelsAreOrganizers &&
            upcoming &&
            !declined(previous.snapshot) &&
            self.status !== "declined",
        );
      }
      continue;
    }
    if (!previous && !createdSet.has(row.id)) {
      // 基準の無い既存の行 (導入前からある招待) が変わった: 新しい招待ではないので基準だけ。
      add(row.id, "invite", snapshot, false);
      continue;
    }
    if (!previous && parent && row.recurrenceId) {
      // 知らせ済みの繰り返しの新しい例外: 元の回と日時か場所が違えば 1 回だけの変更。
      const original = originalOccurrence(parent, row.recurrenceId, snapshot);
      const changed = original
        ? eventNoticeChanges(original, snapshot)
        : { when: false, location: false };
      if (original && (changed.when || changed.location)) {
        // 比べる相手 (元の回) を、変更の行より前の行として入れる。
        add(row.id, "invite", original, false, true);
        add(
          row.id,
          "update",
          snapshot,
          !quiet &&
            self.status !== "declined" &&
            (upcomingOf(original) || upcoming),
        );
      } else {
        add(row.id, "invite", snapshot, false);
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
        startsLater(snapshot, now, timeZone);
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

/** seedEventNoticeBaselines を済ませた印 (worker_cursors の名前)。 */
export const EVENT_NOTICE_BASELINE_CURSOR = "event-notice-baseline";

/**
 * 導入前からある招待に、送信済みの基準 (invite) を入れる (レビュー M3)。最初の 1 回だけ。
 * これが無いと、導入前からある招待の取り消し・変更を見つけられない。
 * 基準の無い予定だけを対象にし、送らない (最初の同期と同じ扱い)。返すのは調べたカレンダーの数。
 */
export async function seedEventNoticeBaselines(
  db: Database,
  options: { now?: () => number } = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const [done] = await db
    .select({ seq: workerCursors.seq })
    .from(workerCursors)
    .where(eq(workerCursors.name, EVENT_NOTICE_BASELINE_CURSOR));
  if (done) return 0;
  const rows = await db
    .select({ calendar: calendars, account: accounts })
    .from(calendars)
    .innerJoin(accounts, eq(accounts.id, calendars.accountId));
  let count = 0;
  for (const { calendar, account } of rows) {
    if (calendarScheduling(calendar) !== "server") continue;
    count += 1;
    const keepAfter = new Date(now() - DAY_MS);
    const candidates = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendar.id),
          or(
            isNotNull(events.rrule),
            isNotNull(events.parentId),
            sql`coalesce(${events.endAt}, ${events.startAt}) > ${keepAfter.toISOString()}::timestamptz`,
            sql`coalesce(${events.endDate}, ${events.startDate}) >= ${keepAfter.toISOString().slice(0, 10)}::date`,
          ),
          notExists(
            db
              .select({ id: eventNotices.id })
              .from(eventNotices)
              .where(
                and(
                  eq(eventNotices.userId, calendar.userId),
                  eq(eventNotices.eventId, events.id),
                ),
              ),
          ),
        ),
      );
    for (const batch of chunks(candidates.map((row) => row.id))) {
      await db.transaction((tx) =>
        noteRemoteEvents(tx, {
          account,
          // 最初の同期と同じく、送信済みの基準だけを入れる。
          calendar: { ...calendar, lastSyncedAt: null },
          upserted: batch,
          created: batch,
          deleted: [],
          now: new Date(now()),
        }),
      );
    }
  }
  await db
    .insert(workerCursors)
    .values({ name: EVENT_NOTICE_BASELINE_CURSOR, seq: 1n })
    .onConflictDoNothing();
  return count;
}

/**
 * 古い行を消す。返すのは消した数。
 * - 送信済みで、予定の終了から 7 日たった行 (繰り返す予定は終わりが分からないので次へ)。
 * - 予定の行がもう無く、作って 30 日以上たった送信済みの行 (繰り返す予定の行を含む。L5)。
 */
export async function pruneEventNotices(
  db: Database,
  now: Date,
): Promise<number> {
  const before = new Date(
    now.getTime() - EVENT_NOTICE_RETENTION_DAYS * 24 * 60 * 60_000,
  );
  const orphanBefore = new Date(now.getTime() - ORPHAN_NOTICE_DAYS * DAY_MS);
  const removed = await db
    .delete(eventNotices)
    .where(
      and(
        isNotNull(eventNotices.sentAt),
        or(
          and(
            isNull(sql`${eventNotices.snapshot}->>'rrule'`),
            sql`coalesce((${eventNotices.snapshot}->>'endAt')::timestamptz, ((${eventNotices.snapshot}->>'endDate')::date)::timestamptz) < ${before.toISOString()}::timestamptz`,
          ),
          and(
            sql`${eventNotices.createdAt} < ${orphanBefore.toISOString()}::timestamptz`,
            notExists(
              db
                .select({ id: events.id })
                .from(events)
                .where(eq(events.id, eventNotices.eventId)),
            ),
          ),
        ),
      ),
    )
    .returning({ id: eventNotices.id });
  return removed.length;
}

/** 予定の行が消えた event_notices を残す日数。 */
const ORPHAN_NOTICE_DAYS = 30;

function chunks<T>(values: readonly T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}
