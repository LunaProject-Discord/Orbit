import {
  EVENT_FIELD_NAMES,
  EVENT_OUTBOX_KINDS,
  type EventCreatePayload,
  type EventDeletePayload,
  type EventFieldName,
  type EventOutboxRef,
  type EventRespondPayload,
  type EventUpdatePayload,
  type ImipPlan,
  type ImipPlanMessage,
} from "@orbit/core";
import {
  calendars,
  type Database,
  deleteCalendarEventsByRemoteId,
  enqueueImip,
  events,
  findCalendarEvents,
  narrowImipPlan,
  outbox,
} from "@orbit/db";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { recordChanges, type Tx } from "../changes.js";
import {
  type EventConflictInput,
  eventSnapshot,
  lostValues,
  pruneEventConflicts,
  recordEventConflict,
  recordInviteFailure,
} from "./conflicts.js";
import {
  isDeletePending,
  loadPendingEventGuard,
  lockCalendarAccount,
  type ResolvedRemoteEvent,
  resolveRemoteUids,
  type WriteOutcome,
  writeRemoteEvents,
} from "./ingest.js";
import {
  type AccountRow,
  CalendarAuthError,
  CalendarNotImplementedError,
  type CalendarProvider,
  type CalendarRow,
  CalendarTransientError,
  type EventSnapshot,
  type EventWrite,
  type ProviderContext,
  type RemoteEvent,
  type RemoteEventRef,
  type WriteResult,
} from "./provider.js";

/**
 * 一時的な失敗でやり直す期間。最初の一時的な失敗からこれだけたっても反映できなければ、
 * 確定した失敗として扱う (回数では打ち切らない。429 や数分の障害で利用者の変更を巻き戻さないため)。
 */
export const TRANSIENT_GIVE_UP_MS = 6 * 60 * 60_000;
/** CalendarTransientError に待つ時間が無いときの待ち時間。 */
export const DEFAULT_RETRY_AFTER_MS = 30_000;
/** 反映済みの記録を残す期間 (メールの outbox と同じ)。 */
const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;
/** 書き込みの競合 (conflict) を、取り直してやり直す回数の上限。 */
export const MAX_CONFLICT_RETRIES = 3;

type OutboxRow = typeof outbox.$inferSelect;
/**
 * 1 行の反映の結果。imip は、相手側への書き込み (または相手側で既に消えていた削除) が済み、
 * payload の招待メールの計画を送ってよいこと (imip-design 6.1)。何も書かずに終えたとき
 * (予定が消えていた、相手側の変更に負けた、削除を取りやめた) は付けない。
 */
type OperationResult =
  | {
      ok: true;
      imip?: true;
      /**
       * 変更 (event_update) で、相手側に実際に書いた項目 (競合のマージで負けた項目を除く)。
       * 招待メールの計画を、書いた項目に絞るのに使う (imip レビュー M1)。
       */
      fields?: readonly string[];
    }
  | { ok: false; reason: string };
const WRITTEN: OperationResult = { ok: true, imip: true };

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
 * 一時的な失敗では止まり (順番を保つため後続も実行しない)、次の周回で続きからやり直す。
 * - ふつうの例外は投げ直す (周回のバックオフで待つ)。attempts に数える。
 * - CalendarTransientError は attempts に数えず、行の runAfter を retryAfter の後にして止まる
 *   (投げない)。返す retryAt がその時刻。runAfter が来ていない行が先頭にあれば、そこで止まる。
 * - 最初の一時的な失敗 (firstFailedAt) から TRANSIENT_GIVE_UP_MS たつと、確定した失敗にする。
 * 認証の失敗 (CalendarAuthError) と停止は、操作のせいではないので数えずに投げる。
 */
