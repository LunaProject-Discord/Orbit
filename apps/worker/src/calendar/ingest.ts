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
  deleteCalendarEventsNotIn,
  type EventWithExtras,
  events,
  findCalendarEvents,
  outbox,
  type RemoteEventInput,
  upsertCalendarEvents,
} from "@orbit/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { recordChanges, type Tx } from "../changes.js";
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

/** まだプロバイダへ反映していない予定の書き戻し。取り込みでこれに当たるものは上書きしない。 */
export type PendingEventGuard = {
  /** 変更を書き戻し中の予定 (events.id) と、その項目。作成中の予定は全項目。 */
  pendingFields: Map<string, Set<EventFieldName>>;
  /** 作成を書き戻し中の予定 (events.id)。 */
  creating: Set<string>;
  /** 削除を書き戻し中の予定の remoteId。 */
  deletedRemoteIds: Set<string>;
  /** 削除を書き戻し中の予定の (uid, recurrenceId)。 */
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
        const { target } = payload as EventDeletePayload;
        if (!target) break;
        if (target.remoteId) guard.deletedRemoteIds.add(target.remoteId);
        guard.deletedKeys.add(keyOf(target.uid, target.recurrenceId));
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

/** 削除を書き戻し中の予定 (と、削除中の原本の例外) なら true。 */
export function isDeletePending(guard: PendingEventGuard, event: RemoteEvent) {
  return (
    guard.deletedKeys.has(keyOf(event.uid, event.recurrenceId)) ||
    guard.deletedKeys.has(keyOf(event.uid, null))
  );
}

/** DB の行を、項目ごとの比べられる値にする。 */
export function rowFieldValues(row: EventWithExtras): EventFieldValues {
  return eventFieldValues(row);
}

/** 届いた予定の fields の項目を、DB の行の値で差し替える (ローカルの変更を残す)。 */
export function withLocalFields(
  input: RemoteEvent,
  row: EventWithExtras,
  fields: readonly EventFieldName[],
): RemoteEvent {
  const next: RemoteEvent = { ...input };
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

export type MergeOutcome = {
  /** upsertCalendarEvents に渡す入力。 */
  inputs: RemoteEventInput[];
  /** 未送信のローカルの変更が、相手側の新しい変更に負けて失われた項目。 */
  lostLocal: { eventId: string; fields: EventFieldName[] }[];
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
    events: readonly RemoteEvent[];
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
      outcome.lostLocal.push({ eventId: row.id, fields: merge.lostLocal });
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
 */
export async function writeRemoteEvents(
  tx: Tx,
  options: {
    account: AccountRow;
    calendar: CalendarRow;
    provider: CalendarProvider;
    guard: PendingEventGuard;
    events: readonly RemoteEvent[];
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
 * 差分 1 ページを 1 トランザクションで取り込む。
 * - 削除の書き戻し待ちの予定は upsert しない。
 * - 相手側で消えた予定のうち、未送信のローカルの変更がある行は残す (書き戻しの gone の決まりに任せる)。
 * - 全件 (delta.full) の最後のページでは、どのページにも出てこなかった remoteId の行を消す。
 *   書き戻し待ちの予定と、その原本は残す。
 * - 最後のページでは、calendars の syncToken / etag / lastSyncedAt / lastError を更新する。
 * seen は全件同期の間に出てきた remoteId を貯める入れ物で、呼び出し側が同期 1 回ごとに作って渡す。
 */
export async function ingestEventDelta(
  db: Database,
  {
    account,
    calendar,
    provider,
    delta,
    seen,
    now = new Date(),
    log = () => {},
  }: {
    account: AccountRow;
    calendar: CalendarRow;
    provider: CalendarProvider;
    delta: EventDelta;
    seen: Set<string>;
    now?: Date;
    log?: (message: string) => void;
  },
): Promise<IngestResult> {
  const result = await db.transaction(async (tx) => {
    const guard = await loadPendingEventGuard(tx, account.id);
    for (const event of delta.events) seen.add(event.remoteId);
    const incoming = delta.events.filter(
      (event) => !isDeletePending(guard, event),
    );

    // 相手側で消えた予定。未送信のローカルの変更がある行は残す。
    const deleted: string[] = [];
    const removed = delta.deletedRemoteIds.filter(
      (remoteId) => !guard.deletedRemoteIds.has(remoteId),
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
        rows
          .map((row) => row.id)
          .filter(
            (id) => guard.pendingFields.has(id) || guard.creating.has(id),
          ),
      );
      const removal = await deleteCalendarEventsByRemoteId(
        tx,
        calendar.id,
        removed,
        { keepEventIds },
      );
      deleted.push(...removal.deleted);
      await recordChanges(tx, account.userId, "event", "delete", deleted);
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

    if (delta.nextPageCursor === null) {
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
      }
      await tx
        .update(calendars)
        .set({
          syncToken: delta.nextSyncToken,
          ...(delta.nextEtag === undefined ? {} : { etag: delta.nextEtag }),
          lastSyncedAt: now,
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
  for (const lost of result.lostLocal) {
    log(
      `予定 ${lost.eventId} の未送信の変更 (${lost.fields.join(", ")}) は、相手側のより新しい変更で上書きされました`,
    );
  }
  return result;
}
