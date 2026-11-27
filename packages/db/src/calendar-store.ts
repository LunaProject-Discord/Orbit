import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema.js";
import {
  type CalendarReminder,
  calendars,
  eventAttendees,
  eventReminders,
  events,
} from "./schema.js";

/**
 * 同期で受け取った予定 (ICS の購読、祝日、CalDAV など) を、カレンダーの予定とそろえる。
 * 中身 (raw) の変わらない予定は触らない。
 */

/** 取り込む予定 (@orbit/core の ParsedEvent と同じ形)。 */
export type CalendarEventInput = {
  uid: string;
  recurrenceId: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  busy: boolean;
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  endTimeZone: string | null;
  rrule: string | null;
  rdates: string[] | null;
  exdates: string[] | null;
  organizer: { email: string; name?: string } | null;
  attendees: {
    email: string;
    name: string | null;
    role: "chair" | "required" | "optional" | "non_participant";
    status:
      | "needs_action"
      | "accepted"
      | "declined"
      | "tentative"
      | "delegated";
    /** 利用者自身なら true。省けば false。 */
    self?: boolean;
  }[];
  sequence: number;
  conferenceUrl: string | null;
  remoteUpdatedAt: string | null;
  reminders: CalendarReminder[] | null;
  raw: string;
};

type Executor = Pick<
  NodePgDatabase<typeof schema>,
  "select" | "insert" | "update" | "delete"
>;

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const keyOf = (uid: string, recurrenceId: string | null) =>
  `${uid}\u0000${recurrenceId ?? ""}`;

function columns(input: CalendarEventInput, parentId: string | null) {
  return {
    uid: input.uid,
    recurrenceId: input.recurrenceId,
    parentId,
    summary: input.summary,
    location: input.location,
    description: input.description,
    status: input.status,
    busy: input.busy,
    allDay: input.allDay,
    startAt: input.startAt ? new Date(input.startAt) : null,
    endAt: input.endAt ? new Date(input.endAt) : null,
    startDate: input.startDate,
    endDate: input.endDate,
    startTimeZone: input.startTimeZone,
    endTimeZone: input.endTimeZone,
    rrule: input.rrule,
    rdates: input.rdates,
    exdates: input.exdates,
    organizer: input.organizer,
    sequence: input.sequence,
    conferenceUrl: input.conferenceUrl,
    useDefaultReminders: input.reminders === null,
    remoteUpdatedAt: input.remoteUpdatedAt
      ? new Date(input.remoteUpdatedAt)
      : null,
    raw: input.raw,
  };
}

/**
 * カレンダーの予定を inputs と同じにする。返すのは、作った・変えた予定と、消した予定の ID
 * (変更履歴に記録するため)。トランザクションの中で呼ぶ。
 */
