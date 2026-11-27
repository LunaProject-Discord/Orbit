import { ApiError, NetworkError } from "@/lib/api";
import type * as calendarApi from "@/lib/calendar/api";
import type {
  AttendeeStatus,
  Calendar,
  CalendarEvent,
  EventFields,
} from "@/lib/calendar/api";
import type {
  CalendarChanges,
  CreateEventInput,
  QueuedOp,
} from "@/lib/calendar/offline/types";

/**
 * 送信待ち (4 章)。積むときのまとめ方と、1 つの操作を送って結果を分ける処理。
 * 再送の間隔と順番の管理は client.ts (SendOutbox と同じ間隔: 2 秒から倍にして最長 60 秒)。
 */

/** 送信待ちが使う API (テストでは偽物を渡す)。 */
export type QueueApi = Pick<
  typeof calendarApi,
  | "createEvent"
  | "updateEvent"
  | "updateOccurrence"
  | "deleteEvent"
  | "deleteOccurrence"
  | "respondToEvent"
  | "updateCalendar"
>;

let counter = 0;
/** 端末内の順番。Date.now() * 1000 + 連番。 */
export function nextSeq(now: number = Date.now()): number {
  counter = (counter + 1) % 1000;
  return now * 1000 + counter;
}

export const bySeq = (a: QueuedOp, b: QueuedOp) => a.seq - b.seq;

/**
 * まだ送っていない (まとめてよい) 操作か。一度でも送ろうとした操作 (attempted) は、
 * 応答が失われてもサーバーに届いていることがある (作成の再送は既存の行を返すだけ) ので、
 * どのウィンドウもまとめない。
 */
const unsent = (op: QueuedOp, inFlight: string | null) =>
  op.state === "pending" && op.id !== inFlight && !op.attempted;

export type EnqueueResult = {
  /** 積んだ後の送信待ち (seq の順)。 */
  queue: QueuedOp[];
  /** 保存し直す操作。 */
  put: QueuedOp[];
  /** 消す操作の ID。 */
  remove: string[];
};

function mergeChanges(target: QueuedOp, op: QueuedOp): QueuedOp {
  return {
    ...target,
    body: { ...(target.body as object), ...(op.body as object) },
    changedAt: { ...target.changedAt, ...op.changedAt },
    at: op.at,
    // 変える前の値は、最初の操作の前の値を残す。
    before:
      target.before || op.before
        ? { ...(op.before ?? {}), ...(target.before ?? {}) }
        : null,
  };
}

/**
 * 操作を送信待ちに積む (4.3 のまとめ方)。まとめるのは、まだ送っていない操作だけ。
 * related は、その予定に属するほかの予定の ID (原本を消すときの例外)。
 */