export async function processEventOutbox(
  deps: EventOutboxDeps,
): Promise<{ done: number; failed: number; retryAt: Date | null }> {
  const { db, account } = deps;
  const rows = await db
    .select({ id: outbox.id })
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
  let retryAt: Date | null = null;
  const active = inArray(outbox.status, ["pending", "processing"]);

  for (const listed of rows) {
    // 停止を求められたら、次の行を始めない。
    if (deps.ctx.signal.aborted) break;
    // 前の行の結果で payload が書き換わっていることがある (削除の target など)。
    // API に取り消された行は飛ばす。
    const [fresh] = await db
      .select({ runAfter: outbox.runAfter })
      .from(outbox)
      .where(and(eq(outbox.id, listed.id), active));
    if (!fresh) continue;
    if (fresh.runAfter.getTime() > nowOf(deps).getTime()) {
      // 一時的な失敗で待っている行。順番を保つため、後続も実行しない。
      retryAt = fresh.runAfter;
      break;
    }
    // 取るときも状態を確かめる (ほかの同期が先に終えた行を、もう一度実行しない)。
    const [row] = await db
      .update(outbox)
      .set({ status: "processing", attempts: sql`${outbox.attempts} + 1` })
      .where(and(eq(outbox.id, listed.id), active))
      .returning();
    if (!row) continue;
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
          .set({
            status: "pending",
            attempts: row.attempts - 1,
            lastError: reason,
          })
          .where(and(eq(outbox.id, row.id), active));
        throw error;
      }
      const now = nowOf(deps);
      const failedSince = row.firstFailedAt ?? now;
      if (now.getTime() - failedSince.getTime() < TRANSIENT_GIVE_UP_MS) {
        if (error instanceof CalendarTransientError) {
          const at = new Date(
            now.getTime() + (error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS),
          );
          await db
            .update(outbox)
            .set({
              status: "pending",
              attempts: row.attempts - 1,
              lastError: reason,
              firstFailedAt: failedSince,
              runAfter: at,
            })
            .where(and(eq(outbox.id, row.id), active));
          deps.log(
            `予定の書き戻しを ${at.toISOString()} まで待ちます: ${reason}`,
          );
          retryAt = at;
          break;
        }
        await db
          .update(outbox)
          .set({
            status: "pending",
            lastError: reason,
            firstFailedAt: failedSince,
          })
          .where(and(eq(outbox.id, row.id), active));
        throw error;
      }
      result = { ok: false, reason };
    }
    if (result.ok) {
      const plan = (row.payload as { imip?: ImipPlan | null }).imip ?? null;
      await db.transaction(async (tx) => {
        await tx
          .update(outbox)
          .set({ status: "done", lastError: null })
          .where(eq(outbox.id, row.id));
        // 書き戻しが成功した後でだけ、招待メールを積む (巻き戻した変更の招待は出さない)。
        // 積む処理が投げても書き戻しの行は done にし、招待は invite_failed に残す
        // (行が processing のまま毎周回やり直しになり、後続の書き戻しが止まらないように。L7)。
        if (plan && result.imip) {
          try {
            await tx.transaction((savepoint) =>
              enqueuePlannedImip(savepoint, deps, row, plan, result.fields),
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            deps.log(`招待メールを積めませんでした: ${reason}`);
            await recordPlanFailure(
              tx,
              deps,
              row,
              plan.messages,
              "招待メールの本文を作れませんでした。",
            );
          }
        }
      });
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
  // 反映されなかった変更の記録も、同じ時機に古いものを消す。
  await pruneEventConflicts(db, account.userId, nowOf(deps));
  return { done, failed, retryAt };
}

/** 書き戻しの行の、予定の ID とカレンダーの ID。 */
function outboxEventOf(row: OutboxRow): {
  calendarId: string;
  eventId: string;
} {
  const payload = row.payload as {
    calendarId: string;
    eventId?: string;
    target?: EventOutboxRef;
  };
  const eventId =
    row.kind === "event_delete"
      ? (payload.target?.eventId ?? "")
      : (payload.eventId ?? payload.target?.eventId ?? "");
  return { calendarId: payload.calendarId, eventId };
}

/**
 * 招待メールを積まなかったメッセージを invite_failed に残す (outboxId は null。もう一度送るは出ない)。
 * カレンダーが消えていれば残せない。
 */
async function recordPlanFailure(
  tx: Tx,
  deps: EventOutboxDeps,
  row: OutboxRow,
  messages: readonly ImipPlanMessage[],
  reason: string,
) {
  if (messages.length === 0) return;
  const { calendarId, eventId } = outboxEventOf(row);
  if (!calendarId || !eventId) return;
  const [current] = await tx
    .select({ uid: events.uid, summary: events.summary })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.calendarId, calendarId)));
  for (const message of messages) {
    await recordInviteFailure(
      tx,
      deps.account.userId,
      null,
      {
        imip: {
          method: message.method,
          reason: message.reason,
          userId: deps.account.userId,
          calendarId,
          eventId,
          uid: current?.uid ?? "",
          recurrenceId: message.recurrenceId ?? null,
          sequence: 0,
          title: current?.summary ?? null,
        },
        message: { to: message.to },
      },
      reason,
    );
  }
}

/**
 * 同じ予定に、まだ書き戻していない後ろの変更 (event_update) があれば、本文を行から作る
 * メッセージをその行へ持ち越す (imip レビュー M2)。DB の行には後ろの変更も入っているので、
 * いま作ると、後ろの変更が確定して失敗して巻き戻されたときに、その内容が招待に載って出てしまう。
 * 持ち越したメッセージは、後ろの行の書き戻しが成功したときにその時点の行から作って積む。
 * 戻り値は、いま積むメッセージ (本文を計画の時点で作ってあるもの、返事、持ち越せなかったもの)。
 */
