import {
  EVENT_FIELD_NAMES,
  EVENT_OUTBOX_KINDS,
  type EventCreatePayload,
  type EventDeletePayload,
  type EventOutboxRef,
  type EventRespondPayload,
  type EventUpdatePayload,
} from "@orbit/core";
import {
  calendars,
  type Database,
  deleteCalendarEventsByRemoteId,
  events,
  findCalendarEvents,
  outbox,
} from "@orbit/db";
import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import { recordChanges } from "../changes.js";
import {
  isDeletePending,
  loadPendingEventGuard,
  lockCalendarAccount,
  writeRemoteEvents,
} from "./ingest.js";
import {
  type AccountRow,
  CalendarAuthError,
  CalendarNotImplementedError,
  type CalendarProvider,
  type CalendarRow,
  type EventSnapshot,
  type EventWrite,
  type ProviderContext,
  type RemoteEvent,
  type RemoteEventRef,
  type WriteResult,
} from "./provider.js";

/** 一時的な失敗でやり直す回数の上限。超えたら失敗として扱う (メールの outbox と同じ)。 */
const MAX_ATTEMPTS = 5;
/** 反映済みの記録を残す期間 (メールの outbox と同じ)。 */
const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;
/** 書き込みの競合 (conflict) を、取り直してやり直す回数の上限。 */
export const MAX_CONFLICT_RETRIES = 3;

type OutboxRow = typeof outbox.$inferSelect;
type OperationResult = { ok: true } | { ok: false; reason: string };

export type EventOutboxDeps = {
  db: Database;
  account: AccountRow;
  provider: CalendarProvider;
  ctx: ProviderContext;
  log: (message: string) => void;
  now?: () => Date;
};

/**
 * アカウントの予定の書き戻し (event_*) を、受け付けた順にプロバイダへ反映する。
 * 行と状態の扱いはメールの processOutbox と同じ: 一時的な失敗では例外を投げて止まり
 * (順番を保つため後続も実行しない)、次の周回で続きからやり直す。
 * 認証の失敗 (CalendarAuthError) と停止は、操作のせいではないので回数に数えずに投げる。
 */
export async function processEventOutbox(
  deps: EventOutboxDeps,
): Promise<{ done: number; failed: number }> {
  const { db, account } = deps;
  const rows = await db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, account.id),
        inArray(outbox.kind, [...EVENT_OUTBOX_KINDS]),
        inArray(outbox.status, ["pending", "processing"]),
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
  let done = 0;
  let failed = 0;

  for (const listed of rows) {
    // 前の行の結果で payload が書き換わっていることがある (削除の target など)。
    // API に取り消された行は飛ばす。
    const [row] = await db
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.id, listed.id),
          inArray(outbox.status, ["pending", "processing"]),
        ),
      );
    if (!row) continue;
    await db
      .update(outbox)
      .set({ status: "processing", attempts: row.attempts + 1 })
      .where(eq(outbox.id, row.id));
    let result: OperationResult;
    try {
      result = await applyEventOperation(deps, row);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (
        error instanceof CalendarAuthError ||
        error instanceof CalendarNotImplementedError ||
        deps.ctx.signal.aborted
      ) {
        await db
          .update(outbox)
          .set({ status: "pending", attempts: row.attempts, lastError: reason })
          .where(eq(outbox.id, row.id));
        throw error;
      }
      if (row.attempts + 1 < MAX_ATTEMPTS) {
        await db
          .update(outbox)
          .set({ status: "pending", lastError: reason })
          .where(eq(outbox.id, row.id));
        throw error;
      }
      result = { ok: false, reason };
    }
    if (result.ok) {
      await db
        .update(outbox)
        .set({ status: "done", lastError: null })
        .where(eq(outbox.id, row.id));
      done++;
      continue;
    }
    failed++;
    await failEventOperation(deps, row, result.reason);
  }

  await db
    .delete(outbox)
    .where(
      and(
        eq(outbox.accountId, account.id),
        inArray(outbox.kind, [...EVENT_OUTBOX_KINDS]),
        inArray(outbox.status, ["done", "failed"]),
        lt(outbox.updatedAt, new Date(Date.now() - KEEP_DONE_MS)),
      ),
    );
  return { done, failed };
}