export function enqueueOp(
  queue: readonly QueuedOp[],
  op: QueuedOp,
  inFlight: string | null,
  related: ReadonlySet<string> = new Set(),
): EnqueueResult {
  const put: QueuedOp[] = [];
  const remove: string[] = [];
  let next = [...queue];
  const replace = (updated: QueuedOp) => {
    next = next.map((other) => (other.id === updated.id ? updated : other));
    put.push(updated);
  };
  const drop = (ids: string[]) => {
    const set = new Set(ids);
    next = next.filter((other) => !set.has(other.id));
    remove.push(...ids);
  };
  const append = () => {
    next.push(op);
    put.push(op);
  };
  const sameEvent = (other: QueuedOp) =>
    other.eventId !== null &&
    (other.eventId === op.eventId || related.has(other.eventId));

  switch (op.kind) {
    case "update": {
      const create = next.find(
        (other) =>
          other.kind === "create" &&
          other.eventId === op.eventId &&
          unsent(other, inFlight),
      );
      if (create) {
        replace({
          ...mergeChanges(create, op),
          // create の中身は予定全体。at は作った時刻のまま。
          at: create.at,
        });
        break;
      }
      const target = next.find(
        (other) =>
          other.kind === "update" &&
          other.eventId === op.eventId &&
          unsent(other, inFlight),
      );
      // 間に同じ予定へのほかの操作 (まだ送っていない回の操作など) があっても、
      // 項目ごとの時刻で統合されるので、前へまとめてよい。
      if (target) replace(mergeChanges(target, op));
      else append();
      break;
    }
    case "occurrence_update": {
      const target = next.find(
        (other) =>
          other.kind === "occurrence_update" &&
          other.eventId === op.eventId &&
          other.recurrenceId === op.recurrenceId &&
          unsent(other, inFlight),
      );
      if (target) replace(mergeChanges(target, op));
      else append();
      break;
    }
    case "delete": {
      const create = next.find(
        (other) =>
          other.kind === "create" &&
          other.eventId === op.eventId &&
          unsent(other, inFlight),
      );
      const pendingSame = next.filter(
        (other) => sameEvent(other) && unsent(other, inFlight),
      );
      if (create) {
        // まだ送っていない予定を消す: 作成ごと捨てる (サーバーには何も送らない)。
        drop(pendingSame.map((other) => other.id));
        break;
      }
      // 送る前の変更は意味が無くなるので捨て、削除だけを残す。出欠の返事は捨てない
      // (「不参加で返事をして削除」で、主催者へ返事を届けるため。返事が先に送られる)。
      drop(
        pendingSame
          .filter(
            (other) => other.kind !== "delete" && other.kind !== "respond",
          )
          .map((other) => other.id),
      );
      if (!next.some((other) => other.kind === "delete" && sameEvent(other)))
        append();
      break;
    }
    case "occurrence_delete": {
      const pendingSame = next.filter(
        (other) =>
          other.kind === "occurrence_update" &&
          other.eventId === op.eventId &&
          other.recurrenceId === op.recurrenceId &&
          unsent(other, inFlight),
      );
      drop(pendingSame.map((other) => other.id));
      append();
      break;
    }
    case "respond": {
      const target = next.find(
        (other) =>
          other.kind === "respond" &&
          other.eventId === op.eventId &&
          unsent(other, inFlight),
      );
      if (target) replace({ ...target, body: op.body, at: op.at });
      else append();
      break;
    }
    case "calendar_update": {
      const target = next.find(
        (other) =>
          other.kind === "calendar_update" &&
          other.calendarId === op.calendarId &&
          unsent(other, inFlight),
      );
      if (target) replace(mergeChanges(target, op));
      else append();
      break;
    }
    case "create":
      append();
      break;
  }
  next.sort(bySeq);
  return { queue: next, put, remove };
}

/**
 * 次に送る操作。error / blocked の操作と同じ予定 (blocked はそのカレンダー) への後続は、
 * 順番を守るために送らずに待たせる。
 */
export function nextSendable(queue: readonly QueuedOp[]): QueuedOp | null {
  const heldEvents = new Set<string>();
  const heldCalendars = new Set<string>();
  for (const op of [...queue].sort(bySeq)) {
    if (op.state === "blocked") {
      heldCalendars.add(op.calendarId);
      if (op.eventId) heldEvents.add(op.eventId);
      continue;
    }
    if (op.state === "error") {
      if (op.eventId) heldEvents.add(op.eventId);
      continue;
    }
    if (heldCalendars.has(op.calendarId)) continue;
    if (op.eventId && heldEvents.has(op.eventId)) continue;
    return op;
  }
  return null;
}

/** 1 つの操作を送った結果。 */
export type OpOutcome =
  /** 受け付けられた (event / calendar はサーバーの今の値。rejected は負けた項目)。 */
  | {
      type: "done";
      event?: CalendarEvent | null;
      calendar?: Calendar | null;
      rejected?: (keyof EventFields)[];
      /** 作成の再送が、ほかの端末の削除の後に届いた (410)。 */
      gone?: boolean;
      /** 消えていた (404 を成功として扱った)。 */
      missing?: boolean;
    }
  /** 届かない、429、5xx。時間を置いてやり直す。 */
  | { type: "retry" }
  /** 401。次のログインで続きを送る。 */
  | { type: "stop" }
  /** 409 calendar_sync_stopped / calendar_disabled。 */
  | { type: "blocked"; code: string }
  /** 409 changed_since (削除の後にほかの端末で変更されていた)。 */
  | { type: "changed_since"; event: CalendarEvent | null }
  /** そのほかの断り (deleted_elsewhere、invalid、read_only など)。 */
  | { type: "error"; code: string };

function classify(op: QueuedOp, error: unknown): OpOutcome {
  if (error instanceof NetworkError) return { type: "retry" };
  if (!(error instanceof ApiError)) return { type: "retry" };
  const { status, code } = error;
  if (status === 429 || status >= 500) return { type: "retry" };
  if (status === 401) return { type: "stop" };
  if (
    status === 409 &&
    (code === "calendar_sync_stopped" || code === "calendar_disabled")
  ) {
    return { type: "blocked", code };
  }
  if (status === 409 && code === "changed_since") {
    const body = error.body as { event?: CalendarEvent } | null;
    return { type: "changed_since", event: body?.event ?? null };
  }
  if (status === 410 && op.kind === "create") {
    return { type: "done", gone: true };
  }
  if (status === 404) {
    switch (op.kind) {
      case "delete":
      case "occurrence_delete":
      case "calendar_update":
        return { type: "done", missing: true };
      case "respond":
        // ルートの無い古いサーバー (コード無し) と、予定が消えた場合を分ける。
        // どちらも返事を捨てて後続を通す (client の settle)。
        return {
          type: "error",
          code: code === null ? "unsupported" : "not_found",
        };
      default:
        return { type: "error", code: "deleted_elsewhere" };
    }
  }
  return { type: "error", code: code ?? `http_${status}` };
}