async function carryToLaterWrite(
  tx: Tx,
  deps: EventOutboxDeps,
  row: OutboxRow,
  plan: ImipPlan,
  eventId: string,
): Promise<ImipPlan> {
  const deferrable = plan.messages.filter(
    (message) => message.method !== "REPLY" && message.content === undefined,
  );
  if (deferrable.length === 0) return plan;
  const [later] = await tx
    .select({ id: outbox.id, payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, deps.account.id),
        eq(outbox.kind, "event_update"),
        eq(outbox.status, "pending"),
        ne(outbox.id, row.id),
        sql`${outbox.payload}->>'eventId' = ${eventId}`,
        sql`(${outbox.createdAt}, ${outbox.id}) > (${row.createdAt.toISOString()}::timestamptz, ${row.id}::uuid)`,
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .limit(1)
    .for("update");
  if (!later) return plan;
  const laterPayload = later.payload as Record<string, unknown> & {
    imip?: ImipPlan | null;
  };
  const laterPlan = laterPayload.imip ?? null;
  // 送信元が違う計画とはまとめない (いま送る)。
  if (laterPlan && laterPlan.senderAccountId !== plan.senderAccountId) {
    return plan;
  }
  const merged: ImipPlan = {
    senderAccountId: plan.senderAccountId,
    stamp: laterPlan?.stamp ?? plan.stamp,
    messages: [
      ...deferrable.map((message) => ({ ...message, carried: true as const })),
      ...(laterPlan?.messages ?? []),
    ],
  };
  await tx
    .update(outbox)
    .set({ payload: { ...laterPayload, imip: merged } })
    .where(eq(outbox.id, later.id));
  deps.log(
    `予定 ${eventId} の招待メール ${deferrable.length} 通は、後ろの変更の書き戻しの後に送ります`,
  );
  return {
    ...plan,
    messages: plan.messages.filter((message) => !deferrable.includes(message)),
  };
}

/**
 * 書き戻しが済んだ event_* の行の、招待メールの計画 (payload.imip) を imip_send にして積む
 * (imip-design 6.1。同じトランザクションで行を done にする)。本文は書き戻した後の行から作るので、
 * SEQUENCE は相手側に書いた値になる。冪等キーは元の行のキーから作るので、行の再実行でも増えない。
 * - 変更は、相手側に実際に書いた項目と、書いた後の参加者に計画を絞る (M1。narrowImipPlan)。
 * - 同じ予定に後ろの変更が残っていれば、行から作るメッセージはそちらへ持ち越す (M2)。
 * 送信元が使えない・From と主催者が違う・上限を超えた・本文を作れなかったときは送らず、
 * invite_failed を残す (scheduling が mail でなくなったとき (not_mail) はサーバーが送るので
 * 何も残さない)。
 */
async function enqueuePlannedImip(
  tx: Tx,
  deps: EventOutboxDeps,
  row: OutboxRow,
  written: ImipPlan,
  writtenFields: readonly string[] | undefined,
) {
  const { calendarId, eventId } = outboxEventOf(row);
  const [calendar] = await tx
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.id, calendarId),
        eq(calendars.accountId, deps.account.id),
      ),
    );
  if (!calendar || !eventId) return;
  const [current] = await tx
    .select({ uid: events.uid })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.calendarId, calendar.id)));
  const rows = current
    ? await findCalendarEvents(tx, calendar.id, {
        remoteIds: [],
        uids: [current.uid],
      })
    : [];
  let plan = narrowImipPlan(
    written,
    row.kind === "event_update" ? (writtenFields ?? null) : null,
    rows,
    eventId,
  );
  if (row.kind === "event_update" || row.kind === "event_create") {
    plan = await carryToLaterWrite(tx, deps, row, plan, eventId);
  }
  if (plan.messages.length === 0) return;
  const result = await enqueueImip(tx, plan, rows, {
    userId: deps.account.userId,
    calendarId: calendar.id,
    eventId,
    baseKey: row.idempotencyKey,
    defaultTimeZone: calendar.timeZone ?? "UTC",
    sourceOutboxId: row.id,
    now: nowOf(deps),
  });
  if (result.incompleteMessages.length > 0) {
    // 予定の行が無い・本文を作れない。黙って捨てずに記録する (M4)。
    deps.log(
      `予定 ${eventId} の招待メールのうち ${result.incomplete} 通は、本文を作れませんでした`,
    );
    await recordPlanFailure(
      tx,
      deps,
      row,
      result.incompleteMessages,
      "招待メールの本文を作れませんでした (予定が見つかりません)。",
    );
  }
  const reason =
    result.skipped === "sender_unavailable"
      ? "送信元のメールアカウントが無いか、送信できません。"
      : result.skipped === "sender_mismatch"
        ? "送信元のアドレスが予定の主催者 (返事では自分の参加者のアドレス) と違います。"
        : result.skipped === "limit"
          ? "招待メールの送信数が上限に達しました。"
          : null;
  if (!reason) return;
  deps.log(`予定 ${eventId} の招待メールを積みませんでした: ${reason}`);
  await recordPlanFailure(tx, deps, row, plan.messages, reason);
}

