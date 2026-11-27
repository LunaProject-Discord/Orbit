import {
  type CalendarNotificationSettingsNotification,
  CHANNEL_CALENDAR_NOTIFICATION_SETTINGS,
  CHANNEL_CHANGES,
  calendarNotifies,
  calendarRemindersFingerprint,
  DEFAULT_REMINDER_TIME_ZONE,
  type EventTiming,
  expandOccurrences,
  type PlannedReminder,
  planReminders,
  REMINDER_INDEXER_CURSOR,
  REMINDER_INDEXER_OVERLAP_MS,
  REMINDER_INDEXER_POLL_MS,
  REMINDER_LATE_LIMIT_MS,
  type RecurrenceException,
  type ReminderCalendar,
  type ReminderEvent,
  type ReminderSettings,
  readCalendarNotificationSettings,
  SERVER_OCCURRENCE_KEEP_MS,
  SERVER_OCCURRENCE_WINDOW_DAYS,
} from "@orbit/core";
import {
  calendars,
  changes,
  type Database,
  eventAttendees,
  eventOccurrences,
  eventReminderJobs,
  eventReminders,
  events,
  userSettings,
  workerCursors,
} from "@orbit/db";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import pg from "pg";

/**
 * 予定のリマインダーの控え (event_occurrences と event_reminder_jobs) を作り直す (段取り 9、設計 5.3)。
 * - changes (entity が event / calendar) を追い、変わった予定の原本を 1 つの単位として作り直す。
 *   予定を書く箇所 (API・取り込み・書き戻し・iMIP) を直さずに済み、作り直しは何度やっても同じ結果になる。
 * - 1 時間ごとに、繰り返しの回を今日 + 35 日まで展開し直し、古い回と job を消す
 *   (カレンダーを小分けにし、間に変更の処理を挟む)。
 * - 原本 1 件の計算の失敗はその原本だけを飛ばし、利用者 1 人の失敗はその利用者だけを後でやり直す。
 * - calendars.expandedUntil が null のカレンダー (マイグレーション直後・新しいカレンダー) は全部を作る。
 * job の changeSeq は、鳴らす時刻が変わったときだけ、その変更の seq にする (端末の coverSeq と比べる)。
 */

type EventRow = typeof events.$inferSelect;
type CalendarRow = typeof calendars.$inferSelect;

type ReminderIndexerOptions = {
  now?: () => number;
  log?: (message: string) => void;
  /** 作り直しが済んだ (送る job が増えたかもしれない) ときに呼ぶ。Dispatcher を起こす。 */
  onIndexed?: () => void;
};

/** 1 回のトランザクションで作り直す原本の数。 */
const MASTER_CHUNK = 100;
/** changes を 1 回に読む行数。 */
const CHANGE_BATCH = 1000;
/** 同じ変更を作り直せなかったときに、読み直す回数の上限 (超えたら飛ばす)。 */
const MAX_CHANGE_ATTEMPTS = 3;
/** 繰り上げで、列を譲るまでに作り直すカレンダーの数。 */
const ROLL_CALENDAR_CHUNK = 10;
/** 繰り上げと掃除の間隔。 */
const ROLL_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** 繰り返さない予定の job を、どれだけ先でも作るための上限 (9999-12-31)。 */
const FAR_FUTURE_MS = Date.UTC(9999, 11, 31);
const FAR_FUTURE_DATE = "9999-12-31";

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 繰り返しの回を展開しておく範囲の終わり (この日の 0:00 UTC より前に始まる回まで)。 */
export function occurrenceWindowEnd(now: number): string {
  return utcDate(now + SERVER_OCCURRENCE_WINDOW_DAYS * DAY_MS);
}

/** event_occurrences の 1 行分 (作り直しの結果)。 */
export type ComputedOccurrence = {
  recurrenceId: string | null;
  eventId: string;
  allDay: boolean;
  startAt: Date | null;
  endAt: Date | null;
  startDate: string | null;
  endDate: string | null;
};

const iso = (value: Date | string) =>
  typeof value === "string" ? value : value.toISOString();

function timingOf(row: EventRow): EventTiming | null {
  if (row.allDay) {
    if (!row.startDate) return null;
    const endDate =
      row.endDate && row.endDate > row.startDate
        ? row.endDate
        : utcDate(Date.parse(`${row.startDate}T00:00:00Z`) + DAY_MS);
    return { allDay: true, startDate: row.startDate, endDate };
  }
  if (!row.startAt) return null;
  const startAt = iso(row.startAt);
  return {
    allDay: false,
    startAt,
    endAt: row.endAt ? iso(row.endAt) : startAt,
    startTimeZone: row.startTimeZone,
  };
}