/** 1 つの操作を API へ送る。now は送る瞬間の端末の時刻 (clientNow)。 */
export async function sendOp(
  api: QueueApi,
  op: QueuedOp,
  now: Date = new Date(),
): Promise<OpOutcome> {
  try {
    switch (op.kind) {
      case "create": {
        const event = await api.createEvent(op.body as CreateEventInput, {
          changedAt: op.at,
          clientNow: now,
        });
        return { type: "done", event };
      }
      case "update": {
        const result = await api.updateEvent(
          op.eventId as string,
          op.body as EventFields,
          op.changedAt,
          now,
        );
        return {
          type: "done",
          event: result.event,
          rejected: result.rejected ?? [],
        };
      }
      case "occurrence_update": {
        const result = await api.updateOccurrence(
          op.eventId as string,
          op.recurrenceId as string,
          op.body as EventFields,
          op.changedAt,
          now,
        );
        return {
          type: "done",
          event: result.event,
          rejected: result.rejected ?? [],
        };
      }
      case "delete":
        await api.deleteEvent(op.eventId as string, {
          deletedAt: op.at,
          clientNow: now,
        });
        return { type: "done" };
      case "occurrence_delete":
        await api.deleteOccurrence(
          op.eventId as string,
          op.recurrenceId as string,
          { changedAt: op.at, clientNow: now },
        );
        return { type: "done" };
      case "respond": {
        const event = await api.respondToEvent(op.eventId as string, {
          status: (op.body as { status: AttendeeStatus }).status,
          respondedAt: op.at,
          clientNow: now,
        });
        return { type: "done", event };
      }
      case "calendar_update": {
        const calendar = await api.updateCalendar(
          op.calendarId,
          op.body as CalendarChanges,
        );
        return { type: "done", calendar };
      }
    }
  } catch (error) {
    return classify(op, error);
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function pickKeys<T extends object>(value: T | null, keys: string[]): T {
  const picked = {} as Record<string, unknown>;
  for (const key of keys) {
    if (value && key in value)
      picked[key] = (value as Record<string, unknown>)[key];
  }
  return picked as T;
}

/**
 * 送った後に保存先の操作を読み直したら、送った内容と違っていた (ほかのウィンドウが
 * 送っている最中の印を見る前にまとめた) ときの、まだ送っていない残り。違いが無ければ null。
 * 返す操作は stored の ID と順番のまま (呼び出し側で新しい ID を付ける)。
 */
export function remainderOf(sent: QueuedOp, stored: QueuedOp): QueuedOp | null {
  if (same(sent.body, stored.body) && same(sent.changedAt, stored.changedAt)) {
    return null;
  }
  const changedKeys = (skip: readonly string[] = []) => {
    const before = (sent.body ?? {}) as Record<string, unknown>;
    const after = (stored.body ?? {}) as Record<string, unknown>;
    return Object.keys(after).filter(
      (key) =>
        !skip.includes(key) &&
        (!(key in before) ||
          !same(before[key], after[key]) ||
          sent.changedAt[key] !== stored.changedAt[key]),
    );
  };
  const rest = {
    ...stored,
    attempted: false,
    state: "pending" as const,
    error: null,
  };
  switch (stored.kind) {
    case "update":
    case "occurrence_update":
    case "calendar_update": {
      const keys = changedKeys();
      if (keys.length === 0) return null;
      return {
        ...rest,
        body: pickKeys(stored.body as object, keys),
        changedAt: pickKeys(stored.changedAt, keys),
        before: stored.before ? pickKeys(stored.before, keys) : null,
      };
    }
    case "create": {
      // 作成に後からまとめられた変更は、その予定への変更として送る。
      const keys = changedKeys(["id", "calendarId"]);
      if (keys.length === 0) return null;
      return {
        ...rest,
        kind: "update",
        body: pickKeys(stored.body as EventFields, keys),
        changedAt: pickKeys(stored.changedAt, keys),
        before: null,
      };
    }
    case "respond":
      return same(sent.body, stored.body) ? null : rest;
    default:
      return null;
  }
}