/** プロバイダから届いた予定に uid を補う。補えなかった例外はログに残して捨てる。 */
async function resolveFetched(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  list: readonly RemoteEvent[],
): Promise<ResolvedRemoteEvent[]> {
  const { resolved, unresolved } = await resolveRemoteUids(
    deps.db,
    calendar.id,
    list,
  );
  for (const event of unresolved) {
    deps.log(
      `予定 ${event.remoteId} (${event.recurrenceId ?? ""}) は原本が見つからず uid を補えないので、書き込みませんでした`,
    );
  }
  return resolved;
}

/** getEvent して uid を補う。無ければ null。 */
async function fetchRemote(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  ref: RemoteEventRef,
): Promise<ResolvedRemoteEvent[] | null> {
  const latest = await deps.provider.getEvent(deps.ctx, calendar, ref);
  return latest === null ? null : resolveFetched(deps, calendar, latest);
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
function findRemote<T extends RemoteEvent>(
  list: readonly T[],
  ref: Pick<RemoteEventRef, "uid" | "recurrenceId" | "remoteId">,
): T | null {
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
 * 作成の結果を書く前に、相手側が付け替えた UID の予定を取り込みが先に入れていたとき
 * (作成の結果を保存する前に止まり、やり直す前に同期が走った)、その行をこちらの行 (events.id) へ寄せる。
 * - 同じ回 (recurrenceId) の行がこちらにもあれば、先に入った行を消し、それを指す書き戻し待ちを
 *   こちらの行へ付け替える。events.id は端末と outbox が参照しているので、こちらを残す。
 * - こちらに無い回の例外は、こちらの原本の子に付け替えて残す。
 * 返すのは消した行の ID。
 */
async function absorbDuplicateUid(
  tx: Tx,
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  fromUid: string,
  toUid: string,
): Promise<string[]> {
  const dupes = await tx
    .select({ id: events.id, recurrenceId: events.recurrenceId })
    .from(events)
    .where(and(eq(events.calendarId, calendar.id), eq(events.uid, toUid)));
  if (dupes.length === 0) return [];
  const mine = await tx
    .select({ id: events.id, recurrenceId: events.recurrenceId })
    .from(events)
    .where(and(eq(events.calendarId, calendar.id), eq(events.uid, fromUid)));
  const mineByRecurrence = new Map(
    mine.map((row) => [row.recurrenceId ?? "", row.id]),
  );
  const myMaster = mineByRecurrence.get("");
  const removed: string[] = [];
  for (const dupe of dupes) {
    const target = mineByRecurrence.get(dupe.recurrenceId ?? "");
    if (target) {
      await tx
        .update(outbox)
        .set({
          payload: sql`jsonb_set(${outbox.payload}, '{eventId}', to_jsonb(${target}::text))`,
        })
        .where(
          and(
            eq(outbox.accountId, deps.account.id),
            inArray(outbox.kind, [...EVENT_OUTBOX_KINDS]),
            inArray(outbox.status, ["pending", "processing"]),
            sql`${outbox.payload}->>'eventId' = ${dupe.id}`,
          ),
        );
      removed.push(dupe.id);
    } else if (dupe.recurrenceId !== null && myMaster) {
      await tx
        .update(events)
        .set({ parentId: myMaster })
        .where(eq(events.id, dupe.id));
    }
  }
  if (removed.length > 0) {
    await tx.delete(events).where(inArray(events.id, removed));
    await recordChanges(tx, deps.account.userId, "event", "delete", removed);
  }
  return removed;
}

/**
 * 書き戻しの結果 (相手側の姿) を DB に書く。outboxId の行は反映し終えたものとして数えず、
 * ほかの書き戻し待ちの項目だけローカルを残す。
 * target は書き込んだ予定 (events.id と回)。その予定の削除が後ろに積まれていれば
 * (書き込みの実行中に API で消された)、結果は行に書かず (消した行を戻さない)、
 * 削除の payload の target に相手側の remoteId と etag を書き込んで、削除がそれを使えるようにする。
 * rename は、相手側が UID を付け替えたときの元の uid (行の uid を先に書き換えて、
 * 同じ行に remoteId が付くようにする)。新しい uid の行が既にあれば、先にこちらへ寄せる。
 * onWritten は、書き込んだ後に同じトランザクションで呼ぶ (競合の記録など)。
 */
async function applyWriteResult(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  outboxId: string,
  remote: readonly ResolvedRemoteEvent[],
  target: { eventId: string; recurrenceId: string | null } | null,
  rename?: { fromUid: string },
  onWritten?: (tx: Tx, written: WriteOutcome) => Promise<void>,
) {
  await deps.db.transaction(async (tx) => {
    let guard = await loadPendingEventGuard(tx, deps.account.id, [outboxId]);
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
      const absorbed = await absorbDuplicateUid(
        tx,
        deps,
        calendar,
        rename.fromUid,
        primary.uid,
      );
      if (absorbed.length > 0) {
        // 書き戻し待ちを付け替えたので読み直す。
        guard = await loadPendingEventGuard(tx, deps.account.id, [outboxId]);
      }
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
    const current = guard;
    const written = await writeRemoteEvents(tx, {
      account: deps.account,
      calendar,
      provider: deps.provider,
      guard: current,
      // 削除の書き戻し待ちの予定は書かない (消した行を戻さない)。
      events: remote.filter(
        (event) => !isDeletePending(current, calendar.id, event),
      ),
      now: nowOf(deps),
    });
    await onWritten?.(tx, written);
  });
}

/** 行を消し (例外も含む)、変更履歴に記録する。conflict があれば同じトランザクションで記録する。 */
async function deleteLocal(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  remoteId: string,
  conflict?: EventConflictInput,
) {
  await deps.db.transaction(async (tx) => {
    await lockCalendarAccount(tx, deps.account.id);
    const { deleted } = await deleteCalendarEventsByRemoteId(tx, calendar.id, [
      remoteId,
    ]);
    await recordChanges(tx, deps.account.userId, "event", "delete", deleted);
    if (conflict) await recordEventConflict(tx, conflict);
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
  if (snapshot.event.remoteId !== null) return WRITTEN;
  // 結果の書き込みの前に止まっていたら、相手側には既にある。プロバイダは events.id から
  // 決まる ID で冪等に作り、既にあれば ok (または conflict と remoteId) を返す約束。
  const result = await deps.provider.createEvent(deps.ctx, calendar, {
    ...snapshot,
    fields: [...EVENT_FIELD_NAMES],
  });
  return finishWrite(deps, calendar, row, snapshot, result, "作成", true);
}

/**
 * 書き込みの結果を DB に反映する (ok 以外は失敗の理由にする)。
 * create のとき、conflict に remoteId があれば (決まった ID の予定が既にある)、
 * 取り直して ok として扱う。
 */
async function finishWrite(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  row: OutboxRow,
  snapshot: Snapshot,
  result: WriteResult,
  label: string,
  create = false,
): Promise<OperationResult> {
  let written: readonly RemoteEvent[] | null = null;
  if (result.status === "ok") {
    written = result.events;
  } else if (result.status === "conflict" && create && result.remoteId) {
    const existing = await deps.provider.getEvent(deps.ctx, calendar, {
      remoteId: result.remoteId,
      etag: null,
      uid: snapshot.event.uid,
      recurrenceId: snapshot.event.recurrenceId,
      parentRemoteId: null,
    });
    if (existing && existing.length > 0) {
      deps.log(
        `予定 ${snapshot.event.id} は相手側に作成済みだったので、その内容を使います`,
      );
      written = existing;
    }
  }
  if (written) {
    await applyWriteResult(
      deps,
      calendar,
      row.id,
      await resolveFetched(deps, calendar, written),
      {
        eventId: snapshot.event.id,
        recurrenceId: snapshot.event.recurrenceId,
      },
      { fromUid: snapshot.event.uid },
    );
    return WRITTEN;
  }
  switch (result.status) {
    case "rejected":
      return { ok: false, reason: result.reason };
    case "gone":
      return {
        ok: false,
        reason: "予定またはカレンダーが相手側にありません。",
      };
    default:
      return {
        ok: false,
        reason: `予定の${label}が相手側の変更と競合しました。`,
      };
  }
}

/**
 * ローカルの変更が、相手側の削除より後か (gone のときの決まり)。相手側の削除は、
 * 最後に相手側にあると確かめた時刻より後に起きたとみなす。その時刻は、取り込みが削除を
 * 見送ったときに行に残した remoteDeletedAfter、無ければ最後に成功した同期の時刻
 * (calendars.lastSyncedAt。失敗では進まない)、それも無ければ行の remoteUpdatedAt。
 * 削除の時刻がはっきりしない間の変更は、ローカルを勝たせる。
 */
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
  const seenAlive =
    snapshot.event.remoteDeletedAfter?.getTime() ??
    calendar.lastSyncedAt?.getTime() ??
    snapshot.event.remoteUpdatedAt?.getTime() ??
    0;
  return local > seenAlive;
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
      await applyWriteResult(
        deps,
        calendar,
        row.id,
        await resolveFetched(deps, calendar, result.events),
        {
          eventId: snapshot.event.id,
          recurrenceId: snapshot.event.recurrenceId,
        },
      );
      return { ok: true, imip: true, fields };
    }
    if (result.status === "rejected") {
      return { ok: false, reason: result.reason };
    }
    let latest: ResolvedRemoteEvent[] | null = null;
    if (result.status === "conflict") {
      if (attempt >= MAX_CONFLICT_RETRIES) {
        return {
          ok: false,
          reason: `相手側の変更と ${MAX_CONFLICT_RETRIES} 回続けて競合しました。`,
        };
      }
      latest = await fetchRemote(deps, calendar, ref);
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
        // 解決している間に API で消された予定は書かない (消した行を戻さない)。
        events: fetched.filter(
          (event) => !isDeletePending(guard, calendar.id, event),
        ),
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
    const remote: ResolvedRemoteEvent | null = findRemote(fetched, ref);
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
    return finishWrite(deps, calendar, row, snapshot, result, "作り直し", true);
  }
  deps.log(
    `予定 ${snapshot.event.id} は相手側で消えていたので、こちらでも消します`,
  );
  const lostFields = fields.filter((field): field is EventFieldName =>
    (EVENT_FIELD_NAMES as readonly string[]).includes(field),
  );
  await deleteLocal(deps, calendar, ref.remoteId, {
    userId: deps.account.userId,
    calendarId: calendar.id,
    eventId: snapshot.event.id,
    kind: "remote_deleted",
    fields: lostFields,
    lost: lostValues(snapshot.event, lostFields),
    snapshot: eventSnapshot(snapshot.event),
    title: snapshot.event.summary,
    reason:
      "相手側で削除されていて、こちらの変更の方が古かったので削除しました。",
  });
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
    // 相手側で既に消えていても (gone)、参加者にはまだ取り消しを知らせていない。
    if (result.status === "ok" || result.status === "gone") return WRITTEN;
    if (result.status === "rejected")
      return { ok: false, reason: result.reason };
    if (attempt >= MAX_CONFLICT_RETRIES) {
      return {
        ok: false,
        reason: `相手側の変更と ${MAX_CONFLICT_RETRIES} 回続けて競合しました。`,
      };
    }
    // 相手側が先に変わっていた。削除と変更は後から行った方を採る。
    const latest = await fetchRemote(deps, calendar, ref);
    if (!latest) return WRITTEN;
    const remote = findRemote(latest, ref);
    if (!remote) return WRITTEN;
    const remoteAt = remote.remoteUpdatedAt
      ? Date.parse(remote.remoteUpdatedAt)
      : Number.NaN;
    if (!Number.isNaN(remoteAt) && remoteAt > Date.parse(payload.deletedAt)) {
      deps.log(
        `予定 ${payload.target.eventId} は、消したあとに相手側で変更されていたので、消さずに戻します`,
      );
      await applyWriteResult(
        deps,
        calendar,
        row.id,
        latest,
        null,
        undefined,
        async (tx) => {
          // 戻した行 (新しい events.id) を指す。「やはり削除」はこの ID を消す。
          const [restored] = await tx
            .select({ id: events.id })
            .from(events)
            .where(
              and(
                eq(events.calendarId, calendar.id),
                eq(events.uid, remote.uid),
                sql`${events.recurrenceId} is not distinct from ${remote.recurrenceId}`,
              ),
            );
          await recordEventConflict(tx, {
            userId: deps.account.userId,
            calendarId: calendar.id,
            eventId: restored?.id ?? payload.target.eventId,
            kind: "delete_cancelled",
            title: remote.summary,
            reason:
              "削除した後に相手側で変更されていたので、削除を取りやめました。",
          });
        },
      );
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
  if (!snapshot) {
    // 「不参加で返事をして削除」: 返事を書き戻す前に予定の行が消えた。主催者へ返事を届けるため、
    // 受け付けた時点の所在 (target) で返事だけをする (段取り 8 より前の行には target が無い)。
    const target = payload.target ? refFromOutbox(payload.target) : null;
    if (!target) return { ok: true };
    return respondWithoutRow(deps, calendar, payload, target);
  }
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
      await applyWriteResult(
        deps,
        calendar,
        row.id,
        await resolveFetched(deps, calendar, result.events),
        {
          eventId: snapshot.event.id,
          recurrenceId: snapshot.event.recurrenceId,
        },
      );
      return WRITTEN;
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
    const latest = await fetchRemote(deps, calendar, ref);
    if (!latest) return { ok: false, reason: "予定が相手側にありません。" };
    ref.etag = findRemote(latest, ref)?.etag ?? null;
  }
}

/**
 * 行の無い予定 (返事の後に消した) へ返事をする。結果は DB に書かない (消した行を戻さない)。
 * 返事で相手側の ETag が変わるので、続く削除の書き戻し待ち (event_delete) の ETag を新しい値に
 * 付け替える (古い ETag のままだと、削除が「消した後に相手側で変わった」と見なされて取りやめになる)。
 * 相手側で既に消えていれば、返事する相手が無いので成功として扱う。
 */
async function respondWithoutRow(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  payload: EventRespondPayload,
  ref: RemoteEventRef,
): Promise<OperationResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await deps.provider.respond(deps.ctx, calendar, ref, {
      status: payload.status,
      comment: payload.comment,
    });
    if (result.status === "ok") {
      const etag = findRemote(result.events, ref)?.etag ?? null;
      if (etag !== null) {
        await deps.db.transaction(async (tx) => {
          await lockCalendarAccount(tx, deps.account.id);
          await tx
            .update(outbox)
            .set({
              payload: sql`jsonb_set(${outbox.payload}, '{target,etag}', to_jsonb(${etag}::text))`,
            })
            .where(
              and(
                eq(outbox.accountId, deps.account.id),
                eq(outbox.kind, "event_delete"),
                eq(outbox.status, "pending"),
                sql`${outbox.payload}->'target'->>'eventId' = ${payload.eventId}`,
              ),
            );
        });
      }
      return WRITTEN;
    }
    if (result.status === "gone") return { ok: true };
    if (result.status === "rejected")
      return { ok: false, reason: result.reason };
    if (attempt >= MAX_CONFLICT_RETRIES) {
      return {
        ok: false,
        reason: `相手側の変更と ${MAX_CONFLICT_RETRIES} 回続けて競合しました。`,
      };
    }
    const latest = await fetchRemote(deps, calendar, ref);
    if (!latest) return { ok: true };
    ref.etag = findRemote(latest, ref)?.etag ?? null;
  }
}