export async function replaceCalendarEvents(
  tx: Executor,
  { userId, calendarId }: { userId: string; calendarId: string },
  inputs: readonly CalendarEventInput[],
): Promise<{ upserted: string[]; deleted: string[] }> {
  const existing = await tx
    .select({
      id: events.id,
      uid: events.uid,
      recurrenceId: events.recurrenceId,
      parentId: events.parentId,
      raw: events.raw,
    })
    .from(events)
    .where(eq(events.calendarId, calendarId));
  const byKey = new Map(
    existing.map((row) => [keyOf(row.uid, row.recurrenceId), row]),
  );
  const wanted = new Map<string, CalendarEventInput>();
  for (const input of inputs)
    wanted.set(keyOf(input.uid, input.recurrenceId), input);

  // 原本 (と繰り返さない予定) を先に入れ、例外の parentId に使う。
  const masterIds = new Map<string, string>();
  const upserted: string[] = [];
  const ordered = [...wanted.values()].sort(
    (a, b) => Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null),
  );

  const inserts: { input: CalendarEventInput; parentId: string | null }[] = [];
  const flushInserts = async () => {
    for (const batch of chunks(inserts.splice(0))) {
      const rows = await tx
        .insert(events)
        .values(
          batch.map(({ input, parentId }) => ({
            userId,
            calendarId,
            ...columns(input, parentId),
          })),
        )
        .returning({
          id: events.id,
          uid: events.uid,
          recurrenceId: events.recurrenceId,
        });
      const reminderRows: (typeof eventReminders.$inferInsert)[] = [];
      const attendeeRows: (typeof eventAttendees.$inferInsert)[] = [];
      for (const row of rows) {
        if (row.recurrenceId === null) masterIds.set(row.uid, row.id);
        upserted.push(row.id);
        const input = wanted.get(keyOf(row.uid, row.recurrenceId));
        if (!input) continue;
        for (const value of input.reminders ?? []) {
          reminderRows.push({ eventId: row.id, ...value });
        }
        attendeeRows.push(...attendeeValues(row.id, input));
      }
      for (const part of chunks(reminderRows)) {
        await tx.insert(eventReminders).values(part);
      }
      for (const part of chunks(attendeeRows)) {
        await tx.insert(eventAttendees).values(part);
      }
    }
  };

  let flushedMasters = false;
  for (const input of ordered) {
    if (input.recurrenceId !== null && !flushedMasters) {
      await flushInserts();
      flushedMasters = true;
    }
    const parentId =
      input.recurrenceId === null ? null : (masterIds.get(input.uid) ?? null);
    const row = byKey.get(keyOf(input.uid, input.recurrenceId));
    if (!row) {
      inserts.push({ input, parentId });
      continue;
    }
    if (input.recurrenceId === null) masterIds.set(input.uid, row.id);
    if (row.raw === input.raw && row.parentId === parentId) continue;
    await tx
      .update(events)
      .set(columns(input, parentId))
      .where(eq(events.id, row.id));
    await replaceExtras(tx, row.id, input);
    upserted.push(row.id);
  }
  await flushInserts();

  const deleted = existing
    .filter((row) => !wanted.has(keyOf(row.uid, row.recurrenceId)))
    .map((row) => row.id);
  for (const batch of chunks(deleted)) {
    await tx
      .delete(events)
      .where(and(eq(events.calendarId, calendarId), inArray(events.id, batch)));
  }
  return { upserted, deleted };
}

async function replaceExtras(
  tx: Executor,
  eventId: string,
  input: CalendarEventInput,
) {
  await tx.delete(eventReminders).where(eq(eventReminders.eventId, eventId));
  if (input.reminders && input.reminders.length > 0) {
    await tx
      .insert(eventReminders)
      .values(input.reminders.map((value) => ({ eventId, ...value })));
  }
  await tx.delete(eventAttendees).where(eq(eventAttendees.eventId, eventId));
  const attendees = attendeeValues(eventId, input);
  if (attendees.length > 0) await tx.insert(eventAttendees).values(attendees);
}

function attendeeValues(
  eventId: string,
  input: CalendarEventInput,
): (typeof eventAttendees.$inferInsert)[] {
  return input.attendees.map((value) => ({
    eventId,
    email: value.email,
    name: value.name,
    role: value.role,
    status: value.status,
    self: value.self ?? false,
  }));
}

/* ------------------------------------------------------------------ */
/* プロバイダ (Google、Microsoft、CalDAV) との差分同期                    */
/* ------------------------------------------------------------------ */

/** プロバイダから受け取った予定 1 行分。CalDAV は原本と例外が同じ remoteId と etag を持つ。 */
export type RemoteEventInput = CalendarEventInput & {
  remoteId: string;
  etag: string | null;
  /** 例外のとき、原本の remoteId (Google の recurringEventId、Graph の seriesMasterId)。 */
  parentRemoteId?: string | null;
  /** 指定すれば置き換える。省けば、新規は null、既存は触らない。 */
  fieldUpdatedAt?: Record<string, string>;
};

/** プロバイダから受け取ったカレンダー 1 つ分。 */
export type AccountCalendarInput = {
  remoteId: string;
  name: string;
  description: string | null;
  /** プロバイダの色 "#rrggbb"。新しく作るときと、いまの色が null のときだけ使う。 */
  color: string | null;
  timeZone: string | null;
  readOnly: boolean;
  url: string | null;
  defaultReminders: CalendarReminder[] | null;
  /** 指定すれば、いまの providerState に浅く重ねる (指定しない鍵は残す)。null なら消す。 */
  providerState?: Record<string, unknown> | null;
};

