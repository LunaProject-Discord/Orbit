import { describe, expect, it } from "vitest";
import { expandRange } from "@/lib/calendar/offline/expand";
import {
  applyFields,
  overlay,
  provisionalExceptionId,
} from "@/lib/calendar/offline/overlay";
import {
  CALENDAR_ID,
  calendar,
  event,
} from "@/lib/calendar/offline/test-support";
import type { QueuedOp } from "@/lib/calendar/offline/types";

const RANGE = { from: "2026-03-01", to: "2026-03-31", timeZone: "Asia/Tokyo" };

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
    at: "2026-01-01T00:00:00.000Z",
    before: null,
    state: "pending",
    error: null,
    ...overrides,
  };
}

const weekly = event({
  id: "m1",
  rrule: "FREQ=WEEKLY;COUNT=4",
  startAt: "2026-03-02T01:00:00.000Z",
  endAt: "2026-03-02T02:00:00.000Z",
});

const base = (...events: ReturnType<typeof event>[]) =>
  new Map(events.map((e) => [e.id, e]));
const calendars = new Map([[CALENDAR_ID, calendar()]]);

describe("overlay", () => {
  it("create は仮の予定として出る", () => {
    const view = overlay(base(), calendars, [
      op({
        kind: "create",
        eventId: "n1",
        body: {
          id: "n1",
          calendarId: CALENDAR_ID,
          summary: "新しい予定",
          time: {
            allDay: true,
            startDate: "2026-03-05",
            endDate: "2026-03-06",
          },
        },
      }),
    ]);
    expect(view.events.get("n1")).toMatchObject({
      summary: "新しい予定",
      allDay: true,
      startDate: "2026-03-05",
    });
  });

  it("update は項目を当て、base は書き換えない", () => {
    const original = event({ id: "e1" });
    const events = base(original);
    const view = overlay(events, calendars, [
      op({ body: { summary: "変更", location: "会議室" } }),
    ]);
    expect(view.events.get("e1")).toMatchObject({
      summary: "変更",
      location: "会議室",
    });
    expect(events.get("e1")).toBe(original);
  });

  it("error の操作は重ねない", () => {
    const view = overlay(base(event({ id: "e1" })), calendars, [
      op({ body: { summary: "変更" }, state: "error", error: "read_only" }),
    ]);
    expect(view.events.get("e1")?.summary).toBe("定例");
  });

  it("delete は予定と例外を消し、例外の削除は原本の EXDATE に足す", () => {
    const exception = event({
      id: "x1",
      parentId: "m1",
      recurrenceId: "2026-03-09T01:00:00Z",
    });
    const view = overlay(base(weekly, exception), calendars, [
      op({ kind: "delete", eventId: "x1" }),
    ]);
    expect(view.events.has("x1")).toBe(false);
    expect(view.events.get("m1")?.exdates).toEqual(["2026-03-09T01:00:00Z"]);
    const all = overlay(base(weekly, exception), calendars, [
      op({ kind: "delete", eventId: "m1" }),
    ]);
    expect([...all.events.keys()]).toEqual([]);
  });

  it("この回だけ変更: 仮の例外 (原本の ID:recurrenceId) を重ねる", () => {
    const view = overlay(base(weekly), calendars, [
      op({
        kind: "occurrence_update",
        eventId: "m1",
        recurrenceId: "2026-03-09T01:00:00.000Z",
        body: { summary: "この回だけ" },
      }),
    ]);
    const id = provisionalExceptionId("m1", "2026-03-09T01:00:00Z");
    expect(view.events.get(id)).toMatchObject({
      parentId: "m1",
      recurrenceId: "2026-03-09T01:00:00Z",
      summary: "この回だけ",
      startAt: "2026-03-09T01:00:00.000Z",
      endAt: "2026-03-09T02:00:00.000Z",
      rrule: null,
    });
    const range = expandRange(view.events.values(), RANGE);
    expect(
      range.occurrences.map((o) => [o.eventId, o.recurrenceId, o.startAt]),
    ).toEqual([
      ["m1", "2026-03-02T01:00:00Z", "2026-03-02T01:00:00Z"],
      [id, "2026-03-09T01:00:00Z", "2026-03-09T01:00:00Z"],
      ["m1", "2026-03-16T01:00:00Z", "2026-03-16T01:00:00Z"],
      ["m1", "2026-03-23T01:00:00Z", "2026-03-23T01:00:00Z"],
    ]);
  });

  it("サーバーの例外と入れ替わっても、表示 (回の時刻と中身) は変わらない", () => {
    const pending = op({
      kind: "occurrence_update",
      eventId: "m1",
      recurrenceId: "2026-03-09T01:00:00Z",
      body: { summary: "この回だけ" },
    });
    const before = expandRange(
      overlay(base(weekly), calendars, [pending]).events.values(),
      RANGE,
    );
    const server = applyFields(
      event({
        id: "x-server",
        parentId: "m1",
        recurrenceId: "2026-03-09T01:00:00Z",
        startAt: "2026-03-09T01:00:00.000Z",
        endAt: "2026-03-09T02:00:00.000Z",
      }),
      { summary: "この回だけ" },
    );
    const after = expandRange(
      overlay(base(weekly, server), calendars, []).events.values(),
      RANGE,
    );
    const shape = (range: typeof before) =>
      range.occurrences.map((o) => {
        const e = range.events.find((x) => x.id === o.eventId);
        return [o.recurrenceId, o.startAt, e?.summary];
      });
    expect(shape(after)).toEqual(shape(before));
  });

  it("この回だけ削除: EXDATE に足し、例外があれば隠す", () => {
    const exception = event({
      id: "x1",
      parentId: "m1",
      recurrenceId: "2026-03-09T01:00:00Z",
      startAt: "2026-03-09T05:00:00.000Z",
      endAt: "2026-03-09T06:00:00.000Z",
    });
    const view = overlay(base(weekly, exception), calendars, [
      op({
        kind: "occurrence_delete",
        eventId: "m1",
        recurrenceId: "2026-03-09T01:00:00Z",
      }),
    ]);
    expect(view.events.has("x1")).toBe(false);
    const range = expandRange(view.events.values(), RANGE);
    expect(range.occurrences.map((o) => o.recurrenceId)).toEqual([
      "2026-03-02T01:00:00Z",
      "2026-03-16T01:00:00Z",
      "2026-03-23T01:00:00Z",
    ]);
  });

  it("出欠は自分の参加者の状態を変える", () => {
    const invited = event({
      id: "e1",
      attendees: [
        {
          email: "me@example.com",
          name: null,
          role: "required",
          status: "needs_action",
          self: true,
        },
      ],
    });
    const view = overlay(base(invited), calendars, [
      op({ kind: "respond", body: { status: "accepted" } }),
    ]);
    expect(view.events.get("e1")?.attendees[0]?.status).toBe("accepted");
  });

  it("カレンダーの変更 (表示のオンオフ) を重ねる", () => {
    const view = overlay(base(), calendars, [
      op({
        kind: "calendar_update",
        eventId: null,
        body: { visible: false },
      }),
    ]);
    expect(view.calendars.get(CALENDAR_ID)?.visible).toBe(false);
  });
});