/**
 * 確定した失敗の後始末。outbox を failed にし、先に DB へ反映した内容を相手側の内容に戻す
 * (作成は行を残す)。相手側を取り直せなければ、カレンダーの同期の位置を消して、
 * 次の同期の全件の突き合わせで戻す。まだ相手側に無い回の例外 (remoteId が null) は、
 * 戻す先が無いので行を消す。カレンダーの変更として端末へ知らせる。
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
  let latest: ResolvedRemoteEvent[] | null | undefined;
  // まだ相手側に無い回の例外。戻す先が無いので行を消す。
  let unsentException: string | null = null;
  // 巻き戻す前の予定 (反映されなかった変更の記録に使う)。
  const before =
    calendar && payload.eventId
      ? await loadSnapshot(deps, calendar.id, payload.eventId)
      : null;
  if (calendar && row.kind !== "event_create") {
    let ref: RemoteEventRef | null = null;
    if (row.kind === "event_delete") {
      ref = refFromOutbox((row.payload as EventDeletePayload).target);
    } else if (payload.eventId) {
      const snapshot = before;
      ref = snapshot ? refOf(snapshot) : null;
      if (
        snapshot &&
        snapshot.event.remoteId === null &&
        snapshot.event.recurrenceId !== null
      ) {
        unsentException = snapshot.event.id;
      }
    }
    if (ref) {
      try {
        latest = await fetchRemote(deps, calendar, ref);
      } catch (error) {
        if (error instanceof CalendarAuthError) throw error;
        latest = undefined;
      }
    } else {
      latest = null;
    }
  }

  const conflict = calendar
    ? failureConflict(deps, calendar, row, reason, before, latest)
    : null;

  await deps.db.transaction(async (tx) => {
    await lockCalendarAccount(tx, deps.account.id);
    await tx
      .update(outbox)
      .set({ status: "failed", lastError: reason })
      .where(eq(outbox.id, row.id));
    if (!calendar) return;
    // 前の書き戻しから持ち越した招待メール (M2)。前の変更は相手側に書けているが、この行の
    // 巻き戻しの後の内容で送り直すことはせず (送らない側に倒す)、送らなかったことを残す。
    const carried = (
      (row.payload as { imip?: ImipPlan | null }).imip?.messages ?? []
    ).filter((message) => message.carried);
    await recordPlanFailure(
      tx,
      deps,
      row,
      carried,
      "後の変更を反映できなかったため、前の変更の招待メールを送りませんでした。",
    );
    if (row.kind === "event_respond" && !before) {
      // 返事の後に消した予定。戻す行が無いので、記録だけ残す (同期の位置は消さない)。
      if (conflict) await recordEventConflict(tx, conflict);
      await recordChanges(tx, deps.account.userId, "calendar", "upsert", [
        calendar.id,
      ]);
      return;
    }
    if (unsentException) {
      const removed = await tx
        .delete(events)
        .where(
          and(
            eq(events.id, unsentException),
            eq(events.calendarId, calendar.id),
          ),
        )
        .returning({ id: events.id });
      await recordChanges(
        tx,
        deps.account.userId,
        "event",
        "delete",
        removed.map((item) => item.id),
      );
    } else if (row.kind !== "event_create" && payload.eventId) {
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
    if (row.kind === "event_create" || unsentException) {
      // 作成の失敗は行を残す (利用者の入力を消さない)。相手側に無い例外は消した。
    } else if (latest && latest.length > 0) {
      // この行はもう書き戻し待ちではないので、相手側と違う項目は相手側に戻る。
      const guard = await loadPendingEventGuard(tx, deps.account.id);
      await writeRemoteEvents(tx, {
        account: deps.account,
        calendar,
        provider: deps.provider,
        guard,
        // 削除の書き戻し待ちの予定は書かない (消した行を戻さない)。
        events: latest.filter(
          (event) => !isDeletePending(guard, calendar.id, event),
        ),
        now: nowOf(deps),
      });
    } else {
      // 取り直せなかった、または相手側で消えていた。次の同期で全件を突き合わせる。
      await tx
        .update(calendars)
        .set({ syncToken: null })
        .where(eq(calendars.id, calendar.id));
    }
    if (conflict) {
      if (row.kind === "event_delete") {
        // 削除の失敗で相手側の内容から戻した予定は、新しい events.id になる。それを指す。
        const target = (row.payload as EventDeletePayload).target;
        const [restored] = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.calendarId, calendar.id),
              eq(events.uid, target.uid),
              sql`${events.recurrenceId} is not distinct from ${target.recurrenceId}`,
            ),
          );
        if (restored) conflict.eventId = restored.id;
      }
      await recordEventConflict(tx, conflict);
    }
    await recordChanges(tx, deps.account.userId, "calendar", "upsert", [
      calendar.id,
    ]);
  });
}

/**
 * 確定した失敗の記録 (event_conflicts) を作る。before は巻き戻す前の予定、latest は戻す先の
 * 相手側の内容。
 * - event_create: create_failed (行は残る。「もう一度試す」は POST /v1/calendars/conflicts/:id/retry)。
 * - event_update: write_failed。fields は書き戻し待ちだった項目、lost はその値。
 *   まだ相手側に無い回の例外は行ごと消すので、snapshot にも控える (parentId と recurrenceId 付き)。
 * - event_respond: write_failed。fields は attendees、lost は null、reason は「出欠の返事を
 *   送れませんでした: …」。返事の後に消した予定 (行が無い) でも記録する。
 * - event_delete: write_failed。fields は空 (削除の失敗。予定は相手側の内容で戻る)。
 */