/** 予定の行と、その参加者とリマインダー。 */
export type EventWithExtras = typeof events.$inferSelect & {
  attendees: (typeof eventAttendees.$inferSelect)[];
  reminders: CalendarReminder[];
};

type ProviderCalendarSource = "google" | "microsoft" | "caldav";

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * アカウントのカレンダー一覧をそろえる。name、説明、タイムゾーン、readOnly、url、既定のリマインダーを
 * 更新し、利用者の設定 (visible、sortOrder、pollIntervalSeconds) と同期の位置 (syncToken など) は
 * 触らない。色は利用者が選んだ色と見分けられないので、いまの色が null のときだけプロバイダの色を入れる。
 * 一覧から消えたカレンダーは削除する (予定は FK の cascade で消える)。
 * 返すのは、作った・変えたカレンダーと、消したカレンダーの ID。
 */
export async function upsertAccountCalendars(
  tx: Executor,
  {
    userId,
    accountId,
    source,
  }: { userId: string; accountId: string; source: ProviderCalendarSource },
  remote: readonly AccountCalendarInput[],
): Promise<{ upserted: string[]; deleted: string[] }> {
  const existing = await tx
    .select()
    .from(calendars)
    .where(
      and(eq(calendars.accountId, accountId), eq(calendars.source, source)),
    );
  const byRemoteId = new Map(
    existing.flatMap((row) =>
      row.remoteId === null ? [] : [[row.remoteId, row] as const],
    ),
  );
  const wanted = new Map<string, AccountCalendarInput>();
  for (const input of remote) wanted.set(input.remoteId, input);

  const upserted: string[] = [];
  const inserts: (typeof calendars.$inferInsert)[] = [];
  for (const input of wanted.values()) {
    const row = byRemoteId.get(input.remoteId);
    if (!row) {
      inserts.push({
        userId,
        accountId,
        source,
        remoteId: input.remoteId,
        name: input.name,
        description: input.description,
        color: input.color,
        timeZone: input.timeZone,
        readOnly: input.readOnly,
        url: input.url,
        defaultReminders: input.defaultReminders,
        providerState: input.providerState ?? null,
      });
      continue;
    }
    const providerState =
      input.providerState === undefined
        ? row.providerState
        : input.providerState === null
          ? null
          : { ...(row.providerState ?? {}), ...input.providerState };
    const next = {
      name: input.name,
      description: input.description,
      color: row.color ?? input.color,
      timeZone: input.timeZone,
      readOnly: input.readOnly,
      url: input.url,
      defaultReminders: input.defaultReminders,
      providerState,
    };
    const changed =
      next.name !== row.name ||
      next.description !== row.description ||
      next.color !== row.color ||
      next.timeZone !== row.timeZone ||
      next.readOnly !== row.readOnly ||
      next.url !== row.url ||
      !sameJson(next.defaultReminders, row.defaultReminders) ||
      !sameJson(next.providerState, row.providerState);
    if (!changed) continue;
    await tx.update(calendars).set(next).where(eq(calendars.id, row.id));
    upserted.push(row.id);
  }
  for (const batch of chunks(inserts)) {
    const rows = await tx
      .insert(calendars)
      .values(batch)
      .returning({ id: calendars.id });
    upserted.push(...rows.map((row) => row.id));
  }

  const deleted = existing
    .filter((row) => row.remoteId === null || !wanted.has(row.remoteId))
    .map((row) => row.id);
  for (const batch of chunks(deleted)) {
    await tx.delete(calendars).where(inArray(calendars.id, batch));
  }
  return { upserted, deleted };
}

/**
 * 取り込む前に、いまの行を読む (worker がマージに使う)。remoteId が一致する行と、uid が一致する行
 * (原本と例外のすべて) を返す。
 */