function nowOf(deps: EventOutboxDeps) {
  return deps.now?.() ?? new Date();
}

async function loadCalendar(
  deps: EventOutboxDeps,
  calendarId: string,
): Promise<CalendarRow | null> {
  const [row] = await deps.db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.id, calendarId),
        eq(calendars.accountId, deps.account.id),
      ),
    );
  return row ?? null;
}

type Snapshot = {
  event: EventSnapshot;
  master: EventSnapshot | null;
  exceptions: EventSnapshot[];
};

/** 予定のいまの状態を、原本と例外も合わせて読む。無ければ null。 */
async function loadSnapshot(
  deps: EventOutboxDeps,
  calendarId: string,
  eventId: string,
): Promise<Snapshot | null> {
  const [row] = await deps.db
    .select({ uid: events.uid })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.calendarId, calendarId)));
  if (!row) return null;
  const rows = await findCalendarEvents(deps.db, calendarId, {
    remoteIds: [],
    uids: [row.uid],
  });
  const event = rows.find((item) => item.id === eventId);
  if (!event) return null;
  const master =
    event.parentId === null
      ? null
      : (rows.find((item) => item.id === event.parentId) ?? null);
  const exceptions =
    event.recurrenceId === null
      ? rows.filter((item) => item.parentId === event.id)
      : [];
  return { event, master, exceptions };
}

/** 予定の相手側での所在。remoteId が無ければ null。 */
function refOf(snapshot: Snapshot): RemoteEventRef | null {
  const { event, master } = snapshot;
  if (event.remoteId === null) return null;
  return {
    remoteId: event.remoteId,
    etag: event.etag,
    uid: event.uid,
    recurrenceId: event.recurrenceId,
    parentRemoteId: master?.remoteId ?? null,
  };
}

function refFromOutbox(target: EventOutboxRef): RemoteEventRef | null {
  if (target.remoteId === null) return null;
  return {
    remoteId: target.remoteId,
    etag: target.etag,
    uid: target.uid,
    recurrenceId: target.recurrenceId,
    parentRemoteId: target.parentRemoteId,
  };
}

/** 取り直した予定から、ref の予定 1 行を探す。 */
function findRemote(
  list: readonly RemoteEvent[],
  ref: Pick<RemoteEventRef, "uid" | "recurrenceId" | "remoteId">,
): RemoteEvent | null {
  return (
    list.find(
      (event) =>
        event.uid === ref.uid && event.recurrenceId === ref.recurrenceId,
    ) ??
    list.find(
      (event) =>
        event.remoteId === ref.remoteId &&
        event.recurrenceId === ref.recurrenceId,
    ) ??
    null
  );
}

/**
 * 書き戻しの結果 (相手側の姿) を DB に書く。outboxId の行は反映し終えたものとして数えず、
 * ほかの書き戻し待ちの項目だけローカルを残す。
 * target は書き込んだ予定 (events.id と回)。その予定の削除が後ろに積まれていれば
 * (書き込みの実行中に API で消された)、結果は行に書かず (消した行を戻さない)、
 * 削除の payload の target に相手側の remoteId と etag を書き込んで、削除がそれを使えるようにする。
 * rename は、相手側が UID を付け替えたときの元の uid (行の uid を先に書き換えて、
 * 同じ行に remoteId が付くようにする)。
 */
