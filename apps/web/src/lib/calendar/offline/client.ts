import { inviteRole } from "@orbit/core/event-invite";
import { normalizeRecurrenceId } from "@orbit/core/recurrence";
import { ApiError, NetworkError } from "@/lib/api";
import type * as calendarApi from "@/lib/calendar/api";
import type {
  AttendeeStatus,
  Calendar,
  CalendarConflict,
  CalendarEvent,
  CalendarSyncPage,
  EventFields,
  EventRange,
  InviteFailure,
} from "@/lib/calendar/api";
import { expandRange } from "@/lib/calendar/offline/expand";
import {
  applyOpToEvents,
  type CalendarView,
  eventFieldsOf,
  eventFromInput,
  overlay,
  provisionalException,
  provisionalExceptionId,
} from "@/lib/calendar/offline/overlay";
import {
  bySeq,
  enqueueOp,
  nextSendable,
  nextSeq,
  type OpOutcome,
  type QueueApi,
  remainderOf,
  sendOp,
} from "@/lib/calendar/offline/queue";
import { searchLocal } from "@/lib/calendar/offline/search";
import type { Share } from "@/lib/calendar/offline/share";
import {
  type CalendarMeta,
  compareSeq,
  deleteCalendar,
  deleteEvent,
  deleteNotice,
  deleteOp,
  emptyMeta,
  loadMeta,
  loadSnapshot,
  metaWrites,
  putCalendar,
  putEvent,
  putNotice,
  putOp,
} from "@/lib/calendar/offline/store";
import { pullChanges } from "@/lib/calendar/offline/sync";
import type {
  CalendarChanges,
  CalendarClient,
  ConflictAction,
  ConflictItem,
  ConflictKind,
  CreateEventInput,
  EventRangeQuery,
  QueuedOp,
} from "@/lib/calendar/offline/types";
import type { LocalStore, WriteOp } from "@/lib/offline/store";
import { randomUuid } from "@/lib/uuid";

/**
 * カレンダーの端末の保存と同期 (1 章の CalendarClient)。
 *
 * - base: サーバーの内容の控え (calendars, events)。/sync と送信の応答で更新する。
 * - queue: 送信待ちの操作。seq の順に 1 つずつ送る。
 * - view: base に queue を重ねたもの。range はこれを expandOccurrences で回にする。
 * - share: ほかのウィンドウへ「変わった」と知らせ、送る役を 1 つにする。
 */

/** client が使う API (テストでは偽物を渡す)。 */
export type ClientApi = QueueApi &
  Pick<
    typeof calendarApi,
    | "listCalendars"
    | "listEvents"
    | "searchEvents"
    | "syncCalendars"
    | "listConflicts"
    | "dismissConflict"
    | "retryConflict"
    | "resendInvite"
  >;

export type ClientOptions = {
  userId: string;
  store: LocalStore;
  api: ClientApi;
  share?: Share | null;
  now?: () => Date;
  /** サーバーに届く状態か (届かないと分かっているときの書き込みの扱いに使う)。 */
  isOnline?: () => boolean;
  /** 届かなかったときに、やり直すまでの時間 (回数ごとに倍にする)。 */
  retryMs?: number;
  maxRetryMs?: number;
  /** ほかのウィンドウが送る役を持っているときに、引き継げるか確かめる間隔。 */
  checkMs?: number;
  /**
   * 画面が使っている (subscribe されている) 間だけ動かすきっかけ (SSE の change など)。
   * 戻り値の関数で止める。
   */
  triggers?: (client: OfflineCalendarClient) => () => void;
};

/** 保存先が残らない環境で、サーバーに届かないときに書き込もうとした。 */
export class OfflineUnavailableError extends Error {
  constructor() {
    super("offline_unavailable");
    this.name = "OfflineUnavailableError";
  }
}

const SERVER_ACTIONS: Record<CalendarConflict["kind"], ConflictAction[]> = {
  field_lost: ["restore", "dismiss"],
  write_failed: ["retry", "dismiss"],
  create_failed: ["retry", "delete", "dismiss"],
  remote_deleted: ["restore", "dismiss"],
  delete_cancelled: ["delete", "dismiss"],
  invite_failed: ["resend", "dismiss"],
};

/**
 * サーバーの記録の snapshot は、予定の作成 (POST /events) と同じ項目の形に
 * parentId と recurrenceId を足したもの (offline-api-notes.md)。画面と「復元」で
 * 使えるように、予定の形 (CalendarEvent) に直す。
 */
type ServerSnapshot = EventFields & {
  parentId?: string | null;
  recurrenceId?: string | null;
  organizer?: CalendarEvent["organizer"];
};

export function snapshotEvent(
  conflict: Pick<
    CalendarConflict,
    "eventId" | "calendarId" | "createdAt" | "snapshot"
  >,
): CalendarEvent | null {
  const raw = conflict.snapshot as unknown;
  if (!raw || typeof raw !== "object") return null;
  // 予定全体の形 (古い記録や端末の控え) なら、そのまま使う。
  if ("uid" in raw && "fieldUpdatedAt" in raw) return raw as CalendarEvent;
  const {
    parentId = null,
    recurrenceId = null,
    organizer = null,
    ...fields
  } = raw as ServerSnapshot;
  if (!fields.time) return null;
  const event = eventFromInput(
    {
      ...fields,
      time: fields.time,
      id: conflict.eventId ?? randomUuid(),
      calendarId: conflict.calendarId ?? "",
    },
    conflict.createdAt,
  );
  return {
    ...event,
    // eventFromInput は参加者がいると自分を主催者にするが、記録の主催者は分からない
    // (招待された予定かもしれない)。記録に無ければ null にして、復元で招待を送らない。
    organizer,
    parentId,
    recurrenceId: recurrenceId ? normalizeRecurrenceId(recurrenceId) : null,
  };
}

/** 出欠の返事の書き戻しの失敗 (fields: ["attendees"]、lost: null。invites-api-notes 6 章)。 */
export function isRespondFailure(
  conflict: Pick<CalendarConflict, "kind" | "fields" | "lost">,
): boolean {
  return (
    conflict.kind === "write_failed" &&
    conflict.lost === null &&
    conflict.fields.length === 1 &&
    conflict.fields[0] === "attendees"
  );
}