export async function findCalendarEvents(
  tx: Executor,
  calendarId: string,
  keys: { remoteIds: readonly string[]; uids: readonly string[] },
): Promise<EventWithExtras[]> {
  const rows = await selectEvents(tx, calendarId, keys);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const attendees = new Map<string, (typeof eventAttendees.$inferSelect)[]>();
  const reminders = new Map<string, CalendarReminder[]>();
  for (const batch of chunks(ids)) {
    for (const row of await tx
      .select()
      .from(eventAttendees)
      .where(inArray(eventAttendees.eventId, batch))) {
      const list = attendees.get(row.eventId) ?? [];
      list.push(row);
      attendees.set(row.eventId, list);
    }
    for (const row of await tx
      .select()
      .from(eventReminders)
      .where(inArray(eventReminders.eventId, batch))) {
      const list = reminders.get(row.eventId) ?? [];
      list.push({ method: row.method, minutes: row.minutes });
      reminders.set(row.eventId, list);
    }
  }
  return rows.map((row) => ({
    ...row,
    attendees: attendees.get(row.id) ?? [],
    reminders: reminders.get(row.id) ?? [],
  }));
}

/** remoteId か uid が一致する行を読む。 */
async function selectEvents(
  tx: Executor,
  calendarId: string,
  keys: { remoteIds: readonly string[]; uids: readonly string[] },
) {
  const rows = new Map<string, typeof events.$inferSelect>();
  for (const batch of chunks([...new Set(keys.remoteIds)])) {
    for (const row of await tx
      .select()
      .from(events)
      .where(
        and(eq(events.calendarId, calendarId), inArray(events.remoteId, batch)),
      ))
      rows.set(row.id, row);
  }
  for (const batch of chunks([...new Set(keys.uids)])) {
    for (const row of await tx
      .select()
      .from(events)
      .where(
        and(eq(events.calendarId, calendarId), inArray(events.uid, batch)),
      ))
      rows.set(row.id, row);
  }
  return [...rows.values()];
}

/**
 * 差分の upsert。全件そろえはしない。突き合わせのキーは一意の索引と同じ (uid, recurrenceId)。
 * etag、raw、parentId、remoteId が同じ行は触らない。相手側で UID が変わった (remoteId だけ一致する)
 * 行は先に消す。原本を入れたら、先に届いていた例外 (孤児) の parentId を付け直す。
 * 返すのは、作った・変えた行 (引き取った孤児を含む) と、UID が変わって消した行 (子を含む) の ID。
 */