async function applyWriteResult(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  outboxId: string,
  remote: readonly RemoteEvent[],
  target: { eventId: string; recurrenceId: string | null } | null,
  rename?: { fromUid: string },
) {
  await deps.db.transaction(async (tx) => {
    const guard = await loadPendingEventGuard(tx, deps.account.id, [outboxId]);
    const primary =
      (target &&
        remote.find((event) => event.recurrenceId === target.recurrenceId)) ??
      remote[0] ??
      null;
    if (target) {
      const deletes = await tx
        .select({ id: outbox.id, payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            eq(outbox.accountId, deps.account.id),
            eq(outbox.kind, "event_delete"),
            inArray(outbox.status, ["pending", "processing"]),
            ne(outbox.id, outboxId),
          ),
        );
      const mine = deletes.filter(
        (row) =>
          (row.payload as EventDeletePayload).target?.eventId ===
          target.eventId,
      );
      if (mine.length > 0) {
        for (const row of mine) {
          const payload = row.payload as EventDeletePayload;
          const next: EventDeletePayload = {
            ...payload,
            target: {
              ...payload.target,
              remoteId: payload.target.remoteId ?? primary?.remoteId ?? null,
              etag: primary?.etag ?? payload.target.etag,
              uid: primary?.uid ?? payload.target.uid,
            },
          };
          await tx
            .update(outbox)
            .set({ payload: next as unknown as Record<string, unknown> })
            .where(eq(outbox.id, row.id));
        }
        return;
      }
    }
    if (rename && primary && primary.uid !== rename.fromUid) {
      // 原本の uid を変えると、例外も同じ uid にそろえる (uid は原本と例外で同じ値)。
      await tx
        .update(events)
        .set({ uid: primary.uid })
        .where(
          and(
            eq(events.calendarId, calendar.id),
            eq(events.uid, rename.fromUid),
          ),
        );
    }
    await writeRemoteEvents(tx, {
      account: deps.account,
      calendar,
      provider: deps.provider,
      guard,
      // 削除の書き戻し待ちの予定は書かない (消した行を戻さない)。
      events: remote.filter((event) => !isDeletePending(guard, event)),
      now: nowOf(deps),
    });
  });
}

/** 行を消し (例外も含む)、変更履歴に記録する。 */
async function deleteLocal(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  remoteId: string,
) {
  await deps.db.transaction(async (tx) => {
    await lockCalendarAccount(tx, deps.account.id);
    const { deleted } = await deleteCalendarEventsByRemoteId(tx, calendar.id, [
      remoteId,
    ]);
    await recordChanges(tx, deps.account.userId, "event", "delete", deleted);
  });
}

/** 1 行をプロバイダへ反映する。一時的な失敗は例外を投げる。 */
async function applyEventOperation(
  deps: EventOutboxDeps,
  row: OutboxRow,
): Promise<OperationResult> {
  switch (row.kind) {
    case "event_create":
      return applyCreate(deps, row, row.payload as EventCreatePayload);
    case "event_update":
      return applyUpdate(deps, row, row.payload as EventUpdatePayload);
    case "event_delete":
      return applyDelete(deps, row, row.payload as EventDeletePayload);
    case "event_respond":
      return applyRespond(deps, row, row.payload as EventRespondPayload);
    default:
      return { ok: false, reason: `未対応の操作です: ${row.kind}` };
  }
}

async function applyCreate(
  deps: EventOutboxDeps,
  row: OutboxRow,
  payload: EventCreatePayload,
): Promise<OperationResult> {
  const calendar = await loadCalendar(deps, payload.calendarId);
  // カレンダーや予定が消えていれば、作るものが無い (削除は後続の行で相殺済み)。
  if (!calendar) return { ok: true };
  const snapshot = await loadSnapshot(deps, calendar.id, payload.eventId);
  if (!snapshot) return { ok: true };
  // 前回の実行で作成まで済んでいた (結果の書き込みの後に止まった)。
  if (snapshot.event.remoteId !== null) return { ok: true };
  const result = await deps.provider.createEvent(deps.ctx, calendar, {
    ...snapshot,
    fields: [...EVENT_FIELD_NAMES],
  });
  return finishWrite(deps, calendar, row, snapshot, result, "作成");
}

