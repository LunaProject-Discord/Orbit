import { withLocalFields } from "../ingest.js";
import type {
  CalendarProvider,
  CalendarRow,
  EventDelta,
  EventSnapshot,
  EventWrite,
  ProviderContext,
  ProviderSource,
  RemoteCalendar,
  RemoteEvent,
  RemoteEventRef,
  WriteResult,
} from "../provider.js";

/**
 * テスト用の偽のプロバイダ。相手側のカレンダーと予定をメモリに持ち、差分同期と書き込みを真似る。
 * - 同期の位置は "v<版>"。null か知らない値なら全件 (full) を返す。
 * - etag は書き込むたびに変わる。updateEvent / deleteEvent は ref.etag が違えば conflict を返す。
 * - raw は予定の中身の JSON。parseRaw で戻せる。
 * - enqueue で、次の呼び出しの結果 (WriteResult) や例外を差し込める。
 * 本番のコードからは使わない。
 */

type Method =
  | "listCalendars"
  | "syncEvents"
  | "getEvent"
  | "createEvent"
  | "updateEvent"
  | "deleteEvent"
  | "respond"
  | "maintainPush"
  | "stopPush";

type Outcome = WriteResult | Error;

/** 偽の相手側に置く予定。省いた項目は既定の値にする。 */
export type FakeEventSeed = Partial<RemoteEvent> & {
  remoteId: string;
  uid?: string;
};

export type FakeCall = {
  method: Method;
  calendarRemoteId?: string | null;
  ref?: RemoteEventRef;
  write?: EventWrite;
  syncToken?: string | null;
};

/** 予定の中身から raw を作る (raw と etag は含めない)。 */
function rawOf(event: RemoteEvent): string {
  const { raw: _raw, etag: _etag, ...rest } = event;
  return JSON.stringify(rest);
}

/** DB の行 (スナップショット) を、相手側の予定の形にする。 */
export function snapshotToRemote(
  snapshot: EventSnapshot,
  remote: {
    remoteId: string;
    etag: string | null;
    parentRemoteId: string | null;
  },
): RemoteEvent & { uid: string } {
  const event: RemoteEvent & { uid: string } = {
    remoteId: remote.remoteId,
    etag: remote.etag,
    parentRemoteId: remote.parentRemoteId,
    uid: snapshot.uid,
    recurrenceId: snapshot.recurrenceId,
    summary: snapshot.summary,
    location: snapshot.location,
    description: snapshot.description,
    status: snapshot.status,
    busy: snapshot.busy,
    allDay: snapshot.allDay,
    startAt: snapshot.startAt?.toISOString() ?? null,
    endAt: snapshot.endAt?.toISOString() ?? null,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    startTimeZone: snapshot.startTimeZone,
    endTimeZone: snapshot.endTimeZone,
    rrule: snapshot.rrule,
    rdates: snapshot.rdates,
    exdates: snapshot.exdates,
    organizer: snapshot.organizer,
    attendees: snapshot.attendees.map((attendee) => ({
      email: attendee.email,
      name: attendee.name,
      role: attendee.role,
      status: attendee.status,
      self: attendee.self,
    })),
    sequence: snapshot.sequence,
    conferenceUrl: snapshot.conferenceUrl,
    remoteUpdatedAt: snapshot.remoteUpdatedAt?.toISOString() ?? null,
    reminders: snapshot.useDefaultReminders ? null : snapshot.reminders,
    raw: "",
  };
  return { ...event, raw: rawOf(event) };
}

