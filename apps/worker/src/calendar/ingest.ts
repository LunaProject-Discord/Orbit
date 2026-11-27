import {
  calendarLockKey,
  changedEventFields,
  EVENT_FIELD_NAMES,
  EVENT_OUTBOX_KINDS,
  type EventDeletePayload,
  type EventFieldName,
  type EventFieldValues,
  type EventUpdatePayload,
  eventFieldValues,
  mergeEventFields,
} from "@orbit/core";
import {
  calendars,
  type Database,
  deleteCalendarEventsByRemoteId,
  deleteCalendarEventsMissingFromResources,
  deleteCalendarEventsNotIn,
  type EventWithExtras,
  events,
  findCalendarEvents,
  outbox,
  type RemoteEventInput,
  upsertCalendarEvents,
} from "@orbit/db";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { recordChanges, type Tx } from "../changes.js";
import { lostValues, recordEventConflict } from "./conflicts.js";
import type {
  AccountRow,
  CalendarProvider,
  CalendarRow,
  EventDelta,
  RemoteEvent,
} from "./provider.js";

/**
 * プロバイダから届いた予定を DB に取り込む。DB の予定と項目ごとにマージし、
 * まだ書き戻していないローカルの変更は上書きしない。
 */

/** 予定の書き戻しと取り込みを順に行うための、アカウント単位のロック (メールとは別のキー)。 */
export async function lockCalendarAccount(tx: Tx, accountId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${calendarLockKey(accountId)}, 0))`,
  );
}

const keyOf = (uid: string, recurrenceId: string | null) =>
  `${uid}\u0000${recurrenceId ?? ""}`;

/** 削除の guard のキー。同じ uid や remoteId がほかのカレンダーにあっても混ざらないよう、カレンダーで分ける。 */
const calendarKeyOf = (calendarId: string, key: string) =>
  `${calendarId}\u0000${key}`;

/** 土台が uid を補ったあとの予定 1 行分 (uid が必ずある)。 */
export type ResolvedRemoteEvent = RemoteEvent & { uid: string };

/** まだプロバイダへ反映していない予定の書き戻し。取り込みでこれに当たるものは上書きしない。 */
export type PendingEventGuard = {
  /** 変更を書き戻し中の予定 (events.id) と、その項目。作成中の予定は全項目。 */
  pendingFields: Map<string, Set<EventFieldName>>;
  /** 作成を書き戻し中の予定 (events.id)。 */
  creating: Set<string>;
  /** 削除を書き戻し中の予定の (calendarId, remoteId)。 */
  deletedRemoteIds: Set<string>;
  /** 削除を書き戻し中の予定の (calendarId, uid, recurrenceId)。 */
  deletedKeys: Set<string>;
};

export function buildPendingEventGuard(
  rows: { kind: string; payload: Record<string, unknown> }[],
): PendingEventGuard {
  const guard: PendingEventGuard = {
    pendingFields: new Map(),
    creating: new Set(),
    deletedRemoteIds: new Set(),
    deletedKeys: new Set(),
  };
  const addFields = (eventId: string, fields: readonly EventFieldName[]) => {
    let set = guard.pendingFields.get(eventId);
    if (!set) {
      set = new Set();
      guard.pendingFields.set(eventId, set);
    }
    for (const field of fields) set.add(field);
  };
  for (const row of rows) {
    const payload = row.payload;
    switch (row.kind) {
      case "event_create": {
        const eventId = payload.eventId as string;
        guard.creating.add(eventId);
        addFields(eventId, EVENT_FIELD_NAMES);
        break;
      }
      case "event_update": {
        const { eventId, fields } = payload as EventUpdatePayload;
        addFields(eventId, fields ?? []);
        break;
      }
      case "event_respond":
        addFields(payload.eventId as string, ["attendees"]);
        break;
      case "event_delete": {
        const { target, calendarId } = payload as EventDeletePayload;
        if (!target) break;
        const scope = target.calendarId ?? calendarId;
        if (target.remoteId)
          guard.deletedRemoteIds.add(calendarKeyOf(scope, target.remoteId));
        guard.deletedKeys.add(
          calendarKeyOf(scope, keyOf(target.uid, target.recurrenceId)),
        );
        break;
      }
    }
  }
  return guard;
}

/**
 * アカウントのロックを取り、反映待ちの予定の書き戻しを返す。
 * 取り込みを書き込むトランザクションの最初に呼ぶ。excludeOutboxIds の行は数えない
 * (いま反映し終えた行の結果を書き込むとき)。
 */
export async function loadPendingEventGuard(
  tx: Tx,
  accountId: string,
  excludeOutboxIds: readonly string[] = [],
): Promise<PendingEventGuard> {
  await lockCalendarAccount(tx, accountId);
  const rows = await tx
    .select({ kind: outbox.kind, payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, accountId),
        inArray(outbox.kind, [...EVENT_OUTBOX_KINDS]),
        inArray(outbox.status, ["pending", "processing"]),
        ...(excludeOutboxIds.length > 0
          ? [notInArray(outbox.id, [...excludeOutboxIds])]
          : []),
      ),
    );
  return buildPendingEventGuard(rows);
}

/** calendarId のカレンダーで、削除を書き戻し中の予定 (と、削除中の原本の例外) なら true。 */
export function isDeletePending(
  guard: PendingEventGuard,
  calendarId: string,
  event: { uid: string; recurrenceId: string | null },
) {
  return (
    guard.deletedKeys.has(
      calendarKeyOf(calendarId, keyOf(event.uid, event.recurrenceId)),
    ) ||
    guard.deletedKeys.has(calendarKeyOf(calendarId, keyOf(event.uid, null)))
  );
}

/** calendarId のカレンダーで、remoteId の予定の削除を書き戻し中なら true。 */
export function isRemoteIdDeletePending(
  guard: PendingEventGuard,
  calendarId: string,
  remoteId: string,
) {
  return guard.deletedRemoteIds.has(calendarKeyOf(calendarId, remoteId));
}

/**
 * プロバイダが uid を省いた例外に、原本の uid を補う。探す順は、同じ応答の中の原本
 * (parentRemoteId の行)、同じ応答の同じ remoteId の行、DB の原本 (parentRemoteId)、
 * DB の同じ remoteId の行。補えなかったものは unresolved に返す (順番は保つ)。
 */
export async function resolveRemoteUids(
  tx: Tx | Database,
  calendarId: string,
  list: readonly RemoteEvent[],
): Promise<{ resolved: ResolvedRemoteEvent[]; unresolved: RemoteEvent[] }> {
  const hasUid = (event: RemoteEvent): event is ResolvedRemoteEvent =>
    typeof event.uid === "string" && event.uid !== "";
  const missing = list.filter((event) => !hasUid(event));
  if (missing.length === 0) {
    return { resolved: list as ResolvedRemoteEvent[], unresolved: [] };
  }
  const masterUid = new Map<string, string>();
  const anyUid = new Map<string, string>();
  for (const event of list) {
    if (!hasUid(event)) continue;
    if (event.recurrenceId === null) masterUid.set(event.remoteId, event.uid);
    if (!anyUid.has(event.remoteId)) anyUid.set(event.remoteId, event.uid);
  }
  const lookup = [
    ...new Set(
      missing.flatMap((event) =>
        event.parentRemoteId
          ? [event.parentRemoteId, event.remoteId]
          : [event.remoteId],
      ),
    ),
  ];
  const dbMaster = new Map<string, string>();
  const dbAny = new Map<string, string>();
  if (lookup.length > 0) {
    const rows = await tx
      .select({
        remoteId: events.remoteId,
        uid: events.uid,
        recurrenceId: events.recurrenceId,
      })
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendarId),
          inArray(events.remoteId, lookup),
        ),
      );
    for (const row of rows) {
      if (row.remoteId === null) continue;
      if (row.recurrenceId === null) dbMaster.set(row.remoteId, row.uid);
      if (!dbAny.has(row.remoteId)) dbAny.set(row.remoteId, row.uid);
    }
  }
  const resolved: ResolvedRemoteEvent[] = [];
  const unresolved: RemoteEvent[] = [];
  for (const event of list) {
    if (hasUid(event)) {
      resolved.push(event);
      continue;
    }
    const parent = event.parentRemoteId;
    const uid =
      (parent ? masterUid.get(parent) : undefined) ??
      anyUid.get(event.remoteId) ??
      (parent ? dbMaster.get(parent) : undefined) ??
      dbAny.get(event.remoteId);
    if (uid) resolved.push({ ...event, uid });
    else unresolved.push(event);
  }
  return { resolved, unresolved };
}

/** DB の行を、項目ごとの比べられる値にする。 */
export function rowFieldValues(row: EventWithExtras): EventFieldValues {
  return eventFieldValues(row);
}

/** 届いた予定の fields の項目を、DB の行の値で差し替える (ローカルの変更を残す)。 */
export function withLocalFields<T extends RemoteEvent>(
  input: T,
  row: EventWithExtras,
  fields: readonly EventFieldName[],
): T {
  const next: T = { ...input };
  for (const field of fields) {
    switch (field) {
      case "summary":
        next.summary = row.summary;
        break;
      case "location":
        next.location = row.location;
        break;
      case "description":
        next.description = row.description;
        break;
      case "status":
        next.status = row.status;
        break;
      case "busy":
        next.busy = row.busy;
        break;
      case "time":
        next.allDay = row.allDay;
        next.startAt = row.startAt?.toISOString() ?? null;
        next.endAt = row.endAt?.toISOString() ?? null;
        next.startDate = row.startDate;
        next.endDate = row.endDate;
        next.startTimeZone = row.startTimeZone;
        next.endTimeZone = row.endTimeZone;
        break;
      case "recurrence":
        next.rrule = row.rrule;
        next.rdates = row.rdates;
        next.exdates = row.exdates;
        break;
      case "conferenceUrl":
        next.conferenceUrl = row.conferenceUrl;
        break;
      case "attendees":
        next.attendees = row.attendees.map((attendee) => ({
          email: attendee.email,
          name: attendee.name,
          role: attendee.role,
          status: attendee.status,
          self: attendee.self,
        }));
        break;
      // リマインダーは下でまとめて扱う (reminders が null なら既定を使う、という決まりのため)。
      case "useDefaultReminders":
      case "reminders":
        break;
    }
  }
  const keepDefault = fields.includes("useDefaultReminders");
  const keepReminders = fields.includes("reminders");
  if (keepDefault || keepReminders) {
    const useDefault = keepDefault
      ? row.useDefaultReminders
      : input.reminders === null;
    next.reminders = useDefault
      ? null
      : keepReminders
        ? row.reminders
        : (input.reminders ?? row.reminders);
  }
  return next;
}

export type LostLocal = {
  eventId: string;
  fields: EventFieldName[];
  lost: Record<string, unknown>;
  title: string | null;
};

export type MergeOutcome = {
  /** upsertCalendarEvents に渡す入力。 */
  inputs: RemoteEventInput[];
  /**
   * 未送信のローカルの変更が、相手側の新しい変更に負けて失われた項目。lost は上書きする前の
   * 行の値 (API の変更の形)、title は上書きする前の題名。
   */
  lostLocal: LostLocal[];
  /** ローカルの値を残した項目 (events.id ごと)。書き戻しの競合の解決に使う。 */
  keptLocal: Map<string, EventFieldName[]>;
};

/**
 * 届いた予定を DB の行と項目ごとにマージし、upsert の入力を作る。DB には書かない。
 * 基準 (base) は行の raw を provider.parseRaw で戻したもの。
 */
export async function mergeRemoteEvents(
  tx: Tx,
  {
    calendar,
    provider,
    guard,
    events: remote,
    now,
  }: {
    calendar: CalendarRow;
    provider: CalendarProvider;
    guard: PendingEventGuard;
    events: readonly ResolvedRemoteEvent[];
    now: Date;
  },
): Promise<MergeOutcome> {
  const outcome: MergeOutcome = {
    inputs: [],
    lostLocal: [],
    keptLocal: new Map(),
  };
  if (remote.length === 0) return outcome;
  const existing = await findCalendarEvents(tx, calendar.id, {
    remoteIds: remote.map((event) => event.remoteId),
    uids: remote.map((event) => event.uid),
  });
  const byKey = new Map(
    existing.map((row) => [keyOf(row.uid, row.recurrenceId), row]),
  );
  const parsedRaw = new Map<string, RemoteEvent[] | null>();
  const baseOf = (row: EventWithExtras): EventFieldValues | null => {
    if (row.raw === null) return null;
    let parsed = parsedRaw.get(row.raw);
    if (parsed === undefined) {
      try {
        parsed = provider.parseRaw(row.raw, calendar);
      } catch {
        // 読めない raw は、基準が無いものとして扱う。
        parsed = null;
      }
      parsedRaw.set(row.raw, parsed);
    }
    if (!parsed) return null;
    const match =
      parsed.find(
        (event) =>
          event.uid === row.uid && event.recurrenceId === row.recurrenceId,
      ) ??
      parsed.find((event) => event.recurrenceId === row.recurrenceId) ??
      null;
    return match ? eventFieldValues(match) : null;
  };

  for (const input of remote) {
    const row = byKey.get(keyOf(input.uid, input.recurrenceId));
    if (!row) {
      outcome.inputs.push(input);
      continue;
    }
    // 前回から変わっていない (upsert でも触らない)。書き戻し待ちの項目でローカルが違うものは、
    // ローカルに残っているものとして知らせる (競合の解決で、書き戻しを続けるため)。
    if (
      row.etag === input.etag &&
      row.raw === input.raw &&
      row.remoteId === input.remoteId
    ) {
      outcome.inputs.push(input);
      const pending = guard.pendingFields.get(row.id);
      if (pending && pending.size > 0) {
        const differ = changedEventFields(
          rowFieldValues(row),
          eventFieldValues(input),
        ).filter((field) => pending.has(field));
        if (differ.length > 0) outcome.keptLocal.set(row.id, differ);
      }
      continue;
    }
    const merge = mergeEventFields({
      base: baseOf(row),
      local: rowFieldValues(row),
      remote: eventFieldValues(input),
      localFieldAt: row.fieldUpdatedAt ?? {},
      localPending: guard.pendingFields.get(row.id) ?? new Set(),
      remoteUpdatedAt: input.remoteUpdatedAt,
      now,
    });
    const next =
      merge.keepLocal.length > 0
        ? withLocalFields(input, row, merge.keepLocal)
        : input;
    outcome.inputs.push({ ...next, fieldUpdatedAt: merge.fieldUpdatedAt });
    if (merge.keepLocal.length > 0) {
      outcome.keptLocal.set(row.id, merge.keepLocal);
    }
    if (merge.lostLocal.length > 0) {
      outcome.lostLocal.push({
        eventId: row.id,
        fields: merge.lostLocal,
        lost: lostValues(row, merge.lostLocal),
        title: row.summary,
      });
    }
  }
  return outcome;
}

export type WriteOutcome = {
  upserted: string[];
  deleted: string[];
  lostLocal: MergeOutcome["lostLocal"];
  keptLocal: MergeOutcome["keptLocal"];
};

/**
 * 届いた予定をマージして DB に書き、変更履歴に記録する。書き戻しの結果や、競合のときに
 * 取り直した内容の書き込みに使う。ロックと guard は呼び出し側が取る。
 * 未送信のローカルの変更が負けた項目は、反映されなかった変更 (field_lost) として記録する
 * (取り込みと、書き戻しの 412 の統合のどちらもここを通る)。
 */
export async function writeRemoteEvents(
  tx: Tx,
  options: {
    account: AccountRow;
    calendar: CalendarRow;
    provider: CalendarProvider;
    guard: PendingEventGuard;
    events: readonly ResolvedRemoteEvent[];
    now: Date;
  },
): Promise<WriteOutcome> {
  const merged = await mergeRemoteEvents(tx, options);
  const result = await upsertCalendarEvents(
    tx,
    { userId: options.account.userId, calendarId: options.calendar.id },
    merged.inputs,
  );
  const deletedSet = new Set(result.deleted);
  const upserted = result.upserted.filter((id) => !deletedSet.has(id));
  await recordChanges(tx, options.account.userId, "event", "upsert", upserted);
  await recordChanges(
    tx,
    options.account.userId,
    "event",
    "delete",
    result.deleted,
  );
  for (const lost of merged.lostLocal) {
    await recordEventConflict(tx, {
      userId: options.account.userId,
      calendarId: options.calendar.id,
      eventId: lost.eventId,
      kind: "field_lost",
      fields: lost.fields,
      lost: lost.lost,
      title: lost.title,
      reason: "相手側で後から変更された内容になりました。",
    });
  }
  return {
    upserted,
    deleted: result.deleted,
    lostLocal: merged.lostLocal,
    keptLocal: merged.keptLocal,
  };
}

/**
 * 全件同期の仕上げで消してはいけない remoteId。書き戻し待ちの予定 (変更中・作成中) と、
 * その原本の remoteId。原本を消すと、remoteId が null の例外 (書き戻し待ち) まで
 * FK の cascade で消えるため、原本も残す。
 */
async function protectedRemoteIds(
  tx: Tx,
  calendarId: string,
  guard: PendingEventGuard,
): Promise<Set<string>> {
  const ids = [...new Set([...guard.pendingFields.keys(), ...guard.creating])];
  const result = new Set<string>();
  if (ids.length === 0) return result;
  const rows = await tx
    .select({ remoteId: events.remoteId, parentId: events.parentId })
    .from(events)
    .where(and(eq(events.calendarId, calendarId), inArray(events.id, ids)));
  const parentIds = new Set<string>();
  for (const row of rows) {
    if (row.remoteId !== null) result.add(row.remoteId);
    if (row.parentId !== null) parentIds.add(row.parentId);
  }
  if (parentIds.size > 0) {
    const parents = await tx
      .select({ remoteId: events.remoteId })
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendarId),
          inArray(events.id, [...parentIds]),
        ),
      );
    for (const parent of parents) {
      if (parent.remoteId !== null) result.add(parent.remoteId);
    }
  }
  return result;
}

export type IngestResult = WriteOutcome;

/**
 * 相手側で消えたが、書き戻し待ちなので消すのを見送った行に印を付ける (gone の決まりに使う)。
 * 値は、その前に相手側にあると確かめていた時刻 (calendar.lastSyncedAt は、この同期の前に
 * 最後まで成功した同期の時刻)。無ければ行の remoteUpdatedAt、それも無ければ 1970 年
 * (ローカルの変更を勝たせる)。既に印があれば早い方 (いまの値) を残す。
 */
async function markRemoteDeletionDeferred(
  tx: Tx,
  calendar: CalendarRow,
  where: { eventIds?: readonly string[]; remoteIds?: readonly string[] },
) {
  const conditions = [
    where.eventIds && where.eventIds.length > 0
      ? inArray(events.id, [...where.eventIds])
      : null,
    where.remoteIds && where.remoteIds.length > 0
      ? inArray(events.remoteId, [...where.remoteIds])
      : null,
  ].filter((value) => value !== null);
  if (conditions.length === 0) return;
  const before = calendar.lastSyncedAt?.toISOString() ?? null;
  for (const condition of conditions) {
    await tx
      .update(events)
      .set({
        remoteDeletedAfter: sql`coalesce(${before}::timestamptz, ${events.remoteUpdatedAt}, to_timestamp(0))`,
      })
      .where(
        and(
          eq(events.calendarId, calendar.id),
          isNull(events.remoteDeletedAfter),
          condition,
        ),
      );
  }
}

/**
 * 差分 1 ページを 1 トランザクションで取り込む。
 * - uid を省いた例外には原本の uid を補う。補えなければ次のページへ持ち越し、最後のページでも
 *   補えなければ捨てる (ログに残す)。
 * - 削除の書き戻し待ちの予定 (同じカレンダーのもの) は upsert しない。
 * - 相手側で消えた予定のうち、未送信のローカルの変更がある行は残す (書き戻しの gone の決まりに任せる)。
 *   残した行には remoteDeletedAfter を付ける。
 * - 届いた remoteId の既存の行のうち、今回届かなかった (uid, recurrenceId) の行は消す
 *   (CalDAV でリソースから消えた例外)。書き戻し待ちの行は残す。
 * - 全件 (delta.full) の最後のページでは、どのページにも出てこなかった remoteId の行を消す。
 *   書き戻し待ちの予定と、その原本と、delta.keptRemoteIds に入っていた remoteId は残す。
 * - 最後のページでは、calendars の syncToken / etag / lastSyncedAt / syncAttemptedAt / lastError を更新する。
 * seen は全件同期の間に出てきた remoteId を貯める入れ物、carry は uid を補えなかった例外を
 * 次のページへ持ち越す入れ物で、どちらも呼び出し側が同期 1 回ごとに作って渡す。
 */
export async function ingestEventDelta(
  db: Database,
  {
    account,
    calendar,
    provider,
    delta,
    seen,
    carry = [],
    now = new Date(),
    log = () => {},
  }: {
    account: AccountRow;
    calendar: CalendarRow;
    provider: CalendarProvider;
    delta: EventDelta;
    seen: Set<string>;
    carry?: RemoteEvent[];
    now?: Date;
    log?: (message: string) => void;
  },
): Promise<IngestResult> {
  const lastPage = delta.nextPageCursor === null;
  const dropped: RemoteEvent[] = [];
  const result = await db.transaction(async (tx) => {
    const guard = await loadPendingEventGuard(tx, account.id);
    for (const event of delta.events) seen.add(event.remoteId);
    for (const remoteId of delta.keptRemoteIds ?? []) seen.add(remoteId);
    const { resolved, unresolved } = await resolveRemoteUids(tx, calendar.id, [
      ...carry,
      ...delta.events,
    ]);
    carry.length = 0;
    if (lastPage) dropped.push(...unresolved);
    else carry.push(...unresolved);
    const incoming = resolved.filter(
      (event) => !isDeletePending(guard, calendar.id, event),
    );
    const pendingIds = new Set([
      ...guard.pendingFields.keys(),
      ...guard.creating,
    ]);

    // 相手側で消えた予定。未送信のローカルの変更がある行は残す。
    const deleted: string[] = [];
    const removed = delta.deletedRemoteIds.filter(
      (remoteId) => !isRemoteIdDeletePending(guard, calendar.id, remoteId),
    );
    if (removed.length > 0) {
      const rows = await tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.calendarId, calendar.id),
            inArray(events.remoteId, removed),
          ),
        );
      const keepEventIds = new Set(
        rows.map((row) => row.id).filter((id) => pendingIds.has(id)),
      );
      const removal = await deleteCalendarEventsByRemoteId(
        tx,
        calendar.id,
        removed,
        { keepEventIds },
      );
      deleted.push(...removal.deleted);
      await recordChanges(tx, account.userId, "event", "delete", deleted);
      await markRemoteDeletionDeferred(tx, calendar, {
        eventIds: [...keepEventIds],
      });
    }

    const written = await writeRemoteEvents(tx, {
      account,
      calendar,
      provider,
      guard,
      events: incoming,
      now,
    });
    deleted.push(...written.deleted);

    // CalDAV: リソースから消えた例外。
    const missing = await deleteCalendarEventsMissingFromResources(
      tx,
      calendar.id,
      resolved,
      { keepEventIds: pendingIds },
    );
    if (missing.deleted.length > 0) {
      deleted.push(...missing.deleted);
      await recordChanges(
        tx,
        account.userId,
        "event",
        "delete",
        missing.deleted,
      );
    }

    if (lastPage) {
      if (delta.full) {
        const keep = await protectedRemoteIds(tx, calendar.id, guard);
        const finish = await deleteCalendarEventsNotIn(
          tx,
          calendar.id,
          new Set([...seen, ...keep]),
        );
        deleted.push(...finish.deleted);
        await recordChanges(
          tx,
          account.userId,
          "event",
          "delete",
          finish.deleted,
        );
        await markRemoteDeletionDeferred(tx, calendar, {
          remoteIds: [...keep].filter((remoteId) => !seen.has(remoteId)),
        });
      }
      await tx
        .update(calendars)
        .set({
          syncToken: delta.nextSyncToken,
          ...(delta.nextEtag === undefined ? {} : { etag: delta.nextEtag }),
          lastSyncedAt: now,
          syncAttemptedAt: now,
          lastError: null,
        })
        .where(eq(calendars.id, calendar.id));
      // エラーの表示が消えるときだけ、カレンダーの変更として知らせる。
      if (calendar.lastError !== null) {
        await recordChanges(tx, account.userId, "calendar", "upsert", [
          calendar.id,
        ]);
      }
    }
    return { ...written, deleted };
  });
  for (const event of dropped) {
    log(
      `予定 ${event.remoteId} (${event.recurrenceId ?? ""}) は原本が見つからず uid を補えないので、取り込みませんでした`,
    );
  }
  for (const lost of result.lostLocal) {
    log(
      `予定 ${lost.eventId} の未送信の変更 (${lost.fields.join(", ")}) は、相手側のより新しい変更で上書きされました`,
    );
  }
  return result;
}