/** 書き込みの結果を DB に反映する (ok 以外は失敗の理由にする)。 */
async function finishWrite(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  row: OutboxRow,
  snapshot: Snapshot,
  result: WriteResult,
  label: string,
): Promise<OperationResult> {
  switch (result.status) {
    case "ok":
      await applyWriteResult(
        deps,
        calendar,
        row.id,
        result.events,
        {
          eventId: snapshot.event.id,
          recurrenceId: snapshot.event.recurrenceId,
        },
        { fromUid: snapshot.event.uid },
      );
      return { ok: true };
    case "rejected":
      return { ok: false, reason: result.reason };
    case "conflict":
      return {
        ok: false,
        reason: `予定の${label}が相手側の変更と競合しました。`,
      };
    case "gone":
      return {
        ok: false,
        reason: "予定またはカレンダーが相手側にありません。",
      };
  }
}

/** ローカルの変更が、最後に相手側を確かめた時刻より後か (gone のときの決まり)。 */
function localIsNewer(
  snapshot: Snapshot,
  calendar: CalendarRow,
  fields: readonly string[],
): boolean {
  const stamps = snapshot.event.fieldUpdatedAt ?? {};
  const local = Math.max(
    ...fields.map((field) => Date.parse(stamps[field] ?? "")),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(local)) return false;
  const synced =
    calendar.lastSyncedAt?.getTime() ??
    snapshot.event.remoteUpdatedAt?.getTime() ??
    0;
  return local > synced;
}

async function applyUpdate(
  deps: EventOutboxDeps,
  row: OutboxRow,
  payload: EventUpdatePayload,
): Promise<OperationResult> {
  const calendar = await loadCalendar(deps, payload.calendarId);
  if (!calendar) return { ok: true };
  let snapshot = await loadSnapshot(deps, calendar.id, payload.eventId);
  if (!snapshot) return { ok: true };
  let fields = payload.fields;

  let ref = refOf(snapshot);
  if (!ref) {
    // まだ相手側に無い回の例外。原本を指して、その回を新しく上書きする書き込みにする。
    const master = snapshot.master;
    if (!master?.remoteId) {
      return {
        ok: false,
        reason: "予定の作成が相手側に反映されていないため、変更できません。",
      };
    }
    ref = {
      remoteId: master.remoteId,
      etag: null,
      uid: snapshot.event.uid,
      recurrenceId: snapshot.event.recurrenceId,
      parentRemoteId: master.remoteId,
    };
  }

  for (let attempt = 1; ; attempt++) {
    const write: EventWrite = { ...snapshot, fields };
    const result = await deps.provider.updateEvent(
      deps.ctx,
      calendar,
      ref,
      write,
    );
    if (result.status === "ok") {
      await applyWriteResult(deps, calendar, row.id, result.events, {
        eventId: snapshot.event.id,
        recurrenceId: snapshot.event.recurrenceId,
      });
      return { ok: true };
    }
    if (result.status === "rejected") {
      return { ok: false, reason: result.reason };
    }
    let latest: RemoteEvent[] | null = null;
    if (result.status === "conflict") {
      if (attempt >= MAX_CONFLICT_RETRIES) {
        return {
          ok: false,
          reason: `相手側の変更と ${MAX_CONFLICT_RETRIES} 回続けて競合しました。`,
        };
      }
      latest = await deps.provider.getEvent(deps.ctx, calendar, ref);
    }
    if (latest === null) {
      // 相手側に無い (gone)。ローカルの変更の方が新しければ作り直し、そうでなければローカルを消す。
      return resolveGone(deps, calendar, row, snapshot, ref, payload.fields);
    }
    // 取り直した内容をマージして DB に書く。この行の項目は書き戻し待ちなので、
    // 時刻で勝った項目はローカルに残り、keptLocal に入る。
    const fetched = latest;
    const eventId = snapshot.event.id;
    const kept = await deps.db.transaction(async (tx) => {
      const guard = await loadPendingEventGuard(tx, deps.account.id);
      const written = await writeRemoteEvents(tx, {
        account: deps.account,
        calendar,
        provider: deps.provider,
        guard,
        events: fetched,
        now: nowOf(deps),
      });
      for (const lost of written.lostLocal) {
        deps.log(
          `予定 ${lost.eventId} の変更 (${lost.fields.join(", ")}) は、相手側のより新しい変更に負けました`,
        );
      }
      return written.keptLocal.get(eventId) ?? [];
    });
    const remaining = fields.filter((field) => kept.includes(field));
    // ローカルで勝った項目が無ければ、書き戻すものは無い。
    if (remaining.length === 0) return { ok: true };
    snapshot = await loadSnapshot(deps, calendar.id, payload.eventId);
    if (!snapshot) return { ok: true };
    fields = remaining;
    const remote = findRemote(fetched, ref);
    ref = refOf(snapshot) ?? { ...ref, etag: remote?.etag ?? null };
  }
}