export class FakeCalendarProvider implements CalendarProvider {
  readonly source: ProviderSource;
  readonly defaultPollSeconds: number;
  /** 相手側のカレンダーの一覧。 */
  calendars: RemoteCalendar[] = [];
  /** 1 ページの件数。 */
  pageSize = 50;
  /** 呼び出しの記録。 */
  readonly calls: FakeCall[] = [];
  /** createEvent で、相手側が付け替える UID (Graph の真似)。null なら付け替えない。 */
  rewriteUid: ((uid: string) => string) | null = null;
  /**
   * 同じ events.id で作り直されたとき (相手側に残っている) の返し方。create は events.id から
   * 決まる ID で冪等に行う約束なので、"ok" は既にある予定を返し (Graph の transactionId の真似)、
   * "conflict" は { status: "conflict", remoteId } を返す (Google の 409、CalDAV の 412 の真似)。
   */
  existingCreate: "ok" | "conflict" = "ok";
  /** syncEvents の結果で、例外 (recurrenceId がある行) の uid を省く (Google / Graph の真似)。 */
  omitExceptionUid = false;
  /** events.id → 作った予定の remoteId。 */
  private readonly createdByEventId = new Map<string, string>();
  /** カレンダーの remoteId → (予定の remoteId → その予定の行)。 */
  private readonly store = new Map<string, Map<string, RemoteEvent[]>>();
  private readonly changes: {
    version: number;
    calendar: string;
    remoteId: string;
  }[] = [];
  private version = 0;
  private sequence = 0;
  private readonly queued = new Map<Method, Outcome[]>();