export async function upsertCalendarEvents(
  tx: Executor,
  { userId, calendarId }: { userId: string; calendarId: string },
  inputs: readonly RemoteEventInput[],
): Promise<{ upserted: string[]; deleted: string[] }> {
  const wanted = new Map<string, RemoteEventInput>();
  for (const input of inputs)
    wanted.set(keyOf(input.uid, input.recurrenceId), input);
  if (wanted.size === 0) return { upserted: [], deleted: [] };
  const list = [...wanted.values()];

  const existing = await selectEvents(tx, calendarId, {
    remoteIds: list.map((input) => input.remoteId),
    uids: list.map((input) => input.uid),
  });

  // 相手側で UID が変わった行: remoteId は一致するが uid が違い、今回の入力のどれにも当たらない。
  const uidByRemoteId = new Map(
    list.map((input) => [input.remoteId, input.uid]),
  );
  const stale = existing.filter((row) => {
    if (row.remoteId === null) return false;
    const uid = uidByRemoteId.get(row.remoteId);
    return (
      uid !== undefined &&
      uid !== row.uid &&
      !wanted.has(keyOf(row.uid, row.recurrenceId))
    );
  });
  const deleted = await deleteEventRows(
    tx,
    calendarId,
    stale.map((row) => row.id),
  );
  const deletedSet = new Set(deleted);
  const byKey = new Map(
    existing
      .filter((row) => !deletedSet.has(row.id))
      .map((row) => [keyOf(row.uid, row.recurrenceId), row]),
  );

  const upserted = new Set<string>();
  // 今回の呼び出しで入れた・確かめた原本 (uid → id、remoteId → id)。
  const masterByUid = new Map<string, string>();
  const masterByRemoteId = new Map<string, string>();

  const writeRows = async (
    batch: { input: RemoteEventInput; parentId: string | null }[],
  ) => {
    const inserts: typeof batch = [];
    for (const item of batch) {
      const { input, parentId } = item;
      const row = byKey.get(keyOf(input.uid, input.recurrenceId));
      if (!row) {
        inserts.push(item);
        continue;
      }
      if (input.recurrenceId === null) {
        masterByUid.set(input.uid, row.id);
        masterByRemoteId.set(input.remoteId, row.id);
      }
      if (
        row.etag === input.etag &&
        row.raw === input.raw &&
        row.parentId === parentId &&
        row.remoteId === input.remoteId
      )
        continue;
      await tx
        .update(events)
        .set({
          ...columns(input, parentId),
          remoteId: input.remoteId,
          etag: input.etag,
          ...(input.fieldUpdatedAt === undefined
            ? {}
            : { fieldUpdatedAt: input.fieldUpdatedAt }),
        })
        .where(eq(events.id, row.id));
      await replaceExtras(tx, row.id, input);
      upserted.add(row.id);
    }
    for (const part of chunks(inserts)) {
      const rows = await tx
        .insert(events)
        .values(
          part.map(({ input, parentId }) => ({
            userId,
            calendarId,
            ...columns(input, parentId),
            remoteId: input.remoteId,
            etag: input.etag,
            fieldUpdatedAt: input.fieldUpdatedAt ?? null,
          })),
        )
        .returning({
          id: events.id,
          uid: events.uid,
          recurrenceId: events.recurrenceId,
        });
      const reminderRows: (typeof eventReminders.$inferInsert)[] = [];
      const attendeeRows: (typeof eventAttendees.$inferInsert)[] = [];
      for (const row of rows) {
        upserted.add(row.id);
        const input = wanted.get(keyOf(row.uid, row.recurrenceId));
        if (!input) continue;
        if (row.recurrenceId === null) {
          masterByUid.set(row.uid, row.id);
          masterByRemoteId.set(input.remoteId, row.id);
        }
        for (const value of input.reminders ?? []) {
          reminderRows.push({ eventId: row.id, ...value });
        }
        attendeeRows.push(...attendeeValues(row.id, input));
      }
      for (const chunk of chunks(reminderRows)) {
        await tx.insert(eventReminders).values(chunk);
      }
      for (const chunk of chunks(attendeeRows)) {
        await tx.insert(eventAttendees).values(chunk);
      }
    }
  };

  // 1. 原本と繰り返さない予定。
  const masters = list.filter((input) => input.recurrenceId === null);
  await writeRows(masters.map((input) => ({ input, parentId: null })));

  // 2. 例外。親は、今回の原本 → parentRemoteId の原本 → 同じ uid の原本 の順に探す。
  const exceptions = list.filter((input) => input.recurrenceId !== null);
  if (exceptions.length > 0) {
    const parentRemoteIds = [
      ...new Set(
        exceptions.flatMap((input) =>
          input.parentRemoteId && !masterByRemoteId.has(input.parentRemoteId)
            ? [input.parentRemoteId]
            : [],
        ),
      ),
    ];
    for (const batch of chunks(parentRemoteIds)) {
      const rows = await tx
        .select({ id: events.id, remoteId: events.remoteId })
        .from(events)
        .where(
          and(
            eq(events.calendarId, calendarId),
            isNull(events.recurrenceId),
            inArray(events.remoteId, batch),
          ),
        );
      for (const row of rows) {
        if (row.remoteId !== null && !masterByRemoteId.has(row.remoteId))
          masterByRemoteId.set(row.remoteId, row.id);
      }
    }
    await writeRows(
      exceptions.map((input) => ({
        input,
        parentId:
          masterByUid.get(input.uid) ??
          (input.parentRemoteId
            ? masterByRemoteId.get(input.parentRemoteId)
            : undefined) ??
          byKey.get(keyOf(input.uid, null))?.id ??
          null,
      })),
    );
  }

  // 3. 孤児の引き取り: 今回の原本と同じ uid で、parentId が原本を指していない例外。
  const masterUids = [...new Set(masters.map((input) => input.uid))];
  for (const batch of chunks(masterUids)) {
    const children = await tx
      .select({ id: events.id, uid: events.uid, parentId: events.parentId })
      .from(events)
      .where(
        and(
          eq(events.calendarId, calendarId),
          isNotNull(events.recurrenceId),
          inArray(events.uid, batch),
        ),
      );
    const adopt = new Map<string, string[]>();
    for (const child of children) {
      const masterId = masterByUid.get(child.uid);
      if (!masterId || child.parentId === masterId) continue;
      adopt.set(masterId, [...(adopt.get(masterId) ?? []), child.id]);
    }
    for (const [masterId, ids] of adopt) {
      await tx
        .update(events)
        .set({ parentId: masterId })
        .where(inArray(events.id, ids));
      for (const id of ids) upserted.add(id);
    }
  }

  return { upserted: [...upserted], deleted };
}