async function resolveGone(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  row: OutboxRow,
  snapshot: Snapshot,
  ref: RemoteEventRef,
  fields: readonly string[],
): Promise<OperationResult> {
  const isMaster = snapshot.event.recurrenceId === null;
  if (isMaster && localIsNewer(snapshot, calendar, fields)) {
    deps.log(
      `予定 ${snapshot.event.id} は相手側で消えていましたが、こちらの変更の方が新しいので作り直します`,
    );
    const result = await deps.provider.createEvent(deps.ctx, calendar, {
      event: { ...snapshot.event, remoteId: null, etag: null },
      master: null,
      exceptions: snapshot.exceptions,
      fields: [...EVENT_FIELD_NAMES],
    });
    return finishWrite(deps, calendar, row, snapshot, result, "作り直し");
  }
  deps.log(
    `予定 ${snapshot.event.id} は相手側で消えていたので、こちらでも消します`,
  );
  await deleteLocal(deps, calendar, ref.remoteId);
  return { ok: true };
}

async function applyDelete(
  deps: EventOutboxDeps,
  row: OutboxRow,
  payload: EventDeletePayload,
): Promise<OperationResult> {
  const calendar = await loadCalendar(deps, payload.calendarId);
  if (!calendar) return { ok: true };
  const ref = refFromOutbox(payload.target);
  // 相手側に作る前に消された。
  if (!ref) return { ok: true };
  for (let attempt = 1; ; attempt++) {
    const result = await deps.provider.deleteEvent(deps.ctx, calendar, ref);
    if (result.status === "ok" || result.status === "gone") return { ok: true };
    if (result.status === "rejected")
      return { ok: false, reason: result.reason };
    if (attempt >= MAX_CONFLICT_RETRIES) {
      return {
        ok: false,
        reason: `相手側の変更と ${MAX_CONFLICT_RETRIES} 回続けて競合しました。`,
      };
    }
    // 相手側が先に変わっていた。削除と変更は後から行った方を採る。
    const latest = await deps.provider.getEvent(deps.ctx, calendar, ref);
    if (!latest) return { ok: true };
    const remote = findRemote(latest, ref);
    if (!remote) return { ok: true };
    const remoteAt = remote.remoteUpdatedAt
      ? Date.parse(remote.remoteUpdatedAt)
      : Number.NaN;
    if (!Number.isNaN(remoteAt) && remoteAt > Date.parse(payload.deletedAt)) {
      deps.log(
        `予定 ${payload.target.eventId} は、消したあとに相手側で変更されていたので、消さずに戻します`,
      );
      await applyWriteResult(deps, calendar, row.id, latest, null);
      return { ok: true };
    }
    ref.etag = remote.etag;
  }
}