  constructor(
    options: {
      source?: ProviderSource;
      defaultPollSeconds?: number;
      now?: () => Date;
    } = {},
  ) {
    this.source = options.source ?? "google";
    this.defaultPollSeconds = options.defaultPollSeconds ?? 900;
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  /** 次の呼び出しの結果を差し込む (先に入れたものから使う)。 */
  enqueue(method: Method, ...outcomes: Outcome[]) {
    this.queued.set(method, [...(this.queued.get(method) ?? []), ...outcomes]);
  }

  private take(method: Method): WriteResult | null {
    const list = this.queued.get(method);
    const next = list?.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  }

  private bucket(calendarRemoteId: string) {
    let bucket = this.store.get(calendarRemoteId);
    if (!bucket) {
      bucket = new Map();
      this.store.set(calendarRemoteId, bucket);
    }
    return bucket;
  }

  private touch(calendarRemoteId: string, remoteId: string) {
    this.version++;
    this.changes.push({
      version: this.version,
      calendar: calendarRemoteId,
      remoteId,
    });
  }

  private stamp(event: RemoteEvent): RemoteEvent {
    const etag = `e${++this.sequence}`;
    const next = { ...event, etag };
    return { ...next, raw: rawOf(next) };
  }

  /** 相手側に予定を置く (テストから相手側の変更を真似る)。 */
  putRemote(calendarRemoteId: string, seeds: FakeEventSeed[]) {
    const byRemoteId = new Map<string, RemoteEvent[]>();
    for (const seed of seeds) {
      const event = this.stamp({
        uid: seed.uid ?? `${seed.remoteId}@fake`,
        recurrenceId: null,
        parentRemoteId: null,
        summary: "予定",
        location: null,
        description: null,
        status: "confirmed",
        busy: true,
        allDay: false,
        startAt: "2026-12-01T01:00:00.000Z",
        endAt: "2026-12-01T02:00:00.000Z",
        startDate: null,
        endDate: null,
        startTimeZone: "Asia/Tokyo",
        endTimeZone: "Asia/Tokyo",
        rrule: null,
        rdates: null,
        exdates: null,
        organizer: null,
        attendees: [],
        sequence: 0,
        conferenceUrl: null,
        remoteUpdatedAt: this.now().toISOString(),
        reminders: null,
        ...seed,
        etag: null,
        raw: "",
      });
      byRemoteId.set(seed.remoteId, [
        ...(byRemoteId.get(seed.remoteId) ?? []),
        event,
      ]);
    }
    const bucket = this.bucket(calendarRemoteId);
    for (const [remoteId, list] of byRemoteId) {
      bucket.set(remoteId, list);
      this.touch(calendarRemoteId, remoteId);
    }
  }

  /** 相手側の予定を消す。 */
  removeRemote(calendarRemoteId: string, remoteId: string) {
    this.bucket(calendarRemoteId).delete(remoteId);
    this.touch(calendarRemoteId, remoteId);
  }

  /** 相手側の予定を読む。 */
  remote(calendarRemoteId: string, remoteId: string): RemoteEvent[] | null {
    const list = this.store.get(calendarRemoteId)?.get(remoteId);
    return list ? list.map((event) => ({ ...event })) : null;
  }

  /** 相手側の予定の数。 */
  remoteCount(calendarRemoteId: string) {
    return this.store.get(calendarRemoteId)?.size ?? 0;
  }

  async listCalendars(_ctx: ProviderContext): Promise<RemoteCalendar[]> {
    this.calls.push({ method: "listCalendars" });
    this.take("listCalendars");
    return this.calendars.map((calendar) => ({ ...calendar }));
  }

  async syncEvents(
    _ctx: ProviderContext,
    calendar: CalendarRow,
    cursor: { syncToken: string | null; pageCursor: string | null },
  ): Promise<EventDelta> {
    this.calls.push({
      method: "syncEvents",
      calendarRemoteId: calendar.remoteId,
      syncToken: cursor.syncToken,
    });
    this.take("syncEvents");
    const calendarRemoteId = calendar.remoteId ?? "";
    const bucket = this.bucket(calendarRemoteId);
    const match = /^v(\d+)$/.exec(cursor.syncToken ?? "");
    const since = match ? Number(match[1]) : null;
    const full = since === null || since > this.version;

    type Item = { event: RemoteEvent } | { deleted: string };
    const items: Item[] = [];
    if (full) {
      for (const remoteId of [...bucket.keys()].sort()) {
        for (const event of bucket.get(remoteId) ?? []) items.push({ event });
      }
    } else {
      const touched = new Set(
        this.changes
          .filter(
            (change) =>
              change.calendar === calendarRemoteId && change.version > since,
          )
          .map((change) => change.remoteId),
      );
      for (const remoteId of [...touched].sort()) {
        const list = bucket.get(remoteId);
        if (!list) items.push({ deleted: remoteId });
        else for (const event of list) items.push({ event });
      }
    }
    const offset = Number(cursor.pageCursor ?? "0");
    const page = items.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < items.length;
    return {
      events: page.flatMap((item) =>
        "event" in item
          ? [
              this.omitExceptionUid && item.event.recurrenceId !== null
                ? { ...item.event, uid: undefined }
                : { ...item.event },
            ]
          : [],
      ),
      deletedRemoteIds: page.flatMap((item) =>
        "deleted" in item ? [item.deleted] : [],
      ),
      nextPageCursor: more ? String(offset + this.pageSize) : null,
      nextSyncToken: more ? null : `v${this.version}`,
      full,
    };
  }

  async getEvent(
    _ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
  ): Promise<RemoteEvent[] | null> {
    this.calls.push({
      method: "getEvent",
      calendarRemoteId: calendar.remoteId,
      ref,
    });
    this.take("getEvent");
    return this.remote(calendar.remoteId ?? "", ref.remoteId);
  }

  parseRaw(raw: string, _calendar: CalendarRow): RemoteEvent[] {
    const parsed = JSON.parse(raw) as Omit<RemoteEvent, "raw" | "etag">;
    return [{ ...parsed, etag: null, raw }];
  }

  async createEvent(
    _ctx: ProviderContext,
    calendar: CalendarRow,
    write: EventWrite,
  ): Promise<WriteResult> {
    this.calls.push({
      method: "createEvent",
      calendarRemoteId: calendar.remoteId,
      write,
    });
    const queued = this.take("createEvent");
    if (queued) return queued;
    const calendarRemoteId = calendar.remoteId ?? "";
    const previous = this.createdByEventId.get(write.event.id);
    const existing = previous
      ? this.bucket(calendarRemoteId).get(previous)
      : undefined;
    if (previous && existing) {
      if (this.existingCreate === "conflict") {
        return { status: "conflict", remoteId: previous };
      }
      return { status: "ok", events: existing.map((event) => ({ ...event })) };
    }
    const remoteId = `r${++this.sequence}`;
    this.createdByEventId.set(write.event.id, remoteId);
    const base = snapshotToRemote(write.event, {
      remoteId,
      etag: null,
      parentRemoteId: null,
    });
    const event = this.stamp({
      ...base,
      uid: this.rewriteUid ? this.rewriteUid(base.uid) : base.uid,
      remoteUpdatedAt: this.now().toISOString(),
    });
    this.bucket(calendarRemoteId).set(remoteId, [event]);
    this.touch(calendarRemoteId, remoteId);
    return { status: "ok", events: [{ ...event }] };
  }

  async updateEvent(
    _ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
    write: EventWrite,
  ): Promise<WriteResult> {
    this.calls.push({
      method: "updateEvent",
      calendarRemoteId: calendar.remoteId,
      ref,
      write,
    });
    const queued = this.take("updateEvent");
    if (queued) return queued;
    const calendarRemoteId = calendar.remoteId ?? "";
    const bucket = this.bucket(calendarRemoteId);
    const list = bucket.get(ref.remoteId);
    if (!list) return { status: "gone" };
    if (write.event.remoteId === null && write.master) {
      // まだ相手側に無い回の例外を作る (別の remoteId にする。Google の真似)。
      const remoteId = `r${++this.sequence}`;
      const event = this.stamp({
        ...snapshotToRemote(write.event, {
          remoteId,
          etag: null,
          parentRemoteId: ref.remoteId,
        }),
        remoteUpdatedAt: this.now().toISOString(),
      });
      bucket.set(remoteId, [event]);
      this.touch(calendarRemoteId, remoteId);
      return { status: "ok", events: [{ ...event }] };
    }
    const index = list.findIndex(
      (event) => event.recurrenceId === ref.recurrenceId,
    );
    const current = list[index];
    if (!current) return { status: "gone" };
    if (ref.etag !== null && current.etag !== ref.etag) {
      return { status: "conflict" };
    }
    const next = this.stamp({
      ...withLocalFields(current, write.event, write.fields),
      remoteUpdatedAt: this.now().toISOString(),
    });
    list[index] = next;
    this.touch(calendarRemoteId, ref.remoteId);
    return { status: "ok", events: list.map((event) => ({ ...event })) };
  }

  async deleteEvent(
    _ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
  ): Promise<WriteResult> {
    this.calls.push({
      method: "deleteEvent",
      calendarRemoteId: calendar.remoteId,
      ref,
    });
    const queued = this.take("deleteEvent");
    if (queued) return queued;
    const calendarRemoteId = calendar.remoteId ?? "";
    const list = this.bucket(calendarRemoteId).get(ref.remoteId);
    if (!list) return { status: "gone" };
    const current = list.find(
      (event) => event.recurrenceId === ref.recurrenceId,
    );
    if (ref.etag !== null && current && current.etag !== ref.etag) {
      return { status: "conflict" };
    }
    this.removeRemote(calendarRemoteId, ref.remoteId);
    return { status: "ok", events: [] };
  }

  async respond(
    _ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
    response: { status: "accepted" | "tentative" | "declined" },
  ): Promise<WriteResult> {
    this.calls.push({
      method: "respond",
      calendarRemoteId: calendar.remoteId,
      ref,
    });
    const queued = this.take("respond");
    if (queued) return queued;
    const calendarRemoteId = calendar.remoteId ?? "";
    const list = this.bucket(calendarRemoteId).get(ref.remoteId);
    const index =
      list?.findIndex((event) => event.recurrenceId === ref.recurrenceId) ?? -1;
    const current = list?.[index];
    if (!list || !current) return { status: "gone" };
    if (ref.etag !== null && current.etag !== ref.etag) {
      return { status: "conflict" };
    }
    const next = this.stamp({
      ...current,
      attendees: current.attendees.map((attendee) =>
        attendee.self ? { ...attendee, status: response.status } : attendee,
      ),
      remoteUpdatedAt: this.now().toISOString(),
    });
    list[index] = next;
    this.touch(calendarRemoteId, ref.remoteId);
    return { status: "ok", events: list.map((event) => ({ ...event })) };
  }

  async maintainPush(
    _ctx: ProviderContext,
    _calendarRows: CalendarRow[],
  ): Promise<void> {
    this.calls.push({ method: "maintainPush" });
    this.take("maintainPush");
  }

  async stopPush(_ctx: ProviderContext, calendar: CalendarRow): Promise<void> {
    this.calls.push({
      method: "stopPush",
      calendarRemoteId: calendar.remoteId,
    });
    this.take("stopPush");
  }
}
