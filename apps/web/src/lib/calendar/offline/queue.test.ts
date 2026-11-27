import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "@/lib/api";
import {
  enqueueOp,
  nextSendable,
  type QueueApi,
  sendOp,
} from "@/lib/calendar/offline/queue";
import { CALENDAR_ID, event } from "@/lib/calendar/offline/test-support";
import type { QueuedOp } from "@/lib/calendar/offline/types";

let seq = 0;
function op(overrides: Partial<QueuedOp>): QueuedOp {
  seq += 1;
  return {
    id: `op${seq}`,
    seq,
    kind: "update",
    calendarId: CALENDAR_ID,
    eventId: "e1",
    recurrenceId: null,
    body: {},
    changedAt: {},
    at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    before: null,
    state: "pending",
    error: null,
    ...overrides,
  };
}

describe("enqueueOp (積むときのまとめ)", () => {
  it("同じ予定への update は 1 つにまとめる (項目ごとに新しい値と時刻)", () => {
    const first = op({
      body: { summary: "A", location: "X" },
      changedAt: { summary: "t1", location: "t1" },
      before: { summary: "元" },
    });
    const second = op({
      body: { summary: "B" },
      changedAt: { summary: "t2" },
      before: { summary: "A" },
    });
    const result = enqueueOp([first], second, null);
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0]).toMatchObject({
      id: first.id,
      body: { summary: "B", location: "X" },
      changedAt: { summary: "t2", location: "t1" },
      before: { summary: "元" },
    });
    expect(result.put.map((o) => o.id)).toEqual([first.id]);
  });

  it("送っている最中の update には混ぜず、次の操作として積む", () => {
    const first = op({ body: { summary: "A" } });
    const second = op({ body: { summary: "B" } });
    const result = enqueueOp([first], second, first.id);
    expect(result.queue.map((o) => o.id)).toEqual([first.id, second.id]);
  });

  it("未送信の create の後の update は、create の中身に入れる", () => {
    const create = op({
      kind: "create",
      body: { id: "e1", calendarId: CALENDAR_ID, summary: "A" },
    });
    const update = op({ body: { location: "会議室" } });
    const result = enqueueOp([create], update, null);
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0]?.body).toMatchObject({
      id: "e1",
      summary: "A",
      location: "会議室",
    });
    expect(result.queue[0]?.at).toBe(create.at);
  });

  it("未送信の create の後の delete は、両方を捨てる", () => {
    const create = op({ kind: "create", body: { id: "e1" } });
    const update = op({ kind: "occurrence_update", recurrenceId: "r" });
    const result = enqueueOp([create, update], op({ kind: "delete" }), null);
    expect(result.queue).toEqual([]);
    expect(result.remove.sort()).toEqual([create.id, update.id].sort());
    expect(result.put).toEqual([]);
  });

  it("update の後の delete は、update を捨てて delete だけ残す (例外への変更も)", () => {
    const update = op({ body: { summary: "A" } });
    const exception = op({ eventId: "x1", body: { summary: "回" } });
    const other = op({ eventId: "e2", body: { summary: "別" } });
    const remove = op({ kind: "delete" });
    const result = enqueueOp(
      [update, exception, other],
      remove,
      null,
      new Set(["x1"]),
    );
    expect(result.queue.map((o) => o.id)).toEqual([other.id, remove.id]);
  });

  it("respond の後の delete は、respond を残して後ろに delete を積む (不参加にして削除)", () => {
    const update = op({ body: { reminders: [] } });
    const respond = op({ kind: "respond", body: { status: "declined" } });
    const remove = op({ kind: "delete" });
    const result = enqueueOp([update, respond], remove, null);
    expect(result.queue.map((o) => [o.kind, o.id])).toEqual([
      ["respond", respond.id],
      ["delete", remove.id],
    ]);
    expect(result.remove).toEqual([update.id]);
    // 送る順は返事が先。
    expect(nextSendable(result.queue)?.id).toBe(respond.id);
  });

  it("未送信の create の後の respond と delete は、どれも送らない", () => {
    const create = op({ kind: "create", body: { id: "e1" } });
    const respond = op({ kind: "respond", body: { status: "declined" } });
    const result = enqueueOp([create, respond], op({ kind: "delete" }), null);
    expect(result.queue).toEqual([]);
  });

  it("送っている最中の create の後の delete は、積む", () => {
    const create = op({ kind: "create", body: { id: "e1" } });
    const remove = op({ kind: "delete" });
    const result = enqueueOp([create], remove, create.id);
    expect(result.queue.map((o) => o.id)).toEqual([create.id, remove.id]);
  });

  it("同じ回への変更はまとめ、回の削除はその回の未送信の変更を捨てる", () => {
    const first = op({
      kind: "occurrence_update",
      recurrenceId: "2026-03-09T01:00:00Z",
      body: { summary: "A" },
    });
    const second = op({
      kind: "occurrence_update",
      recurrenceId: "2026-03-09T01:00:00Z",
      body: { location: "B" },
    });
    const merged = enqueueOp([first], second, null).queue;
    expect(merged).toHaveLength(1);
    expect(merged[0]?.body).toEqual({ summary: "A", location: "B" });
    const removed = enqueueOp(
      merged,
      op({ kind: "occurrence_delete", recurrenceId: "2026-03-09T01:00:00Z" }),
      null,
    ).queue;
    expect(removed.map((o) => o.kind)).toEqual(["occurrence_delete"]);
  });

  it("error の操作にはまとめない", () => {
    const failed = op({ state: "error", error: "read_only" });
    const next = op({ body: { summary: "B" } });
    expect(enqueueOp([failed], next, null).queue).toHaveLength(2);
  });
});