async function applyRespond(
  deps: EventOutboxDeps,
  row: OutboxRow,
  payload: EventRespondPayload,
): Promise<OperationResult> {
  const calendar = await loadCalendar(deps, payload.calendarId);
  if (!calendar) return { ok: true };
  const snapshot = await loadSnapshot(deps, calendar.id, payload.eventId);
  if (!snapshot) return { ok: true };
  const ref = refOf(snapshot);
  if (!ref) {
    return {
      ok: false,
      reason: "予定が相手側に反映されていないため、返事できません。",
    };
  }
  for (let attempt = 1; ; attempt++) {
    const result = await deps.provider.respond(deps.ctx, calendar, ref, {
      status: payload.status,
      comment: payload.comment,
    });
    if (result.status === "ok") {
      await applyWriteResult(deps, calendar, row.id, result.events, {
        eventId: snapshot.event.id,
        recurrenceId: snapshot.event.recurrenceId,
      });
      return { ok: true };
    }
    if (result.status === "rejected")
      return { ok: false, reason: result.reason };
    if (result.status === "gone") {
      return { ok: false, reason: "予定が相手側にありません。" };
    }
    if (attempt >= MAX_CONFLICT_RETRIES) {
      return {
        ok: false,
        reason: `相手側の変更と ${MAX_CONFLICT_RETRIES} 回続けて競合しました。`,
      };
    }
    // 返事は自分の出欠だけなので、マージせずに新しい etag でやり直す。
    const latest = await deps.provider.getEvent(deps.ctx, calendar, ref);
    if (!latest) return { ok: false, reason: "予定が相手側にありません。" };
    ref.etag = findRemote(latest, ref)?.etag ?? null;
  }
}

/**
 * 確定した失敗の後始末。outbox を failed にし、先に DB へ反映した内容を相手側の内容に戻す
 * (作成は行を残す)。相手側を取り直せなければ、カレンダーの同期の位置を消して、
 * 次の同期の全件の突き合わせで戻す。カレンダーの変更として端末へ知らせる。
 */
async function failEventOperation(
  deps: EventOutboxDeps,
  row: OutboxRow,
  reason: string,
) {
  deps.log(`予定の書き戻し (${row.kind}) を反映できませんでした: ${reason}`);
  const payload = row.payload as { calendarId?: string; eventId?: string };
  const calendar = payload.calendarId
    ? await loadCalendar(deps, payload.calendarId)
    : null;

  // 戻す先の、相手側の内容。undefined は取り直せなかった。
  let latest: RemoteEvent[] | null | undefined;
  if (calendar && row.kind !== "event_create") {
    let ref: RemoteEventRef | null = null;
    if (row.kind === "event_delete") {
      ref = refFromOutbox((row.payload as EventDeletePayload).target);
    } else if (payload.eventId) {
      const snapshot = await loadSnapshot(deps, calendar.id, payload.eventId);
      ref = snapshot ? refOf(snapshot) : null;
    }
    if (ref) {
      try {
        latest = await deps.provider.getEvent(deps.ctx, calendar, ref);
      } catch (error) {
        if (error instanceof CalendarAuthError) throw error;
        latest = undefined;
      }
    } else {
      latest = null;
    }
  }

  await deps.db.transaction(async (tx) => {
    await lockCalendarAccount(tx, deps.account.id);
    await tx
      .update(outbox)
      .set({ status: "failed", lastError: reason })
      .where(eq(outbox.id, row.id));
    if (!calendar) return;
    if (row.kind !== "event_create" && payload.eventId) {
      // 相手側が変わっていなくても書き直されるよう、行の etag を外す
      // (etag と raw が同じ行は、取り込みでも upsert でも触らないため)。
      await tx
        .update(events)
        .set({ etag: null })
        .where(
          and(
            eq(events.id, payload.eventId),
            eq(events.calendarId, calendar.id),
          ),
        );
    }
    if (row.kind === "event_create") {
      // 作成の失敗は行を残す (利用者の入力を消さない)。
    } else if (latest && latest.length > 0) {
      // この行はもう書き戻し待ちではないので、相手側と違う項目は相手側に戻る。
      const guard = await loadPendingEventGuard(tx, deps.account.id);
      await writeRemoteEvents(tx, {
        account: deps.account,
        calendar,
        provider: deps.provider,
        guard,
        events: latest,
        now: nowOf(deps),
      });
    } else {
      // 取り直せなかった、または相手側で消えていた。次の同期で全件を突き合わせる。
      await tx
        .update(calendars)
        .set({ syncToken: null })
        .where(eq(calendars.id, calendar.id));
    }
    await recordChanges(tx, deps.account.userId, "calendar", "upsert", [
      calendar.id,
    ]);
  });
}