/**
 * 行と、その子 (例外) を消す。子は FK の cascade で消えるが、変更履歴に載せるため先に ID を読む。
 * keep にある行は消さず、keep にある子は親を消す前に parentId を外して残す。返すのは消した全行の ID。
 */
async function deleteEventRows(
  tx: Executor,
  calendarId: string,
  ids: readonly string[],
  keep: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const targets = [...new Set(ids)].filter((id) => !keep.has(id));
  if (targets.length === 0) return [];
  const deleted = new Set(targets);
  for (const batch of chunks(targets)) {
    const children = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.calendarId, calendarId), inArray(events.parentId, batch)),
      );
    const kept = children
      .filter((child) => keep.has(child.id))
      .map((child) => child.id);
    for (const part of chunks(kept)) {
      await tx
        .update(events)
        .set({ parentId: null })
        .where(inArray(events.id, part));
    }
    for (const child of children)
      if (!keep.has(child.id)) deleted.add(child.id);
  }
  for (const batch of chunks(targets)) {
    await tx
      .delete(events)
      .where(and(eq(events.calendarId, calendarId), inArray(events.id, batch)));
  }
  return [...deleted];
}

/**
 * remoteId の一致する行 (CalDAV は原本と例外の全部) と、その子を消す。keepEventIds にある行は
 * 消さない (子なら parentId を外して残す)。返すのは消した全行の ID。
 */
export async function deleteCalendarEventsByRemoteId(
  tx: Executor,
  calendarId: string,
  remoteIds: readonly string[],
  options: { keepEventIds?: ReadonlySet<string> } = {},
): Promise<{ deleted: string[] }> {
  const ids: string[] = [];
  for (const batch of chunks([...new Set(remoteIds)])) {
    const rows = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.calendarId, calendarId), inArray(events.remoteId, batch)),
      );
    ids.push(...rows.map((row) => row.id));
  }
  return {
    deleted: await deleteEventRows(tx, calendarId, ids, options.keepEventIds),
  };
}

/**
 * 全件同期の仕上げ。seenRemoteIds に無い remoteId の行と、その子を消す。remoteId が null の行
 * (作成の書き戻し待ち) は残す。ただし、消す原本の子は remoteId が null でも cascade で消える。
 */
export async function deleteCalendarEventsNotIn(
  tx: Executor,
  calendarId: string,
  seenRemoteIds: ReadonlySet<string>,
): Promise<{ deleted: string[] }> {
  const rows = await tx
    .select({ id: events.id, remoteId: events.remoteId })
    .from(events)
    .where(and(eq(events.calendarId, calendarId), isNotNull(events.remoteId)));
  const ids = rows
    .filter((row) => row.remoteId !== null && !seenRemoteIds.has(row.remoteId))
    .map((row) => row.id);
  return { deleted: await deleteEventRows(tx, calendarId, ids) };
}

/**
 * カレンダーの予定の remoteId → etag。CalDAV のように 1 つの remoteId に複数の行があるときは、
 * 原本の etag を返す。
 */
export async function listEventEtags(
  tx: Executor,
  calendarId: string,
): Promise<Map<string, string | null>> {
  const rows = await tx
    .select({
      remoteId: events.remoteId,
      etag: events.etag,
      recurrenceId: events.recurrenceId,
    })
    .from(events)
    .where(and(eq(events.calendarId, calendarId), isNotNull(events.remoteId)));
  const result = new Map<string, string | null>();
  for (const row of rows) {
    if (row.remoteId === null) continue;
    if (row.recurrenceId === null || !result.has(row.remoteId))
      result.set(row.remoteId, row.etag);
  }
  return result;
}