describe("nextSendable", () => {
  it("error の操作と同じ予定への後続は待たせ、ほかの予定は送る", () => {
    const failed = op({ state: "error", error: "read_only" });
    const same = op({});
    const other = op({ eventId: "e2" });
    expect(nextSendable([failed, same, other])?.id).toBe(other.id);
  });

  it("blocked のカレンダーの操作は飛ばす", () => {
    const blocked = op({ state: "blocked", error: "calendar_sync_stopped" });
    const sameCalendar = op({ eventId: "e2" });
    const otherCalendar = op({ eventId: "e3", calendarId: "c2" });
    expect(nextSendable([blocked, sameCalendar, otherCalendar])?.id).toBe(
      otherCalendar.id,
    );
  });
});

describe("sendOp (結果の分け方)", () => {
  const failing = (error: unknown): QueueApi =>
    new Proxy({} as QueueApi, {
      get: () => async () => {
        throw error;
      },
    });

  it.each([
    [new NetworkError(), { type: "retry" }],
    [new ApiError(503, null, null), { type: "retry" }],
    [new ApiError(429, "rate_limited", null), { type: "retry" }],
    [new ApiError(401, "unauthorized", null), { type: "stop" }],
    [
      new ApiError(409, "calendar_sync_stopped", null),
      { type: "blocked", code: "calendar_sync_stopped" },
    ],
    [
      new ApiError(409, "calendar_disabled", null),
      { type: "blocked", code: "calendar_disabled" },
    ],
    [
      new ApiError(404, "not_found", null),
      { type: "error", code: "deleted_elsewhere" },
    ],
    [
      new ApiError(409, "read_only", null),
      { type: "error", code: "read_only" },
    ],
  ])("update: %s", async (error, expected) => {
    expect(await sendOp(failing(error), op({ body: {} }))).toEqual(expected);
  });

  it("delete の 404 は「もう消えている」= 成功", async () => {
    const result = await sendOp(
      failing(new ApiError(404, "not_found", null)),
      op({ kind: "delete" }),
    );
    expect(result).toEqual({ type: "done", missing: true });
  });

  it("delete の 409 changed_since は、応答の予定を返す", async () => {
    const current = event({ id: "e1" });
    const result = await sendOp(
      failing(
        new ApiError(409, "changed_since", {
          error: "changed_since",
          event: current,
        }),
      ),
      op({ kind: "delete" }),
    );
    expect(result).toEqual({ type: "changed_since", event: current });
  });

  it("create の 410 gone は成功として扱う", async () => {
    const result = await sendOp(
      failing(new ApiError(410, "gone", null)),
      op({ kind: "create", body: { id: "e1" } }),
    );
    expect(result).toEqual({ type: "done", gone: true });
  });

  it("回の変更の 400 invalid は error", async () => {
    const result = await sendOp(
      failing(new ApiError(400, "invalid", null)),
      op({ kind: "occurrence_update", recurrenceId: "r", body: {} }),
    );
    expect(result).toEqual({ type: "error", code: "invalid" });
  });

  it.each([
    "not_attendee",
    "organizer",
    "cancelled",
  ])("respond の 409 %s は error として残す", async (code) => {
    const result = await sendOp(
      failing(new ApiError(409, code, { error: code })),
      op({ kind: "respond", body: { status: "accepted" } }),
    );
    expect(result).toEqual({ type: "error", code });
  });

  it("respond の 404 は、ルートの無い古いサーバー (コード無し) と予定が消えた場合を分ける", async () => {
    const respond = op({ kind: "respond", body: { status: "accepted" } });
    expect(
      await sendOp(failing(new ApiError(404, null, null)), respond),
    ).toEqual({ type: "error", code: "unsupported" });
    expect(
      await sendOp(failing(new ApiError(404, "not_found", null)), respond),
    ).toEqual({ type: "error", code: "not_found" });
  });

  it("送信待ちの時刻 (操作した時刻) と送る瞬間の時刻を渡す", async () => {
    const calls: unknown[] = [];
    const api = {
      updateEvent: async (...args: unknown[]) => {
        calls.push(args);
        return { event: event({ id: "e1" }), rejected: ["summary"] };
      },
      deleteEvent: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as QueueApi;
    const now = new Date("2026-01-01T01:00:00Z");
    const update = op({
      body: { summary: "A" },
      changedAt: { summary: "2026-01-01T00:10:00.000Z" },
    });
    expect(await sendOp(api, update, now)).toMatchObject({
      type: "done",
      rejected: ["summary"],
    });
    const remove = op({ kind: "delete", at: "2026-01-01T00:20:00.000Z" });
    await sendOp(api, remove, now);
    expect(calls).toEqual([
      ["e1", { summary: "A" }, { summary: "2026-01-01T00:10:00.000Z" }, now],
      ["e1", { deletedAt: "2026-01-01T00:20:00.000Z", clientNow: now }],
    ]);
  });
});