const isRecurring = (row: EventRow) =>
  !!row.rrule || (row.rdates?.length ?? 0) > 0;

/**
 * 原本と例外から、控えに入れる回を求める (設計 5.2)。
 * - 繰り返さない予定 (親の無い例外を含む): 終了が「今 − 1 日」より後なら、どれだけ先でも 1 行。
 * - 繰り返す予定: 終了が「今 − 1 日」より後で、開始が windowEnd より前の回。
 * 取り消した原本と回は入れない。
 */
export function computeOccurrences(
  master: EventRow,
  children: readonly EventRow[],
  options: { defaultTimeZone: string; now: number; windowEnd: string },
): ComputedOccurrence[] {
  if (master.status === "cancelled") return [];
  const timing = timingOf(master);
  if (!timing) return [];
  const recurring = isRecurring(master);
  const exceptions: RecurrenceException<EventRow>[] = [];
  for (const child of children) {
    const childTiming = timingOf(child);
    if (!childTiming || !child.recurrenceId) continue;
    exceptions.push({
      ...childTiming,
      key: child,
      recurrenceId: child.recurrenceId,
      cancelled: child.status === "cancelled",
    });
  }
  const keepAfter = options.now - SERVER_OCCURRENCE_KEEP_MS;
  const occurrences = expandOccurrences<EventRow>(
    {
      ...timing,
      rrule: master.rrule,
      rdates: master.rdates ?? null,
      exdates: master.exdates ?? null,
    },
    exceptions,
    {
      from: utcDate(keepAfter - DAY_MS),
      to: recurring
        ? utcDate(Date.parse(`${options.windowEnd}T00:00:00Z`) + DAY_MS)
        : FAR_FUTURE_DATE,
      timeZone: "UTC",
    },
    { defaultTimeZone: options.defaultTimeZone },
  );
  const windowEndMs = Date.parse(`${options.windowEnd}T00:00:00Z`);
  const result: ComputedOccurrence[] = [];
  for (const occurrence of occurrences) {
    const eventId = (occurrence.exception ?? master).id;
    if (occurrence.allDay) {
      if (Date.parse(`${occurrence.endDate}T00:00:00Z`) <= keepAfter) continue;
      if (recurring && occurrence.startDate >= options.windowEnd) continue;
      result.push({
        recurrenceId: occurrence.recurrenceId,
        eventId,
        allDay: true,
        startAt: null,
        endAt: null,
        startDate: occurrence.startDate,
        endDate: occurrence.endDate,
      });
    } else {
      const startMs = Date.parse(occurrence.startAt);
      const endMs = Math.max(Date.parse(occurrence.endAt), startMs);
      if (endMs <= keepAfter) continue;
      if (recurring && startMs >= windowEndMs) continue;
      result.push({
        recurrenceId: occurrence.recurrenceId,
        eventId,
        allDay: false,
        startAt: new Date(startMs),
        endAt: new Date(endMs),
        startDate: null,
        endDate: null,
      });
    }
  }
  return result;
}

/** 計算に使う利用者ごとの値 (設定とカレンダー)。 */
type UserContext = {
  settings: ReminderSettings;
  calendars: Map<string, CalendarRow>;
};

type RebuildOptions = {
  /**
   * 鳴らす時刻が先へ動いても、送信済みの印を保つ (利用者の設定の変更。タイムゾーンを変えて
   * 同じリマインダーがもう一度鳴らないように。L4)。
   */
  keepSent?: boolean;
};

const occurrenceKey = (masterId: string, recurrenceId: string | null) =>
  `${masterId}\u0000${recurrenceId ?? ""}`;