/** invite_failed の lost (送れなかったメール) を読む。形が違えば null。 */
export function inviteFailureOf(lost: unknown): InviteFailure | null {
  if (!lost || typeof lost !== "object") return null;
  const raw = lost as Record<string, unknown>;
  const method = raw.method;
  return {
    ...(typeof raw.outboxId === "string" ? { outboxId: raw.outboxId } : {}),
    ...(method === "REQUEST" || method === "CANCEL" || method === "REPLY"
      ? { method }
      : {}),
    ...(Array.isArray(raw.to)
      ? {
          to: raw.to.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(raw.partial === true ? { partial: true } : {}),
  };
}

/** 招待メールの送信の失敗 (invite_failed) の項目。lost は項目の値ではないので invite に移す。 */
function inviteConflictItem(conflict: CalendarConflict): ConflictItem {
  const invite = inviteFailureOf(conflict.lost);
  return {
    id: conflict.id,
    source: "server",
    kind: "invite_failed",
    calendarId: conflict.calendarId,
    eventId: conflict.eventId,
    recurrenceId: conflict.recurrenceId ?? null,
    title: conflict.title,
    fields: [],
    lost: null,
    kept: null,
    snapshot: snapshotEvent(conflict),
    reason: conflict.reason,
    createdAt: conflict.createdAt,
    // 一部の宛先だけ送れなかったとき・サーバーが送り直せないとしたときは、送り直さない
    // (届いた人に 2 通目が行く)。resendable の無い記録は lost の印だけで決める。
    actions:
      invite?.partial || conflict.resendable === false
        ? ["dismiss"]
        : ["resend", "dismiss"],
    opId: null,
    invite,
  };
}

function serverConflictItem(conflict: CalendarConflict): ConflictItem {
  if (conflict.kind === "invite_failed") return inviteConflictItem(conflict);
  const snapshot = snapshotEvent(conflict);
  // まだ相手側に無い回の例外の書き戻しが失敗したとき、snapshot が原本と回を持つ。
  // 「もう一度試す」は、その回の変更 (PATCH /events/:parentId/occurrences/:rid) で送る。
  const recurrenceId =
    conflict.recurrenceId ??
    (snapshot?.parentId ? snapshot.recurrenceId : null);
  const eventId =
    conflict.kind === "write_failed" && snapshot?.parentId && recurrenceId
      ? snapshot.parentId
      : conflict.eventId;
  return {
    id: conflict.id,
    source: "server",
    kind: conflict.kind,
    calendarId: conflict.calendarId,
    eventId,
    recurrenceId: recurrenceId ?? null,
    title: conflict.title,
    fields: conflict.fields,
    lost: conflict.lost,
    kept: null,
    snapshot,
    reason: conflict.reason,
    createdAt: conflict.createdAt,
    actions: (SERVER_ACTIONS[conflict.kind] ?? ["dismiss"]).filter(
      (action) =>
        // 出欠の返事の失敗 (lost: null) は「閉じる」だけ。やり直しは詳細の出欠ボタンで行う
        // (「もう一度試す」で参加者の一覧を PATCH しない)。
        (action !== "retry" ||
          conflict.kind !== "write_failed" ||
          !isRespondFailure(conflict)) &&
        (action !== "restore" ||
          // 作り直す元 (予定全体) か、戻す値が無ければ「復元」は何もできない。
          (conflict.kind === "remote_deleted"
            ? snapshot !== null
            : !!conflict.lost)),
    ),
    opId: null,
  };
}

function pick(fields: EventFields, keys: readonly string[]): EventFields {
  const picked: EventFields = {};
  for (const key of keys) {
    if (key in fields) {
      (picked as Record<string, unknown>)[key] = (
        fields as Record<string, unknown>
      )[key];
    }
  }
  return picked;
}

const sortCalendars = (list: Calendar[]) =>
  list
    .map((calendar, index) => ({ calendar, index }))
    .sort(
      (a, b) =>
        (a.calendar.sortOrder ?? Number.POSITIVE_INFINITY) -
          (b.calendar.sortOrder ?? Number.POSITIVE_INFINITY) ||
        a.index - b.index,
    )
    .map((entry) => entry.calendar);

const rangeKey = (range: EventRangeQuery) =>
  `${range.from}|${range.to}|${range.timeZone}`;

export class OfflineCalendarClient implements CalendarClient {
  private readonly store: LocalStore;
  private readonly api: ClientApi;
  private readonly share: Share | null;
  private readonly now: () => Date;
  private readonly isOnline: () => boolean;
  private readonly baseRetryMs: number;

  private baseEvents = new Map<string, CalendarEvent>();
  private baseCalendars = new Map<string, Calendar>();
  private calendarsKnown = false;
  private ops: QueuedOp[] = [];
  private notices: ConflictItem[] = [];
  private meta: CalendarMeta = emptyMeta();

  // 画面に返す値の控え (中身が変わるまで同じものを返す)。
  private viewCache: CalendarView | null = null;
  private calendarList: Calendar[] | null = null;
  private queueList: QueuedOp[] | null = null;
  private conflictList: ConflictItem[] | null = null;
  private readonly rangeCache = new Map<string, EventRange>();
  /** 初回の同期が終わる前に、GET /events で取った期間。 */
  private readonly rangeLoaded = new Set<string>();
  private readonly rangeLoading = new Set<string>();

  private readonly listeners = new Set<() => void>();
  private inFlight: string | null = null;
  private flushing: Promise<void> | null = null;
  private pulling: Promise<void> | null = null;
  private pullAgain = false;
  /**
   * 次の pull を since=0 から取る (段取り 8: 招待の新しい項目を、変わっていない予定にも行き渡らせる)。
   * 1 回のセッションで 1 回だけ。
   */
  private pullFromStart = false;
  private refetchedForInvites = false;
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * 保存先への書き込みを確かめていない送信待ち (null は削除)。書き込みに失敗したら残し、
   * 次の書き込みで一緒に書き直す。保存先から読み直すときも、こちらを優先する。
   */
  private readonly unsavedOps = new Map<string, QueuedOp | null>();
  private storageError = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private delay: number;
  private stopped = false;
  private startedSession = false;
  private stopTriggers: (() => void) | null = null;
  private stopShare: (() => void) | null = null;

  private constructor(private readonly options: ClientOptions) {
    this.store = options.store;
    this.api = options.api;
    this.share = options.share ?? null;
    this.now = options.now ?? (() => new Date());
    this.isOnline = options.isOnline ?? (() => true);
    this.baseRetryMs = options.retryMs ?? 2_000;
    this.delay = this.baseRetryMs;
  }

  /** 保存先を読み込んで client を作る。送信待ちがあれば送り始める。 */
  static async open(options: ClientOptions): Promise<OfflineCalendarClient> {
    const client = new OfflineCalendarClient(options);
    await client.load();
    client.attach();
    return client;
  }

  private async load(): Promise<void> {
    const snapshot = await loadSnapshot(this.store);
    this.meta = snapshot.meta;
    this.baseCalendars = new Map(snapshot.calendars.map((c) => [c.id, c]));
    this.baseEvents = new Map(snapshot.events.map((e) => [e.id, e]));
    this.ops = snapshot.queue.sort(bySeq);
    this.notices = snapshot.notices;
    this.calendarsKnown =
      snapshot.calendars.length > 0 || snapshot.meta.initialSyncDone;
  }

  private attach(): void {
    if (this.share) {
      this.stopShare = this.share.onMessage((message) => {
        void this.reloadFromStore({
          events: message.events,
          calendars: message.calendars,
          queue: message.queue,
          notices: message.notices,
        });
      });
    }
    // 送る役を持っていたウィンドウが閉じたら、ここで引き継ぐ。
    this.checkTimer = setInterval(() => {
      if (nextSendable(this.ops)) void this.flush();
    }, this.options.checkMs ?? 30_000);
    if (this.ops.length > 0) void this.flush();
  }

  // -------------------------------------------------------------------------
  // 読む
  // -------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.activate();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopTriggers?.();
        this.stopTriggers = null;
      }
    };
  }

  /** 画面が使い始めた。カレンダーを取り直し、差分を取る。 */
  private activate(): void {
    if (this.stopped) return;
    this.stopTriggers ??= this.options.triggers?.(this) ?? null;
    this.startSession();
    void this.pull();
  }

  private startSession(): void {
    if (this.startedSession || this.stopped) return;
    this.startedSession = true;
    void this.refreshCalendars();
  }

  /** 画面が使っているか (subscribe されているか)。 */
  get active(): boolean {
    return this.listeners.size > 0;
  }

  /** 再読み込みしても残る保存先か (残らなければ、オフライン中の変更を預からない)。 */
  get persistent(): boolean {
    return this.store.persistent;
  }

  private view(): CalendarView {
    this.viewCache ??= overlay(this.baseEvents, this.baseCalendars, this.ops);
    return this.viewCache;
  }

  calendars(): Calendar[] | null {
    if (!this.calendarsKnown) {
      this.startSession();
      return null;
    }
    this.calendarList ??= sortCalendars([...this.view().calendars.values()]);
    return this.calendarList;
  }

  /**
   * 予定のリマインダーを端末に予約するための、控えの全部 (送信待ちを重ねたもの。段取り 9 の
   * ReminderAgent が読む)。初回の同期が終わるまでは null。cursor は控えの同期位置 (changes.seq)。
   */
  reminderSnapshot(): {
    calendars: Calendar[];
    events: CalendarEvent[];
    cursor: string;
  } | null {
    if (!this.meta.initialSyncDone) return null;
    const view = this.view();
    return {
      calendars: [...view.calendars.values()],
      events: [...view.events.values()],
      cursor: this.meta.cursor,
    };
  }

  range(range: EventRangeQuery): EventRange | null {
    const key = rangeKey(range);
    const cached = this.rangeCache.get(key);
    if (cached) return cached;
    if (!this.meta.initialSyncDone && !this.rangeLoaded.has(key)) {
      // 初回の同期が終わるまでは、表示中の期間だけを先に取る (近い期間から先に配る)。
      this.startSession();
      if (!this.rangeLoading.has(key)) void this.loadRange(range, key);
      return null;
    }
    const result = expandRange(this.view().events.values(), range);
    this.rangeCache.set(key, result);
    return result;
  }

  pendingFor(eventId: string): QueuedOp[] {
    const event = this.view().events.get(eventId);
    const rid =
      event?.recurrenceId != null
        ? normalizeRecurrenceId(event.recurrenceId)
        : null;
    return this.queue().filter(
      (op) =>
        op.eventId === eventId ||
        (event?.parentId != null &&
          op.eventId === event.parentId &&
          op.recurrenceId !== null &&
          normalizeRecurrenceId(op.recurrenceId) === rid),
    );
  }

  queue(): QueuedOp[] {
    this.queueList ??= [...this.ops];
    return this.queueList;
  }

  conflicts(): ConflictItem[] {
    if (!this.conflictList) {
      const events = this.view().events;
      const server = this.meta.serverConflicts.map((item) => {
        const event = item.eventId ? events.get(item.eventId) : undefined;
        return event && item.fields.length > 0
          ? { ...item, kept: eventFieldsOf(event, item.fields) }
          : item;
      });
      this.conflictList = [...server, ...this.notices].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
    }
    return this.conflictList;
  }

  async search(q: string): Promise<CalendarEvent[]> {
    try {
      return await this.api.searchEvents(q);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      return searchLocal(this.view().events.values(), q);
    }
  }

  storageFailed(): boolean {
    return this.storageError;
  }

  // -------------------------------------------------------------------------
  // 書く (すぐ返る。送信待ちに積み、届くようになったら送る)
  // -------------------------------------------------------------------------

  createEvent(input: CreateEventInput): string {
    const id = input.id ?? randomUuid();
    const at = this.now().toISOString();
    const { id: _id, calendarId: _calendarId, ...fields } = input;
    this.push({
      kind: "create",
      calendarId: input.calendarId,
      eventId: id,
      recurrenceId: null,
      body: { ...input, id },
      changedAt: Object.fromEntries(Object.keys(fields).map((k) => [k, at])),
      at,
      before: null,
    });
    return id;
  }

  updateEvent(id: string, changes: EventFields): void {
    const event = this.view().events.get(id);
    // 仮の例外 (まだサーバーに行が無い回) への変更は、回の変更として積む。
    // 例外の行ができて ID が入れ替わった後に、古い仮の ID で呼ばれたときも同じ。
    const occurrence = this.occurrenceOf(id, event);
    if (occurrence) {
      const { recurrence: _ignored, ...rest } = changes;
      this.updateOccurrence(occurrence.masterId, occurrence.recurrenceId, rest);
      return;
    }
    const keys = Object.keys(changes) as (keyof EventFields)[];
    if (keys.length === 0) return;
    const at = this.now().toISOString();
    this.push({
      kind: "update",
      calendarId: event?.calendarId ?? this.calendarOfOp(id),
      eventId: id,
      recurrenceId: null,
      body: changes,
      changedAt: Object.fromEntries(keys.map((key) => [key, at])),
      at,
      before: event ? eventFieldsOf(event, keys) : null,
      target: event ?? null,
    });
  }

  updateOccurrence(
    masterId: string,
    recurrenceId: string,
    changes: EventFields,
  ): void {
    // 例外では繰り返しを変えられない (サーバーも断る)。
    const { recurrence: _ignored, ...rest } = changes;
    const keys = Object.keys(rest) as (keyof EventFields)[];
    if (keys.length === 0) return;
    const rid = normalizeRecurrenceId(recurrenceId);
    const events = this.view().events;
    const master = events.get(masterId);
    const current =
      [...events.values()].find(
        (event) =>
          event.parentId === masterId &&
          event.recurrenceId !== null &&
          normalizeRecurrenceId(event.recurrenceId) === rid,
      ) ?? (master ? provisionalException(master, rid) : undefined);
    const at = this.now().toISOString();
    this.push({
      kind: "occurrence_update",
      calendarId: master?.calendarId ?? this.calendarOfOp(masterId),
      eventId: masterId,
      recurrenceId: rid,
      body: rest,
      changedAt: Object.fromEntries(keys.map((key) => [key, at])),
      at,
      before: current ? eventFieldsOf(current, keys) : null,
      target: master ?? null,
    });
  }

  deleteEvent(id: string): void {
    const events = this.view().events;
    const event = events.get(id);
    const occurrence = this.occurrenceOf(id, event);
    if (occurrence) {
      this.deleteOccurrence(occurrence.masterId, occurrence.recurrenceId);
      return;
    }
    const related = new Set(
      [...events.values()]
        .filter((other) => other.parentId === id)
        .map((other) => other.id),
    );
    const at = this.now().toISOString();
    this.push(
      {
        kind: "delete",
        calendarId: event?.calendarId ?? this.calendarOfOp(id),
        eventId: id,
        recurrenceId: null,
        body: null,
        changedAt: {},
        at,
        before: null,
      },
      related,
    );
  }

  deleteOccurrence(masterId: string, recurrenceId: string): void {
    const master = this.view().events.get(masterId);
    const at = this.now().toISOString();
    this.push({
      kind: "occurrence_delete",
      calendarId: master?.calendarId ?? this.calendarOfOp(masterId),
      eventId: masterId,
      recurrenceId: normalizeRecurrenceId(recurrenceId),
      body: null,
      changedAt: { recurrence: at },
      at,
      before: null,
    });
  }

  respond(id: string, status: AttendeeStatus): void {
    const event = this.view().events.get(id);
    const at = this.now().toISOString();
    this.push({
      kind: "respond",
      calendarId: event?.calendarId ?? this.calendarOfOp(id),
      eventId: id,
      recurrenceId: null,
      body: { status },
      changedAt: {},
      at,
      before: null,
      target: event ?? null,
    });
  }

  updateCalendar(id: string, changes: CalendarChanges): void {
    if (Object.keys(changes).length === 0) return;
    const at = this.now().toISOString();
    this.push({
      kind: "calendar_update",
      calendarId: id,
      eventId: null,
      recurrenceId: null,
      body: changes,
      changedAt: Object.fromEntries(Object.keys(changes).map((k) => [k, at])),
      at,
      before: null,
    });
  }

  retry(opId: string): void {
    const op = this.ops.find((other) => other.id === opId);
    if (!op || op.state === "pending") return;
    const next: QueuedOp = { ...op, state: "pending", error: null };
    this.ops = this.ops.map((other) => (other.id === opId ? next : other));
    const removed = this.notices.filter((notice) => notice.opId === opId);
    this.notices = this.notices.filter((notice) => notice.opId !== opId);
    this.commit(
      [putOp(next), ...removed.map((notice) => deleteNotice(notice.id))],
      { queue: true, notices: removed.length > 0, events: [] },
    ).then(() => this.retryNow());
  }

  discard(opId: string): void {
    if (this.inFlight === opId) return;
    if (!this.ops.some((op) => op.id === opId)) return;
    this.ops = this.ops.filter((op) => op.id !== opId);
    const removed = this.notices.filter((notice) => notice.opId === opId);
    this.notices = this.notices.filter((notice) => notice.opId !== opId);
    void this.commit(
      [deleteOp(opId), ...removed.map((notice) => deleteNotice(notice.id))],
      { queue: true, notices: removed.length > 0, events: [] },
    );
  }

  async resolveConflict(id: string, action: ConflictAction): Promise<void> {
    const item = this.conflicts().find((other) => other.id === id);
    if (!item) return;
    // 出していない操作 (作り直す元が無い「復元」など) では、記録を閉じない。
    if (action !== "dismiss" && !item.actions.includes(action)) return;
    if (item.source === "server") {
      // 先にサーバーの記録を閉じる (届かなければ、何も積まずに失敗を返す)。
      if (item.kind === "create_failed" && action === "retry") {
        await this.api.retryConflict(id);
      }
      if (item.kind === "invite_failed" && action === "resend") {
        await this.api.resendInvite(id);
      }
      await this.api.dismissConflict(id).catch((error) => {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      });
      const serverConflicts = this.meta.serverConflicts.filter(
        (other) => other.id !== id,
      );
      this.meta = {
        ...this.meta,
        serverConflicts,
        openConflicts: Math.max((this.meta.openConflicts ?? 1) - 1, 0),
      };
      await this.commit(
        metaWrites({
          serverConflicts,
          openConflicts: this.meta.openConflicts,
        }),
        { notices: true, events: [] },
      );
    } else {
      this.notices = this.notices.filter((other) => other.id !== id);
      await this.commit([deleteNotice(id)], { notices: true, events: [] });
      if (item.opId && action !== "retry") this.discard(item.opId);
    }
    if (action === "dismiss") return;
    this.applyResolution(item, action);
  }

  private applyResolution(item: ConflictItem, action: ConflictAction): void {
    switch (action) {
      case "retry":
        if (item.source === "local" && item.opId) {
          this.retry(item.opId);
        } else if (item.kind === "write_failed") {
          if (!item.lost || item.fields.length === 0) {
            // 削除の書き戻しの失敗 (項目も値も無い): 削除をもう一度積む。
            if (!item.eventId) return;
            if (item.recurrenceId) {
              this.deleteOccurrence(item.eventId, item.recurrenceId);
            } else {
              this.deleteEvent(item.eventId);
            }
          } else {
            this.resend(item);
          }
        }
        return;
      case "restore":
        if (
          item.kind === "remote_deleted" ||
          item.kind === "deleted_elsewhere" ||
          item.kind === "occurrence_gone"
        ) {
          // 同じ ID では作り直さない (プロバイダが消した ID での作成を断るため)。
          if (item.snapshot) this.createFromSnapshot(item.snapshot, item.lost);
        } else {
          this.resend(item);
        }
        return;
      case "delete":
        if (item.eventId) this.deleteEvent(item.eventId);
        return;
      case "resend":
      case "dismiss":
        // resend はサーバーが送り直す (resolveConflict で済んでいる)。
        return;
    }
  }

  /** 負けた値を、いまの時刻で送り直す。 */
  private resend(item: ConflictItem): void {
    if (!item.eventId || !item.lost) return;
    if (item.recurrenceId) {
      this.updateOccurrence(item.eventId, item.recurrenceId, item.lost);
    } else {
      this.updateEvent(item.eventId, item.lost);
    }
  }

  private createFromSnapshot(
    snapshot: CalendarEvent,
    lost: EventFields | null,
  ): void {
    const fields = eventFieldsOf(snapshot);
    // 例外 (回) から作るときは、単発の予定にする。
    if (snapshot.parentId) delete fields.recurrence;
    else if (!snapshot.rrule && snapshot.rdates.length === 0) {
      delete fields.recurrence;
    }
    const merged: EventFields = { ...fields, ...(lost ?? {}) };
    if (snapshot.parentId) delete merged.recurrence;
    // 自分が主催者でない予定 (招待された予定・主催者の分からない記録) は、参加者を付けずに
    // 作る。付けると自分が主催者として全員に招待が送られる (review-invites の 2)。
    if (inviteRole(snapshot) !== "organizer") delete merged.attendees;
    if (!merged.time) return;
    this.createEvent({
      ...merged,
      time: merged.time,
      calendarId: snapshot.calendarId,
    });
  }

  /**
   * 回の操作に読み替える ID か。仮の例外 (まだサーバーに行が無い回) と、例外の行ができて
   * 入れ替わった後の古い仮の ID (<原本の ID>:<recurrenceId>) が当たる。
   */
  private occurrenceOf(
    id: string,
    event: CalendarEvent | undefined,
  ): { masterId: string; recurrenceId: string } | null {
    if (event) {
      return event.parentId && event.recurrenceId && !this.baseEvents.has(id)
        ? { masterId: event.parentId, recurrenceId: event.recurrenceId }
        : null;
    }
    const split = id.indexOf(":");
    if (split <= 0) return null;
    const masterId = id.slice(0, split);
    const recurrenceId = id.slice(split + 1);
    const master = this.view().events.get(masterId);
    if (!master || master.parentId) return null;
    try {
      if (provisionalExceptionId(masterId, recurrenceId) !== id) return null;
    } catch {
      return null;
    }
    return { masterId, recurrenceId };
  }

  private calendarOfOp(eventId: string): string {
    return this.ops.find((op) => op.eventId === eventId)?.calendarId ?? "";
  }

  private push(
    partial: Omit<QueuedOp, "id" | "seq" | "state" | "error" | "attempted">,
    related?: ReadonlySet<string>,
  ): void {
    if (this.stopped) throw new Error("closed");
    if (!this.store.persistent && !this.isOnline()) {
      throw new OfflineUnavailableError();
    }
    const op: QueuedOp = {
      ...partial,
      id: randomUuid(),
      seq: nextSeq(this.now().getTime()),
      state: "pending",
      error: null,
    };
    const result = enqueueOp(this.ops, op, this.inFlight, related);
    this.ops = result.queue;
    void this.commit(
      [...result.put.map(putOp), ...result.remove.map(deleteOp)],
      { queue: true, events: op.eventId ? [op.eventId] : [] },
    ).then(() => this.flush());
  }

  // -------------------------------------------------------------------------
  // 送る
  // -------------------------------------------------------------------------

  /** 送信待ちを順に送る。届かなければ、時間を置いてやり直す。 */
  flush(): Promise<void> {
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** 接続が戻ったときに呼ぶ。待ち時間を戻して、すぐに送る。 */
  retryNow(): void {
    this.delay = this.baseRetryMs;
    void this.flush();
  }

  /** 接続が戻ったとき。送り直し、画面が使っていれば差分も取る。 */
  onOnline(): void {
    this.retryNow();
    if (this.active) void this.pull();
  }

  private async runFlush(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.stopped) return;
    if (this.share) {
      await this.share.withFlushLock(() => this.sendLoop());
    } else {
      await this.sendLoop();
    }
  }

  private async sendLoop(): Promise<void> {
    // ほかのウィンドウが送った分を反映するため、送る前に保存先から読み直す。
    await this.writeChain;
    await this.reloadQueue();
    let sent = false;
    for (;;) {
      if (this.stopped) return;
      const next = nextSendable(this.ops);
      if (!next) break;
      const op = await this.markAttempted(next);
      if (!op) continue;
      this.inFlight = op.id;
      let outcome: OpOutcome;
      try {
        outcome = await sendOp(this.api, op, this.now());
      } finally {
        this.inFlight = null;
      }
      if (outcome.type === "retry") {
        if (!this.stopped) {
          this.retryTimer = setTimeout(() => void this.flush(), this.delay);
          this.delay = Math.min(
            this.delay * 2,
            this.options.maxRetryMs ?? 60_000,
          );
        }
        return;
      }
      // ログアウトした。次にログインしたときに続きを送る。
      if (outcome.type === "stop") return;
      this.delay = this.baseRetryMs;
      await this.settle(op, outcome);
      sent = true;
    }
    if (sent && this.active) void this.pull();
  }

  /**
   * 保存先にある今の操作を読む。書き込みを確かめていないものはメモリーの値。
   * 消えていれば null、読めなければ undefined。
   */
  private async storedOp(id: string): Promise<QueuedOp | null | undefined> {
    await this.writeChain;
    if (this.unsavedOps.has(id)) return this.unsavedOps.get(id) ?? null;
    try {
      return (await this.store.get<QueuedOp>("calQueue", id)) ?? null;
    } catch {
      return undefined;
    }
  }

  /**
   * 送る前に「送ろうとした」印を保存先に書く。ほかのウィンドウは印を見たら、その操作に
   * まとめない。保存先の今の値 (ほかのウィンドウがまとめた後のもの) に印を付けて、それを送る。
   * 消えていた、または送らない状態に変わっていたら null。
   */
  private async markAttempted(op: QueuedOp): Promise<QueuedOp | null> {
    const stored = await this.storedOp(op.id);
    const replaceInMemory = (value: QueuedOp | null) => {
      this.ops = value
        ? this.ops.map((other) => (other.id === op.id ? value : other))
        : this.ops.filter((other) => other.id !== op.id);
      this.invalidate();
      this.notifyLocal();
    };
    if (stored === null) {
      replaceInMemory(null);
      return null;
    }
    const base = stored ?? this.ops.find((other) => other.id === op.id) ?? op;
    if (base.state !== "pending") {
      replaceInMemory(base);
      return null;
    }
    if (base.attempted) {
      if (base !== op) replaceInMemory(base);
      return base;
    }
    const marked: QueuedOp = { ...base, attempted: true };
    this.ops = this.ops.map((other) => (other.id === op.id ? marked : other));
    // 書けなくても送る (このウィンドウはメモリーの印でまとめない)。
    await this.commit([putOp(marked)], { queue: true, events: [] });
    return marked;
  }

  /** 送った結果を、base・送信待ち・通知に反映する (1 回の write)。 */
  private async settle(
    sent: QueuedOp,
    outcome: Exclude<OpOutcome, { type: "retry" | "stop" }>,
  ): Promise<void> {
    // 送っている間に、印を見る前のほかのウィンドウがまとめていたら、その分は送っていない。
    // 保存先を読み直し、送った内容との差を、新しい操作として残す。
    const stored = await this.storedOp(sent.id);
    const op: QueuedOp = stored ? { ...stored, attempted: true } : sent;
    const remainder = stored ? remainderOf(sent, stored) : null;
    const writes: WriteOp[] = [];
    const changedEvents: string[] = [];
    let calendarsChanged = false;
    let noticesChanged = false;
    const setEvent = (event: CalendarEvent) => {
      this.baseEvents.set(event.id, event);
      writes.push(putEvent(event));
      changedEvents.push(event.id);
    };
    const addNotice = (notice: ConflictItem) => {
      this.notices = [...this.notices, notice];
      writes.push(putNotice(notice));
      noticesChanged = true;
    };
    const removeOp = () => {
      this.ops = this.ops.filter((other) => other.id !== op.id);
      writes.push(deleteOp(op.id));
      if (remainder) {
        const rest: QueuedOp = { ...remainder, id: randomUuid() };
        this.ops = [...this.ops, rest].sort(bySeq);
        writes.push(putOp(rest));
      }
    };
    const markOp = (state: QueuedOp["state"], error: string) => {
      const next: QueuedOp = { ...op, state, error };
      this.ops = this.ops.map((other) => (other.id === op.id ? next : other));
      writes.push(putOp(next));
    };

    switch (outcome.type) {
      case "done": {
        removeOp();
        if (outcome.event) setEvent(outcome.event);
        if (outcome.calendar) {
          this.baseCalendars.set(outcome.calendar.id, outcome.calendar);
          writes.push(putCalendar(outcome.calendar));
          calendarsChanged = true;
        }
        if (
          !outcome.event &&
          (op.kind === "delete" || op.kind === "occurrence_delete")
        ) {
          // 応答に予定が無い操作は、受け付けられた結果を base にも当てる
          // (次の同期を待たずに、表示が戻らないように)。
          const before = new Map(this.baseEvents);
          applyOpToEvents(this.baseEvents, op);
          for (const [id, event] of this.baseEvents) {
            if (before.get(id) !== event) setEvent(event);
          }
          for (const id of before.keys()) {
            if (!this.baseEvents.has(id)) {
              writes.push(deleteEvent(id));
              changedEvents.push(id);
            }
          }
        }
        const rejected = outcome.rejected ?? [];
        if (rejected.length > 0) {
          addNotice({
            id: randomUuid(),
            source: "local",
            kind: "rejected",
            calendarId: op.calendarId,
            eventId: op.eventId,
            recurrenceId: op.recurrenceId,
            title: outcome.event?.summary ?? null,
            fields: rejected,
            lost: pick(sent.body as EventFields, rejected),
            kept: outcome.event ? eventFieldsOf(outcome.event, rejected) : null,
            snapshot: null,
            reason: "changed_elsewhere",
            createdAt: this.now().toISOString(),
            actions: ["restore", "dismiss"],
            opId: null,
          });
        }
        break;
      }
      case "blocked":
        markOp("blocked", outcome.code);
        break;
      case "changed_since": {
        removeOp();
        if (outcome.event) setEvent(outcome.event);
        const event = outcome.event ?? this.baseEvents.get(op.eventId ?? "");
        addNotice({
          id: randomUuid(),
          source: "local",
          kind: "delete_cancelled",
          calendarId: op.calendarId,
          eventId: op.eventId,
          recurrenceId: null,
          title: event?.summary ?? null,
          fields: [],
          lost: null,
          kept: null,
          snapshot: event ?? null,
          reason: "changed_since",
          createdAt: this.now().toISOString(),
          actions: ["delete", "dismiss"],
          opId: null,
        });
        break;
      }
      case "error": {
        if (
          op.kind === "respond" &&
          (outcome.code === "not_found" || outcome.code === "unsupported")
        ) {
          // 予定が無い (取り消し済みの招待など) か、出欠に対応していない古いサーバー。
          // 返事は捨てて、同じ予定への後続 (不参加にして削除の削除) を止めない。
          // 「復元」は出さない (作り直すと自分が主催者として招待が送られる)。
          removeOp();
          if (!this.followedByDelete(op)) {
            addNotice({
              id: randomUuid(),
              source: "local",
              kind: "failed",
              calendarId: op.calendarId,
              eventId: op.eventId,
              recurrenceId: null,
              title:
                (op.target ?? this.baseEvents.get(op.eventId ?? ""))?.summary ??
                null,
              fields: [],
              lost: null,
              kept: null,
              snapshot: null,
              reason: outcome.code,
              createdAt: this.now().toISOString(),
              actions: ["dismiss"],
              opId: null,
            });
          }
          break;
        }
        markOp("error", outcome.code);
        const kind: ConflictKind =
          outcome.code === "deleted_elsewhere"
            ? "deleted_elsewhere"
            : outcome.code === "invalid" && op.kind === "occurrence_update"
              ? "occurrence_gone"
              : "failed";
        const snapshot = this.intendedEvent(op);
        const lost =
          op.kind === "update" || op.kind === "occurrence_update"
            ? (op.body as EventFields)
            : null;
        addNotice({
          id: randomUuid(),
          source: "local",
          kind,
          calendarId: op.calendarId,
          eventId: op.eventId,
          recurrenceId: op.recurrenceId,
          title: snapshot?.summary ?? null,
          fields: lost ? (Object.keys(lost) as (keyof EventFields)[]) : [],
          lost,
          kept: null,
          snapshot,
          reason: outcome.code,
          createdAt: this.now().toISOString(),
          actions:
            kind === "failed"
              ? ["retry", "dismiss"]
              : snapshot
                ? ["restore", "dismiss"]
                : ["dismiss"],
          opId: op.id,
        });
        break;
      }
    }
    await this.commit(writes, {
      events: changedEvents,
      calendars: calendarsChanged,
      queue: true,
      notices: noticesChanged,
    });
  }

  /** 返事の後ろに、同じ予定 (例外の行ならその回) の削除が積まれているか。 */
  private followedByDelete(respond: QueuedOp): boolean {
    const target = respond.target ?? this.baseEvents.get(respond.eventId ?? "");
    const rid =
      target?.parentId && target.recurrenceId
        ? normalizeRecurrenceId(target.recurrenceId)
        : null;
    return this.ops.some(
      (other) =>
        other.seq > respond.seq &&
        ((other.kind === "delete" && other.eventId === respond.eventId) ||
          (other.kind === "delete" &&
            !!target?.parentId &&
            other.eventId === target.parentId) ||
          (other.kind === "occurrence_delete" &&
            rid !== null &&
            other.eventId === target?.parentId &&
            other.recurrenceId !== null &&
            normalizeRecurrenceId(other.recurrenceId) === rid)),
    );
  }

  /** 操作が通っていたらこうなっていた予定 (復元に使う)。 */
  private intendedEvent(op: QueuedOp): CalendarEvent | null {
    if (!op.eventId) return null;
    const events = new Map(this.baseEvents);
    // 同期が先に削除を取り込んでいたら、積んだときの予定から作る。
    if (op.target && !events.has(op.target.id)) {
      events.set(op.target.id, op.target);
    }
    applyOpToEvents(events, op);
    if (op.kind === "occurrence_update" && op.recurrenceId) {
      const rid = normalizeRecurrenceId(op.recurrenceId);
      return (
        [...events.values()].find(
          (event) =>
            event.parentId === op.eventId &&
            event.recurrenceId !== null &&
            normalizeRecurrenceId(event.recurrenceId) === rid,
        ) ?? null
      );
    }
    return events.get(op.eventId) ?? null;
  }

  // -------------------------------------------------------------------------
  // 同期
  // -------------------------------------------------------------------------

  /** サーバーの差分を取り込む。重なって呼ばれたら、終わった後にもう 1 回だけ取る。 */
  pull(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      do {
        this.pullAgain = false;
        await this.pullOnce();
      } while (this.pullAgain && !this.stopped);
    })()
      .catch(() => {})
      .finally(() => {
        this.pulling = null;
      });
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    const since = this.pullFromStart ? "0" : this.meta.cursor;
    this.pullFromStart = false;
    const result = await pullChanges(since, {
      fetchPage: (since) => this.api.syncCalendars(since),
      apply: (page) => this.applyPage(page),
    });
    if (this.stopped) return;
    if (!this.meta.initialSyncDone) {
      this.meta = { ...this.meta, initialSyncDone: true };
      this.calendarsKnown = true;
      await this.commit(metaWrites({ initialSyncDone: true }), {
        events: [],
        notices: true,
      });
    }
    if (
      result.openConflicts !== undefined &&
      (result.openConflicts !== this.meta.openConflicts ||
        (result.conflictsAt ?? null) !== this.meta.conflictsAt)
    ) {
      await this.refreshConflicts(
        result.openConflicts,
        result.conflictsAt ?? null,
      );
    }
  }

  private async applyPage(page: CalendarSyncPage): Promise<void> {
    if (this.stopped) return;
    const writes: WriteOp[] = [];
    const changedEvents: string[] = [];
    for (const calendar of page.calendars) {
      const existing = this.baseCalendars.get(calendar.id);
      if (existing && existing.updatedAt > calendar.updatedAt) continue;
      this.baseCalendars.set(calendar.id, calendar);
      writes.push(putCalendar(calendar));
    }
    for (const id of page.deleted.calendars) {
      this.baseCalendars.delete(id);
      writes.push(deleteCalendar(id));
    }
    for (const event of page.events) {
      // 送信の応答で入れた新しい値を、先に取り始めていた古いページで戻さない。
      const existing = this.baseEvents.get(event.id);
      if (existing && existing.updatedAt > event.updatedAt) continue;
      this.baseEvents.set(event.id, event);
      writes.push(putEvent(event));
      changedEvents.push(event.id);
    }
    for (const id of page.deleted.events) {
      if (this.baseEvents.delete(id)) changedEvents.push(id);
      writes.push(deleteEvent(id));
    }
    // 同期が止まっていたカレンダーが変わったら、止めていた操作をやり直す。
    const touched = new Set(page.calendars.map((calendar) => calendar.id));
    let unblocked = false;
    this.ops = this.ops.map((op) => {
      if (op.state !== "blocked" || !touched.has(op.calendarId)) return op;
      const next: QueuedOp = { ...op, state: "pending", error: null };
      writes.push(putOp(next));
      unblocked = true;
      return next;
    });
    // cursor は大きい方だけを書く (ほかのウィンドウが先に進めていることがある)。
    const stored =
      (await this.store.get<string>("calMeta", "cursor").catch(() => null)) ??
      "0";
    let cursor = page.latestSeq;
    if (compareSeq(stored, cursor) > 0) cursor = stored;
    if (compareSeq(this.meta.cursor, cursor) > 0) cursor = this.meta.cursor;
    this.meta = { ...this.meta, cursor };
    writes.push(...metaWrites({ cursor }));
    await this.commit(writes, {
      events: changedEvents,
      calendars: page.calendars.length + page.deleted.calendars.length > 0,
      queue: unblocked,
      notices: false,
    });
    if (unblocked) void this.flush();
  }

  /**
   * 端末の控えを消して since=0 から取り直す (設定の「カレンダーを同期し直す」)。
   * 送信待ちと通知は残す。サーバーの DB を作り直して cursor が合わなくなったときに使う。
   */
  async resync(): Promise<void> {
    await this.pulling;
    const [eventKeys, calendarKeys] = await Promise.all([
      this.store.keys("calEvents").catch(() => [...this.baseEvents.keys()]),
      this.store
        .keys("calCalendars")
        .catch(() => [...this.baseCalendars.keys()]),
    ]);
    const writes: WriteOp[] = [
      ...eventKeys.map(deleteEvent),
      ...calendarKeys.map(deleteCalendar),
      ...metaWrites({ cursor: "0", initialSyncDone: false }),
    ];
    this.baseEvents = new Map();
    this.baseCalendars = new Map();
    this.calendarsKnown = false;
    this.rangeLoaded.clear();
    this.meta = { ...this.meta, cursor: "0", initialSyncDone: false };
    await this.commit(writes, { calendars: true, notices: true, events: [] });
    await this.refreshCalendars();
    await this.pull();
  }

  /** カレンダーの一覧を取り直す (一覧は小さいので、まるごと置き換える)。 */
  async refreshCalendars(): Promise<void> {
    let list: Calendar[];
    try {
      list = await this.api.listCalendars();
    } catch {
      // 届かなければ、端末の控えのまま (無ければ空の一覧) を出す。
      if (!this.calendarsKnown) {
        this.calendarsKnown = true;
        this.invalidate();
        this.notifyLocal();
      }
      return;
    }
    if (this.stopped) return;
    const writes: WriteOp[] = [];
    const ids = new Set(list.map((calendar) => calendar.id));
    for (const id of this.baseCalendars.keys()) {
      if (!ids.has(id)) writes.push(deleteCalendar(id));
    }
    this.baseCalendars = new Map(
      list.map((calendar) => [calendar.id, calendar]),
    );
    writes.push(...list.map(putCalendar));
    this.calendarsKnown = true;
    await this.commit(writes, { calendars: true, events: [] });
    this.refetchForInvites(list);
  }

  /**
   * 差分同期は変わった行しか返さないので、招待の項目 (organizer.self) が入る前の控えは
   * そのまま残る。サーバーが新しい (カレンダーに scheduling がある) のに、主催者の印の無い
   * 予定が控えにあれば、一度だけ since=0 から取り直す (cursor は戻さない。applyPage は
   * 大きい方の cursor を残す)。古いサーバーでは何もしない。
   */
  private refetchForInvites(list: readonly Calendar[]): void {
    if (this.refetchedForInvites || !this.meta.initialSyncDone) return;
    if (!list.some((calendar) => calendar.scheduling !== undefined)) return;
    const stale = [...this.baseEvents.values()].some(
      (event) => event.organizer !== null && event.organizer.self === undefined,
    );
    if (!stale) return;
    this.refetchedForInvites = true;
    this.pullFromStart = true;
    void this.pull();
  }

  private async loadRange(range: EventRangeQuery, key: string): Promise<void> {
    this.rangeLoading.add(key);
    try {
      const result = await this.api.listEvents(range);
      if (this.stopped) return;
      const writes: WriteOp[] = [];
      const changed: string[] = [];
      for (const event of result.events) {
        const existing = this.baseEvents.get(event.id);
        if (existing && existing.updatedAt > event.updatedAt) continue;
        this.baseEvents.set(event.id, event);
        writes.push(putEvent(event));
        changed.push(event.id);
      }
      this.rangeLoaded.add(key);
      await this.commit(writes, { events: changed });
    } catch {
      // 届かなければ、端末にある分だけで出す。
      this.rangeLoaded.add(key);
      this.invalidate();
      this.notifyLocal();
    } finally {
      this.rangeLoading.delete(key);
    }
  }

  private async refreshConflicts(
    openConflicts: number,
    conflictsAt: string | null,
  ): Promise<void> {
    let list: CalendarConflict[];
    try {
      list = openConflicts === 0 ? [] : await this.api.listConflicts();
    } catch {
      return;
    }
    if (this.stopped) return;
    const serverConflicts = list
      .filter((conflict) => !conflict.resolvedAt)
      .map(serverConflictItem);
    this.meta = { ...this.meta, openConflicts, conflictsAt, serverConflicts };
    await this.commit(
      metaWrites({ openConflicts, conflictsAt, serverConflicts }),
      { notices: true, events: [] },
    );
  }

  // -------------------------------------------------------------------------
  // 保存とお知らせ
  // -------------------------------------------------------------------------

  private invalidate(): void {
    this.viewCache = null;
    this.calendarList = null;
    this.queueList = null;
    this.conflictList = null;
    this.rangeCache.clear();
  }

  private notifyLocal(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * メモリーの変更を画面に知らせ、保存先に書き、ほかのウィンドウに合図する。
   * 書き込みは順番を守る (前の書き込みが終わってから)。返す Promise は失敗しない。
   * 書けなかったら storageFailed() を true にし、送信待ちの分はメモリーに残して次の書き込みで書き直す。
   */
  private commit(
    writes: WriteOp[],
    parts: {
      events?: string[];
      calendars?: boolean;
      queue?: boolean;
      notices?: boolean;
    },
  ): Promise<void> {
    this.invalidate();
    this.notifyLocal();
    for (const write of writes) {
      if (write.table !== "calQueue") continue;
      this.unsavedOps.set(
        write.key,
        write.type === "put" ? (write.value as QueuedOp) : null,
      );
    }
    this.writeChain = this.writeChain
      .then(() => this.writeNow(writes, parts))
      .catch(() => {});
    return this.writeChain;
  }

  private async writeNow(
    writes: WriteOp[],
    parts: {
      events?: string[];
      calendars?: boolean;
      queue?: boolean;
      notices?: boolean;
    },
  ): Promise<void> {
    // 前に書けなかった送信待ちも一緒に書く。
    const written = new Map<string, QueuedOp | null>();
    for (const write of writes) {
      if (write.table !== "calQueue") continue;
      written.set(
        write.key,
        write.type === "put" ? (write.value as QueuedOp) : null,
      );
    }
    const retried: WriteOp[] = [];
    for (const [id, value] of this.unsavedOps) {
      if (written.has(id)) continue;
      written.set(id, value);
      retried.push(value ? putOp(value) : deleteOp(id));
    }
    try {
      await this.store.write([...writes, ...retried]);
    } catch {
      if (!this.storageError && !this.stopped) {
        this.storageError = true;
        this.notifyLocal();
      }
      return;
    }
    for (const [id, value] of written) {
      if (this.unsavedOps.get(id) === value) this.unsavedOps.delete(id);
    }
    if (this.storageError && this.unsavedOps.size === 0) {
      this.storageError = false;
      this.notifyLocal();
    }
    this.share?.post({
      events: parts.events ?? [],
      calendars: parts.calendars ?? false,
      queue: (parts.queue ?? false) || retried.length > 0,
      notices: parts.notices ?? false,
    });
  }

  private async reloadQueue(): Promise<void> {
    const saved = await this.store.list<QueuedOp>("calQueue").catch(() => null);
    if (!saved) return;
    const byId = new Map(saved.map((op) => [op.id, op]));
    // 保存を確かめていない操作は、メモリーの値を使う (書けなかった分を消さない)。
    for (const [id, value] of this.unsavedOps) {
      if (value) byId.set(id, value);
      else byId.delete(id);
    }
    // 送っている最中の操作は、保存先から消えていても手元に残す。
    const inFlight = this.ops.find((op) => op.id === this.inFlight);
    if (inFlight && !byId.has(inFlight.id)) byId.set(inFlight.id, inFlight);
    const next = [...byId.values()].sort(bySeq);
    const same =
      next.length === this.ops.length &&
      next.every(
        (op, index) => JSON.stringify(op) === JSON.stringify(this.ops[index]),
      );
    if (same) return;
    this.ops = next;
    this.invalidate();
    this.notifyLocal();
  }

  /** ほかのウィンドウの合図、または前面に戻ったときに、保存先から読み直す。 */
  async reloadFromStore(
    parts: {
      events?: string[] | "all";
      calendars?: boolean;
      queue?: boolean;
      notices?: boolean;
    } = { events: "all", calendars: true, queue: true, notices: true },
  ): Promise<void> {
    if (this.stopped) return;
    try {
      if (parts.events === "all") {
        const events = await this.store.list<CalendarEvent>("calEvents");
        this.baseEvents = new Map(events.map((event) => [event.id, event]));
      } else if (parts.events && parts.events.length > 0) {
        const values = await Promise.all(
          parts.events.map((id) =>
            this.store.get<CalendarEvent>("calEvents", id),
          ),
        );
        parts.events.forEach((id, index) => {
          const value = values[index];
          if (value) this.baseEvents.set(id, value);
          else this.baseEvents.delete(id);
        });
      }
      if (parts.calendars) {
        const calendars = await this.store.list<Calendar>("calCalendars");
        const order = [...this.baseCalendars.keys()];
        calendars.sort(
          (a, b) =>
            (order.indexOf(a.id) + 1 || Number.MAX_SAFE_INTEGER) -
            (order.indexOf(b.id) + 1 || Number.MAX_SAFE_INTEGER),
        );
        this.baseCalendars = new Map(calendars.map((c) => [c.id, c]));
        if (calendars.length > 0) this.calendarsKnown = true;
      }
      if (parts.notices) {
        this.notices = await this.store.list<ConflictItem>("calNotices");
        const meta = await loadMeta(this.store);
        this.meta = {
          ...meta,
          // cursor は大きい方を使う。
          cursor:
            compareSeq(meta.cursor, this.meta.cursor) > 0
              ? meta.cursor
              : this.meta.cursor,
        };
      }
    } catch {
      return;
    }
    if (parts.queue) {
      await this.reloadQueue();
      if (nextSendable(this.ops)) void this.flush();
    }
    this.invalidate();
    this.notifyLocal();
  }

  /** 止める (保存先は閉じない)。 */
  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.retryTimer = null;
    this.checkTimer = null;
    this.stopTriggers?.();
    this.stopTriggers = null;
    this.stopShare?.();
    this.stopShare = null;
    this.listeners.clear();
  }
}