function failureConflict(
  deps: EventOutboxDeps,
  calendar: CalendarRow,
  row: OutboxRow,
  reason: string,
  before: Snapshot | null,
  latest: readonly ResolvedRemoteEvent[] | null | undefined,
): EventConflictInput | null {
  const base = {
    userId: deps.account.userId,
    calendarId: calendar.id,
    reason,
  };
  switch (row.kind) {
    case "event_create": {
      if (!before) return null;
      return {
        ...base,
        eventId: before.event.id,
        kind: "create_failed",
        title: before.event.summary,
      };
    }
    case "event_respond": {
      // 返事のやり直しは詳細の出欠ボタンで行う (巻き戻しで出欠は相手側の値に戻る)。
      // lost に参加者の一覧を入れると、画面の「もう一度試す」が参加者の一覧を PATCH して
      // しまうので入れない (画面は「閉じる」だけを出す)。
      const payload = row.payload as EventRespondPayload;
      return {
        ...base,
        eventId: before?.event.id ?? payload.eventId,
        kind: "write_failed",
        fields: ["attendees"],
        lost: null,
        reason: `出欠の返事を送れませんでした: ${reason}`,
        title: before?.event.summary ?? null,
      };
    }
    case "event_update": {
      if (!before) return null;
      const event = before.event;
      const fields: EventFieldName[] = [
        ...((row.payload as EventUpdatePayload).fields ?? []),
      ];
      const unsent = event.remoteId === null && event.recurrenceId !== null;
      return {
        ...base,
        eventId: event.id,
        kind: "write_failed",
        fields,
        lost: lostValues(event, fields),
        snapshot: unsent ? eventSnapshot(event) : null,
        title: event.summary,
      };
    }
    case "event_delete": {
      const target = (row.payload as EventDeletePayload).target;
      if (!target) return null;
      const remote =
        latest && target.remoteId !== null
          ? findRemote(latest, { ...target, remoteId: target.remoteId })
          : null;
      return {
        ...base,
        eventId: target.eventId,
        kind: "write_failed",
        title: remote?.summary ?? null,
      };
    }
    default:
      return null;
  }
}