function sameTime(a: Date | null, b: Date | null) {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

export function reminderCalendarOf(row: CalendarRow): ReminderCalendar {
  return {
    id: row.id,
    notify: calendarNotifies(row),
    visible: row.visible,
    defaultReminders: row.defaultReminders ?? null,
    timeZone: row.timeZone,
  };
}

export function calendarFingerprint(row: CalendarRow): string {
  return calendarRemindersFingerprint(reminderCalendarOf(row));
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** 繰り返す原本か (SQL)。 */
const recurringSql = or(
  isNotNull(events.rrule),
  sql`jsonb_array_length(coalesce(${events.rdates}, '[]'::jsonb)) > 0`,
);

/** 控えに入れる原本か (繰り返すか、終了が keepAfter より後。SQL)。 */
function currentSql(keepAfter: number) {
  const at = new Date(keepAfter).toISOString();
  return or(
    recurringSql,
    sql`coalesce(${events.endAt}, ${events.startAt}) > ${at}::timestamptz`,
    sql`coalesce(${events.endDate}, ${events.startDate}) >= ${at.slice(0, 10)}::date`,
  );
}

type ChangeRow = {
  seq: bigint;
  userId: string;
  entity: string;
  entityId: string;
  op: string;
};

export class ReminderIndexer {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private listener: pg.Client | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private rollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** 読み直しの基準 (この seq より後を読む)。重ね読みのため、2 分前に読み終えていた位置。 */
  private base: bigint | null = null;
  private history: { at: number; seq: bigint }[] = [];
  /** base より後で処理済みの seq。 */
  private processed = new Set<bigint>();
  /** 作り直せなかった変更の seq と失敗の回数 (base はこれより先へ進めない)。 */
  private failures = new Map<bigint, number>();
  /** 設定の変更で作り直しを待っている利用者 (同じ利用者の NOTIFY は 1 つにまとめる)。 */
  private pendingUsers = new Set<string>();
  /** 繰り上げが列に入っているか、走っている途中か。 */
  private rolling = false;
  /** この回の繰り上げで失敗したカレンダー (同じ回では飛ばす)。 */
  private rollSkip = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly connectionString: string | null,
    private readonly options: ReminderIndexerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /**
   * 待ち受けと定期の処理を始める。最初の埋め込み (繰り上げ) は裏で動かす。
   * 先に changes の位置を取っておき、埋め込みの間の変更は後の processChanges で読む (M7)。
   */
  start() {
    void this.enqueue(() => this.loadBase());
    this.scheduleRoll();
    void this.enqueue(() => this.processChanges());
    this.pollTimer = setInterval(
      () => void this.enqueue(() => this.processChanges()),
      REMINDER_INDEXER_POLL_MS,
    );
    this.rollTimer = setInterval(() => this.scheduleRoll(), ROLL_INTERVAL_MS);
    this.listen();
  }

  async stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.rollTimer) clearInterval(this.rollTimer);
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => {});
    await this.queue.catch(() => {});
  }

  /** 処理を 1 つずつ順に走らせる (同じ原本を並べて作り直さない)。 */
  enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
    const next = this.queue.then(async () => {
      if (this.stopped) return undefined;
      try {
        return await task();
      } catch (error) {
        this.log(
          `予定のリマインダーの控えを作り直せませんでした: ${errorText(error)}`,
        );
        return undefined;
      }
    });
    this.queue = next;
    return next;
  }

  /** 設定の変更による作り直しを積む。同じ利用者の待ちがあれば相乗りする (M8)。 */
  requestUserRebuild(userId: string) {
    if (this.pendingUsers.has(userId)) return;
    this.pendingUsers.add(userId);
    void this.enqueue(async () => {
      this.pendingUsers.delete(userId);
      return this.rebuildUser(userId);
    });
  }

  /**
   * 繰り上げを積む。カレンダーを小分けにして 1 つずつ列に積み直し、間に入った変更の処理を
   * 先に走らせる (繰り上げで列を長く塞がない。M8)。
   */
  scheduleRoll() {
    if (this.rolling || this.stopped) return;
    this.rolling = true;
    const step = () =>
      void this.enqueue(async () => {
        let more = false;
        try {
          more = await this.rollStep();
        } finally {
          if (more && !this.stopped) step();
          else this.rolling = false;
        }
      });
    step();
  }

  private listen() {
    if (this.stopped || !this.connectionString) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    const retry = () => {
      if (this.listener !== client) return;
      this.listener = null;
      client.end().catch(() => {});
      setTimeout(() => this.listen(), 3_000);
    };
    this.listener = client;
    let pending = false;
    client.on("notification", (message) => {
      if (message.channel === CHANNEL_CALENDAR_NOTIFICATION_SETTINGS) {
        const userId = parseSettingsNotification(message.payload);
        if (userId) this.requestUserRebuild(userId);
        return;
      }
      // 変更のたびに積まず、待ちが 1 つあれば相乗りする。
      if (pending) return;
      pending = true;
      void this.enqueue(async () => {
        pending = false;
        return this.processChanges();
      });
    });
    client.on("error", retry);
    client.on("end", retry);
    client
      .connect()
      .then(() => client.query(`LISTEN ${CHANNEL_CHANGES}`))
      .then(() =>
        client.query(`LISTEN ${CHANNEL_CALENDAR_NOTIFICATION_SETTINGS}`),
      )
      .then(() => void this.enqueue(() => this.processChanges()))
      .catch(retry);
  }

  // -------------------------------------------------------------------------
  // changes を追う
  // -------------------------------------------------------------------------

  private async loadBase(): Promise<bigint> {
    if (this.base !== null) return this.base;
    const [row] = await this.db
      .select({ seq: workerCursors.seq })
      .from(workerCursors)
      .where(eq(workerCursors.name, REMINDER_INDEXER_CURSOR));
    if (row) {
      this.base = row.seq;
    } else {
      // 初めて: いまの位置から追う。それまでの予定は繰り上げ (expandedUntil が null) が埋める。
      const [max] = await this.db
        .select({ seq: sql<string>`coalesce(max(${changes.seq}), 0)` })
        .from(changes);
      this.base = BigInt(max?.seq ?? 0);
      await this.saveBase(this.base);
    }
    return this.base;
  }

  private async saveBase(seq: bigint) {
    await this.db
      .insert(workerCursors)
      .values({ name: REMINDER_INDEXER_CURSOR, seq })
      .onConflictDoUpdate({
        target: workerCursors.name,
        set: { seq, updatedAt: new Date() },
      });
  }

  /**
   * base より後の changes (event / calendar) を読み、作り直す。seq はコミットの順と前後し得るので、
   * base は「2 分前に読み終えていた位置」にして重ねて読み、処理済みの seq は飛ばす。
   * 作り直しは利用者ごとに切り離し、失敗した利用者の変更は次の回に読み直す (MAX_CHANGE_ATTEMPTS 回
   * まで。base はその seq より先へ進めない)。返すのは処理した変更の数。
   */
  async processChanges(): Promise<number> {
    const base = await this.loadBase();
    let after = base;
    let count = 0;
    let maxSeen = this.history.at(-1)?.seq ?? base;
    for (;;) {
      const rows = await this.db
        .select({
          seq: changes.seq,
          userId: changes.userId,
          entity: changes.entity,
          entityId: changes.entityId,
          op: changes.op,
        })
        .from(changes)
        .where(
          and(
            gt(changes.seq, after),
            inArray(changes.entity, ["event", "calendar"]),
          ),
        )
        .orderBy(changes.seq)
        .limit(CHANGE_BATCH);
      if (rows.length === 0) break;
      after = rows.at(-1)?.seq ?? after;
      const fresh = rows.filter((row) => !this.processed.has(row.seq));
      if (fresh.length > 0) {
        const failed = await this.handle(fresh);
        for (const row of fresh) {
          if (!failed.has(row.seq)) {
            this.processed.add(row.seq);
            this.failures.delete(row.seq);
            continue;
          }
          const attempts = (this.failures.get(row.seq) ?? 0) + 1;
          if (attempts >= MAX_CHANGE_ATTEMPTS) {
            // 何度やっても作り直せない変更は飛ばす (次にその予定が変わるか、繰り上げで直る)。
            this.failures.delete(row.seq);
            this.processed.add(row.seq);
          } else {
            this.failures.set(row.seq, attempts);
          }
        }
        count += fresh.length - failed.size;
      }
      if (after > maxSeen) maxSeen = after;
      if (rows.length < CHANGE_BATCH) break;
    }
    const now = this.now();
    this.history.push({ at: now, seq: maxSeen });
    // 2 分より前に読み終えていた位置まで base を進める。失敗した変更の手前より先へは進めない。
    let nextBase = base;
    while (
      this.history.length > 1 &&
      (this.history[0] as { at: number }).at <=
        now - REMINDER_INDEXER_OVERLAP_MS
    ) {
      nextBase = (this.history.shift() as { seq: bigint }).seq;
    }
    for (const seq of this.failures.keys()) {
      if (seq - 1n < nextBase) nextBase = seq - 1n;
    }
    if (nextBase > base) {
      this.base = nextBase;
      for (const seq of this.processed) {
        if (seq <= nextBase) this.processed.delete(seq);
      }
      await this.saveBase(nextBase);
    }
    if (count > 0) this.options.onIndexed?.();
    return count;
  }

  /** 利用者ごとに作り直す。返すのは作り直せなかった利用者の変更の seq。 */
  private async handle(rows: ChangeRow[]): Promise<Set<bigint>> {
    const byUser = new Map<
      string,
      {
        events: Set<string>;
        calendars: Set<string>;
        seq: bigint;
        rows: ChangeRow[];
      }
    >();
    for (const row of rows) {
      const entry = byUser.get(row.userId) ?? {
        events: new Set<string>(),
        calendars: new Set<string>(),
        seq: 0n,
        rows: [],
      };
      if (row.entity === "event") entry.events.add(row.entityId);
      else if (row.op !== "delete") entry.calendars.add(row.entityId);
      if (row.seq > entry.seq) entry.seq = row.seq;
      entry.rows.push(row);
      byUser.set(row.userId, entry);
    }
    const failed = new Set<bigint>();
    for (const [userId, entry] of byUser) {
      if (this.stopped) {
        for (const row of entry.rows) failed.add(row.seq);
        continue;
      }
      try {
        await this.handleUser(userId, entry);
      } catch (error) {
        this.log(
          `利用者 ${userId} の予定のリマインダーの控えを作り直せませんでした: ${errorText(error)}`,
        );
        for (const row of entry.rows) failed.add(row.seq);
      }
    }
    return failed;
  }

  private async handleUser(
    userId: string,
    entry: { events: Set<string>; calendars: Set<string>; seq: bigint },
  ) {
    const masters = new Set<string>();
    const ids = [...entry.events];
    const found = new Set<string>();
    for (const batch of chunks(ids)) {
      for (const row of await this.db
        .select({ id: events.id, parentId: events.parentId })
        .from(events)
        .where(inArray(events.id, batch))) {
        found.add(row.id);
        masters.add(row.parentId ?? row.id);
      }
    }
    if (ids.some((id) => !found.has(id))) {
      // 消えた予定。原本なら回も job も FK の cascade で消えている。例外なら、その回の行の
      // eventId が null になって残るので、その原本だけを作り直す (M8)。
      for (const id of await this.orphanedMasters(userId)) masters.add(id);
    }
    const hashes: { id: string; hash: string }[] = [];
    if (entry.calendars.size > 0) {
      const rows = await this.db
        .select()
        .from(calendars)
        .where(
          and(
            eq(calendars.userId, userId),
            inArray(calendars.id, [...entry.calendars]),
          ),
        );
      for (const calendar of rows) {
        const hash = calendarFingerprint(calendar);
        if (hash === calendar.remindersHash) continue;
        hashes.push({ id: calendar.id, hash });
        for (const id of await this.calendarMasters(calendar.id, false)) {
          masters.add(id);
        }
      }
    }
    await this.rebuildMasters(userId, [...masters], entry.seq);
    for (const { id, hash } of hashes) {
      await this.db
        .update(calendars)
        .set({ remindersHash: hash })
        .where(eq(calendars.id, id));
    }
  }

  /** 例外の行が消えて、中身の予定を失った回を持つ原本。 */
  private async orphanedMasters(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: eventOccurrences.masterId })
      .from(eventOccurrences)
      .where(
        and(
          eq(eventOccurrences.userId, userId),
          isNull(eventOccurrences.eventId),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * カレンダーの原本。recurringOnly なら繰り返すものだけ、そうでなければ繰り返すものと
   * 終了が「今 − 1 日」より後のもの (終わった予定は控えに入れないので読まない。M8)。
   */
  private async calendarMasters(
    calendarId: string,
    recurringOnly: boolean,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendarId),
          isNull(events.parentId),
          recurringOnly
            ? recurringSql
            : currentSql(this.now() - SERVER_OCCURRENCE_KEEP_MS),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * 利用者の予定の changes の位置 (繰り上げ・設定の変更で作る job の changeSeq)。端末の coverSeq
   * (GET /v1/calendars/sync の latestSeq) と同じく、予定とカレンダーの変更だけを数える (M2)。
   */
  private async currentSeq(userId: string): Promise<bigint> {
    const [row] = await this.db
      .select({ seq: sql<string>`coalesce(max(${changes.seq}), 0)` })
      .from(changes)
      .where(
        and(
          eq(changes.userId, userId),
          inArray(changes.entity, ["event", "calendar"]),
        ),
      );
    return BigInt(row?.seq ?? 0);
  }

  /**
   * 利用者の設定 (タイムゾーン、終日の通知) が変わった: 設定で鳴る時刻が変わる予定
   * (終日と浮動時刻) だけを作り直す。送信済みの印は保つ (L4)。
   */
  async rebuildUser(userId: string): Promise<void> {
    const rows = await this.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          isNull(events.parentId),
          or(eq(events.allDay, true), isNull(events.startTimeZone)),
          currentSql(this.now() - SERVER_OCCURRENCE_KEEP_MS),
        ),
      );
    await this.rebuildMasters(
      userId,
      rows.map((row) => row.id),
      await this.currentSeq(userId),
      { keepSent: true },
    );
    this.options.onIndexed?.();
  }

  // -------------------------------------------------------------------------
  // 繰り上げと掃除
  // -------------------------------------------------------------------------

  /**
   * 繰り上げを最後まで行う (起動時と 1 時間ごとは scheduleRoll で小分けにする)。
   * expandedUntil が今日 + 35 日より前のカレンダーの繰り返す原本を作り直して expandedUntil を
   * 進める。null のカレンダーは全部の原本を作る (最初の埋め込み)。終わった回と、古い job を消す。
   */
  async roll(): Promise<void> {
    while (!this.stopped && (await this.rollStep())) {
      // 次の小分けへ。
    }
  }

  /** 繰り上げの 1 回分 (ROLL_CALENDAR_CHUNK 個のカレンダー)。まだ残っていれば true。 */
  async rollStep(): Promise<boolean> {
    const now = this.now();
    const windowEnd = occurrenceWindowEnd(now);
    const skip = [...this.rollSkip];
    const due = await this.db
      .select()
      .from(calendars)
      .where(
        and(
          or(
            isNull(calendars.expandedUntil),
            lt(calendars.expandedUntil, windowEnd),
          ),
          skip.length > 0 ? notInArray(calendars.id, skip) : undefined,
        ),
      )
      .orderBy(calendars.id)
      .limit(ROLL_CALENDAR_CHUNK);
    for (const calendar of due) {
      if (this.stopped) return false;
      try {
        const masters = await this.calendarMasters(
          calendar.id,
          calendar.expandedUntil !== null,
        );
        await this.rebuildMasters(
          calendar.userId,
          masters,
          await this.currentSeq(calendar.userId),
        );
        await this.db
          .update(calendars)
          .set({
            expandedUntil: windowEnd,
            ...(calendar.remindersHash === null
              ? { remindersHash: calendarFingerprint(calendar) }
              : {}),
          })
          .where(eq(calendars.id, calendar.id));
      } catch (error) {
        // 1 つのカレンダーの失敗で、ほかのカレンダーの繰り上げを止めない (M1)。
        this.rollSkip.add(calendar.id);
        this.log(
          `カレンダー ${calendar.id} の繰り返しの回を展開できませんでした: ${errorText(error)}`,
        );
      }
    }
    if (due.length > 0) this.options.onIndexed?.();
    if (due.length === ROLL_CALENDAR_CHUNK) return true;
    this.rollSkip.clear();
    const keepAfter = new Date(now - SERVER_OCCURRENCE_KEEP_MS);
    await this.db
      .delete(eventOccurrences)
      .where(
        or(
          and(
            eq(eventOccurrences.allDay, false),
            lt(eventOccurrences.endAt, keepAfter),
          ),
          and(
            eq(eventOccurrences.allDay, true),
            lt(eventOccurrences.endDate, utcDate(keepAfter.getTime())),
          ),
        ),
      );
    // 送信済みか遅れた job (鳴らす時刻から 1 日たったもの)。
    await this.db
      .delete(eventReminderJobs)
      .where(lt(eventReminderJobs.fireAt, new Date(now - DAY_MS)));
    return false;
  }

  // -------------------------------------------------------------------------
  // 作り直し
  // -------------------------------------------------------------------------

  private async userContext(userId: string): Promise<UserContext> {
    const [settingsRow] = await this.db
      .select({
        timeZone: userSettings.timeZone,
        calendarNotifications: userSettings.calendarNotifications,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    const settings = readCalendarNotificationSettings(
      settingsRow?.calendarNotifications,
    );
    const rows = await this.db
      .select()
      .from(calendars)
      .where(eq(calendars.userId, userId));
    return {
      settings: {
        timeZone: settingsRow?.timeZone ?? DEFAULT_REMINDER_TIME_ZONE,
        allDay: settings.allDay,
      },
      calendars: new Map(rows.map((row) => [row.id, row])),
    };
  }

  /**
   * 原本ごとに回と job を作り直す。消えた原本の回は消す。seq は、鳴らす時刻が変わった job と
   * 新しい job の changeSeq にする。まとまりのトランザクションが失敗したら 1 件ずつやり直し、
   * それでも失敗した原本があれば最後に投げる (呼び出し側が後でやり直す)。
   */
  async rebuildMasters(
    userId: string,
    masterIds: readonly string[],
    seq: bigint,
    options: RebuildOptions = {},
  ): Promise<void> {
    if (masterIds.length === 0) return;
    const context = await this.userContext(userId);
    const run = (batch: string[]) =>
      this.db.transaction((tx) =>
        rebuildChunk(tx, userId, batch, seq, context, this.now(), {
          ...options,
          log: this.log,
        }),
      );
    let failed = 0;
    let lastError: unknown = null;
    for (const batch of chunks([...new Set(masterIds)], MASTER_CHUNK)) {
      if (this.stopped) return;
      try {
        await run(batch);
      } catch (error) {
        if (batch.length === 1) {
          failed += 1;
          lastError = error;
          continue;
        }
        for (const id of batch) {
          try {
            await run([id]);
          } catch (single) {
            failed += 1;
            lastError = single;
            this.log(
              `予定 ${id} のリマインダーの控えを作り直せませんでした: ${errorText(single)}`,
            );
          }
        }
      }
    }
    if (failed > 0) {
      throw new Error(
        `${failed} 件の予定を作り直せませんでした (${errorText(lastError)})`,
      );
    }
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Computed = {
  master: EventRow;
  occurrences: ComputedOccurrence[];
  planned: PlannedReminder[];
};

async function rebuildChunk(
  tx: Tx,
  userId: string,
  masterIds: string[],
  seq: bigint,
  context: UserContext,
  now: number,
  options: RebuildOptions & { log: (message: string) => void },
) {
  // 複数台の worker が同じ利用者を同時に作り直さないように (一意の索引の衝突を防ぐ。L8)。
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`reminder-indexer:${userId}`}))`,
  );
  const windowEnd = occurrenceWindowEnd(now);
  const windowEndMs = Date.parse(`${windowEnd}T00:00:00Z`);
  const rows = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        or(inArray(events.id, masterIds), inArray(events.parentId, masterIds)),
      ),
    );
  const ids = rows.map((row) => row.id);
  const responses = new Map<string, string>();
  const reminders = new Map<string, { method: string; minutes: number }[]>();
  if (ids.length > 0) {
    for (const batch of chunks(ids)) {
      for (const row of await tx
        .select({
          eventId: eventAttendees.eventId,
          status: eventAttendees.status,
        })
        .from(eventAttendees)
        .where(
          and(
            inArray(eventAttendees.eventId, batch),
            eq(eventAttendees.self, true),
          ),
        )) {
        responses.set(row.eventId, row.status);
      }
      for (const row of await tx
        .select({
          eventId: eventReminders.eventId,
          method: eventReminders.method,
          minutes: eventReminders.minutes,
        })
        .from(eventReminders)
        .where(inArray(eventReminders.eventId, batch))) {
        const list = reminders.get(row.eventId) ?? [];
        list.push({ method: row.method, minutes: row.minutes });
        reminders.set(row.eventId, list);
      }
    }
  }
  const masterSet = new Set(masterIds);
  const masters = new Map<string, EventRow>();
  const children = new Map<string, EventRow[]>();
  for (const row of rows) {
    if (row.parentId && masterSet.has(row.parentId)) {
      const list = children.get(row.parentId) ?? [];
      list.push(row);
      children.set(row.parentId, list);
    } else if (masterSet.has(row.id)) {
      masters.set(row.id, row);
    }
  }

  // いまの回と job。
  const existing = await tx
    .select()
    .from(eventOccurrences)
    .where(inArray(eventOccurrences.masterId, masterIds));
  const existingByKey = new Map(
    existing.map((row) => [occurrenceKey(row.masterId, row.recurrenceId), row]),
  );
  const existingJobs: (typeof eventReminderJobs.$inferSelect)[] = [];
  for (const batch of chunks(existing.map((row) => row.id))) {
    existingJobs.push(
      ...(await tx
        .select()
        .from(eventReminderJobs)
        .where(inArray(eventReminderJobs.occurrenceId, batch))),
    );
  }
  const jobsByKey = new Map(
    existingJobs.map((job) => [`${job.occurrenceId}\u0000${job.minutes}`, job]),
  );
  // 回のキーが変わる (繰り返すかどうかを変えた) ときに、同じ時刻の送信済みを引き継ぐ (L4)。
  const masterOfOccurrence = new Map(
    existing.map((row) => [row.id, row.masterId]),
  );
  const sentBefore = new Map<string, Date>();
  for (const job of existingJobs) {
    if (!job.sentAt) continue;
    const masterId = masterOfOccurrence.get(job.occurrenceId);
    sentBefore.set(
      `${masterId}\u0000${job.minutes}\u0000${job.fireAt.getTime()}`,
      job.sentAt,
    );
  }

  const toReminderEvent = (row: EventRow): ReminderEvent => ({
    id: row.id,
    calendarId: row.calendarId,
    parentId: row.parentId,
    recurrenceId: row.recurrenceId,
    status: row.status,
    allDay: row.allDay,
    startAt: row.startAt,
    endAt: row.endAt,
    startDate: row.startDate,
    endDate: row.endDate,
    startTimeZone: row.startTimeZone,
    rrule: row.rrule,
    rdates: row.rdates,
    exdates: row.exdates,
    useDefaultReminders: row.useDefaultReminders,
    reminders: reminders.get(row.id) ?? [],
    myResponse: responses.get(row.id) ?? null,
  });

  // 1. 原本ごとに計算する。投げた原本は飛ばし、その回と job は消す (M1)。
  const computed: Computed[] = [];
  for (const master of masters.values()) {
    const calendar = context.calendars.get(master.calendarId);
    if (!calendar) continue;
    const kids = children.get(master.id) ?? [];
    try {
      const occurrences = computeOccurrences(master, kids, {
        defaultTimeZone: calendar.timeZone ?? context.settings.timeZone,
        now,
        windowEnd,
      });
      const planned = planReminders({
        calendars: [reminderCalendarOf(calendar)],
        events: [master, ...kids].map(toReminderEvent),
        settings: context.settings,
        from: now - REMINDER_LATE_LIMIT_MS,
        to: isRecurring(master) ? windowEndMs : FAR_FUTURE_MS,
      });
      computed.push({ master, occurrences, planned });
    } catch (error) {
      options.log(
        `予定 ${master.id} のリマインダーを計算できませんでした (飛ばします): ${errorText(error)}`,
      );
    }
  }

  // 2. 回を突き合わせる。新しい回はまとめて入れる。
  const keepOccurrences = new Set<string>();
  const occurrenceIds = new Map<string, string>();
  const newOccurrences: (typeof eventOccurrences.$inferInsert)[] = [];
  for (const { master, occurrences } of computed) {
    for (const occurrence of occurrences) {
      const key = occurrenceKey(master.id, occurrence.recurrenceId);
      const current = existingByKey.get(key);
      const values = {
        eventId: occurrence.eventId,
        allDay: occurrence.allDay,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
        startDate: occurrence.startDate,
        endDate: occurrence.endDate,
      };
      if (!current) {
        newOccurrences.push({
          ...values,
          userId,
          calendarId: master.calendarId,
          masterId: master.id,
          recurrenceId: occurrence.recurrenceId,
        });
        continue;
      }
      if (
        current.eventId !== values.eventId ||
        current.allDay !== values.allDay ||
        current.calendarId !== master.calendarId ||
        !sameTime(current.startAt, values.startAt) ||
        !sameTime(current.endAt, values.endAt) ||
        current.startDate !== values.startDate ||
        current.endDate !== values.endDate
      ) {
        await tx
          .update(eventOccurrences)
          .set({ ...values, calendarId: master.calendarId })
          .where(eq(eventOccurrences.id, current.id));
      }
      keepOccurrences.add(current.id);
      occurrenceIds.set(key, current.id);
    }
  }
  for (const batch of chunks(newOccurrences)) {
    for (const row of await tx
      .insert(eventOccurrences)
      .values(batch)
      .returning({
        id: eventOccurrences.id,
        masterId: eventOccurrences.masterId,
        recurrenceId: eventOccurrences.recurrenceId,
      })) {
      occurrenceIds.set(occurrenceKey(row.masterId, row.recurrenceId), row.id);
    }
  }

  // 3. job を突き合わせる。新しい job はまとめて入れる。
  const keepJobs = new Set<string>();
  const newJobs: (typeof eventReminderJobs.$inferInsert)[] = [];
  for (const { master, planned } of computed) {
    for (const item of planned) {
      const occurrenceId = occurrenceIds.get(
        occurrenceKey(master.id, item.recurrenceId),
      );
      if (!occurrenceId) continue;
      const job = jobsByKey.get(`${occurrenceId}\u0000${item.minutes}`);
      const fireAt = new Date(item.fireAt);
      if (!job) {
        newJobs.push({
          userId,
          occurrenceId,
          minutes: item.minutes,
          fireAt,
          changeSeq: seq,
          sentAt:
            sentBefore.get(
              `${master.id}\u0000${item.minutes}\u0000${item.fireAt}`,
            ) ?? null,
        });
        continue;
      }
      keepJobs.add(job.id);
      if (job.fireAt.getTime() === item.fireAt) continue;
      // 先へ動いたら送り直す (設定の変更では送信済みを保つ)。前へ動いたときは、送ったものはそのまま。
      const resend = item.fireAt > job.fireAt.getTime() && !options.keepSent;
      await tx
        .update(eventReminderJobs)
        .set({
          fireAt,
          changeSeq: seq,
          ...(resend ? { sentAt: null, claimedAt: null, attempts: 0 } : {}),
        })
        .where(eq(eventReminderJobs.id, job.id));
    }
  }
  for (const batch of chunks(newJobs)) {
    await tx.insert(eventReminderJobs).values(batch).onConflictDoNothing();
  }

  // 4. 要らなくなった job と回を消す。
  const staleJobs = existingJobs
    .filter((job) => !keepJobs.has(job.id))
    .map((job) => job.id);
  for (const batch of chunks(staleJobs)) {
    await tx
      .delete(eventReminderJobs)
      .where(inArray(eventReminderJobs.id, batch));
  }
  const staleOccurrences = existing
    .filter((row) => !keepOccurrences.has(row.id))
    .map((row) => row.id);
  for (const batch of chunks(staleOccurrences)) {
    await tx
      .delete(eventOccurrences)
      .where(inArray(eventOccurrences.id, batch));
  }
}

function chunks<T>(values: readonly T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

function parseSettingsNotification(payload: string | undefined): string | null {
  try {
    const value = JSON.parse(
      payload ?? "",
    ) as CalendarNotificationSettingsNotification;
    return typeof value?.userId === "string" ? value.userId : null;
  } catch {
    return null;
  }
}
