import { describe, expect, it } from "vitest";
import {
  changedEventFields,
  EVENT_FIELD_NAMES,
  type EventFieldName,
  type EventFieldSource,
  eventFieldValues,
  mergeEventFields,
} from "./event-merge.js";

function source(overrides: Partial<EventFieldSource> = {}): EventFieldSource {
  return {
    summary: "定例",
    location: null,
    description: null,
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: "2026-12-01T10:00:00+09:00",
    endAt: "2026-12-01T11:00:00+09:00",
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    endTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: null,
    exdates: null,
    conferenceUrl: null,
    reminders: null,
    attendees: [],
    ...overrides,
  };
}

const values = (overrides: Partial<EventFieldSource> = {}) =>
  eventFieldValues(source(overrides));

const now = new Date("2026-12-01T00:00:00.000Z");

describe("EVENT_FIELD_NAMES", () => {
  it("API の eventFields と同じ項目を持つ", () => {
    expect([...EVENT_FIELD_NAMES].sort()).toEqual(
      [
        "attendees",
        "busy",
        "conferenceUrl",
        "description",
        "location",
        "recurrence",
        "reminders",
        "status",
        "summary",
        "time",
        "useDefaultReminders",
      ].sort(),
    );
  });
});

describe("eventFieldValues / changedEventFields", () => {
  it("同じ予定なら変わった項目は無い", () => {
    expect(changedEventFields(values(), values())).toEqual([]);
  });

  it("時刻の書き方 (オフセット、ミリ秒、Date) が違っても同じ値になる", () => {
    const a = values();
    const b = values({
      startAt: new Date("2026-12-01T01:00:00.000Z"),
      endAt: "2026-12-01T02:00:00Z",
    });
    expect(changedEventFields(a, b)).toEqual([]);
    expect(a.time).toEqual({
      allDay: false,
      startAt: "2026-12-01T01:00:00.000Z",
      endAt: "2026-12-01T02:00:00.000Z",
      startTimeZone: "Asia/Tokyo",
      endTimeZone: "Asia/Tokyo",
    });
  });

  it("終わりのタイムゾーンが無ければ始まりのタイムゾーンとみなす", () => {
    expect(changedEventFields(values(), values({ endTimeZone: null }))).toEqual(
      [],
    );
    expect(
      changedEventFields(values(), values({ startTimeZone: "UTC" })),
    ).toEqual(["time"]);
  });

  it("終日の予定は日付で比べ、終わりが無ければ翌日とみなす", () => {
    const allDay = {
      allDay: true,
      startAt: null,
      endAt: null,
      startTimeZone: null,
      endTimeZone: null,
      startDate: "2026-12-01",
    };
    const a = values({ ...allDay, endDate: "2026-12-02" });
    const b = values({ ...allDay, endDate: null });
    expect(changedEventFields(a, b)).toEqual([]);
    expect(changedEventFields(a, values())).toEqual(["time"]);
  });

  it("参加者はアドレスの順に並べ、大文字小文字の違いを無視する", () => {
    const a = values({
      attendees: [
        { email: "b@example.com", name: "B", role: "required" },
        { email: "A@Example.com", name: null, role: "optional" },
      ],
    });
    const b = values({
      attendees: [
        { email: "a@example.com", name: "", role: "optional" },
        { email: "b@example.com", name: "B", role: "required" },
      ],
    });
    expect(changedEventFields(a, b)).toEqual([]);
    const c = values({
      attendees: [
        { email: "a@example.com", name: null, role: "required" },
        { email: "b@example.com", name: "B", role: "required" },
      ],
    });
    expect(changedEventFields(a, c)).toEqual(["attendees"]);
  });

  it("参加者の出欠が変われば attendees が変わったとみなす", () => {
    const attendee = { email: "a@example.com", name: null, role: "required" };
    expect(
      changedEventFields(
        values({ attendees: [{ ...attendee, status: "needs_action" }] }),
        values({ attendees: [{ ...attendee, status: "accepted" }] }),
      ),
    ).toEqual(["attendees"]);
  });

  it("繰り返しの回は recurrenceId の書き方にそろえ、順番と重複を無視する", () => {
    const a = values({
      rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
      exdates: ["2026-12-08T10:00:00.000+09:00", "2026-12-15T01:00:00Z"],
      rdates: [],
    });
    const b = values({
      rrule: "freq=weekly;byday=MO",
      exdates: [
        "2026-12-15T01:00:00.000Z",
        "2026-12-08T01:00:00Z",
        "2026-12-08T01:00:00Z",
      ],
      rdates: null,
    });
    expect(changedEventFields(a, b)).toEqual([]);
    expect(a.recurrence).toEqual({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      rdates: [],
      exdates: ["2026-12-08T01:00:00Z", "2026-12-15T01:00:00Z"],
    });
    expect(
      changedEventFields(a, values({ rrule: "FREQ=WEEKLY;BYDAY=TU" })),
    ).toEqual(["recurrence"]);
  });

  it("RRULE の部分の順番が違っても同じ値になる", () => {
    expect(
      changedEventFields(
        values({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" }),
        values({ rrule: "BYDAY=MO;FREQ=WEEKLY;INTERVAL=2" }),
      ),
    ).toEqual([]);
  });

  it("空の文字列は null と、CRLF は LF と同じに扱う", () => {
    expect(
      changedEventFields(
        values({ summary: "", description: "1 行目\r\n2 行目" }),
        values({ summary: null, description: "1 行目\n2 行目" }),
      ),
    ).toEqual([]);
  });

  it("リマインダーは順番を無視し、useDefaultReminders は省けば reminders が null かで決める", () => {
    const a = values({
      reminders: [
        { method: "email", minutes: 30 },
        { method: "display", minutes: 10 },
      ],
    });
    const b = values({
      useDefaultReminders: false,
      reminders: [
        { method: "display", minutes: 10 },
        { method: "email", minutes: 30 },
      ],
    });
    expect(changedEventFields(a, b)).toEqual([]);
    expect(values().useDefaultReminders).toBe(true);
    expect(
      changedEventFields(
        values({ useDefaultReminders: true, reminders: [] }),
        values(),
      ),
    ).toEqual([]);
    expect(changedEventFields(values(), a)).toEqual([
      "useDefaultReminders",
      "reminders",
    ]);
  });

  it("変わった項目を EVENT_FIELD_NAMES の順に返す", () => {
    expect(
      changedEventFields(
        values(),
        values({ busy: false, summary: "別", location: "会議室" }),
      ),
    ).toEqual(["summary", "location", "busy"]);
  });
});

describe("mergeEventFields", () => {
  const merge = (
    input: Partial<Parameters<typeof mergeEventFields>[0]> & {
      local: ReturnType<typeof values>;
      remote: ReturnType<typeof values>;
    },
  ) =>
    mergeEventFields({
      base: values(),
      localFieldAt: {},
      localPending: new Set<EventFieldName>(),
      remoteUpdatedAt: "2026-11-30T12:00:00.000Z",
      now,
      ...input,
    });

  it("別の項目が変わったなら両方を採る", () => {
    const result = merge({
      local: values({ summary: "ローカル" }),
      remote: values({ location: "相手側" }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-30T13:00:00.000Z" },
    });
    expect(result.takeRemote).toEqual(["location"]);
    expect(result.keepLocal).toEqual(["summary"]);
    expect(result.lostLocal).toEqual([]);
    expect(result.fieldUpdatedAt).toEqual({
      summary: "2026-11-30T13:00:00.000Z",
      location: "2026-11-30T12:00:00.000Z",
    });
  });

  it("相手側だけが変わった項目は相手側を採る", () => {
    const result = merge({
      local: values(),
      remote: values({ summary: "相手側" }),
    });
    expect(result.takeRemote).toEqual(["summary"]);
    expect(result.keepLocal).toEqual([]);
  });

  it("同じ項目が両方で変わったら、新しい方を採る", () => {
    const local = values({ summary: "ローカル" });
    const remote = values({ summary: "相手側" });
    const localNewer = merge({
      local,
      remote,
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-30T13:00:00.000Z" },
    });
    expect(localNewer.keepLocal).toEqual(["summary"]);
    expect(localNewer.takeRemote).toEqual([]);
    expect(localNewer.fieldUpdatedAt.summary).toBe("2026-11-30T13:00:00.000Z");

    const remoteNewer = merge({
      local,
      remote,
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-30T11:00:00.000Z" },
    });
    expect(remoteNewer.takeRemote).toEqual(["summary"]);
    expect(remoteNewer.lostLocal).toEqual(["summary"]);
    expect(remoteNewer.fieldUpdatedAt.summary).toBe("2026-11-30T12:00:00.000Z");
  });

  it("同じ時刻ならローカルを残す", () => {
    const result = merge({
      local: values({ summary: "ローカル" }),
      remote: values({ summary: "相手側" }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-30T12:00:00.000Z" },
    });
    expect(result.keepLocal).toEqual(["summary"]);
  });

  it("相手側に時刻が無ければ相手側を採り、fieldUpdatedAt は now にする", () => {
    const result = merge({
      local: values({ summary: "ローカル" }),
      remote: values({ summary: "相手側" }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-30T23:00:00.000Z" },
      remoteUpdatedAt: null,
    });
    expect(result.takeRemote).toEqual(["summary"]);
    expect(result.lostLocal).toEqual(["summary"]);
    expect(result.fieldUpdatedAt.summary).toBe(now.toISOString());
  });

  it("base が無ければ、未送信の項目だけローカルを残し、ほかは相手側を採る", () => {
    const result = merge({
      base: null,
      local: values({ summary: "ローカル", location: "ローカルの場所" }),
      remote: values({ summary: "相手側", busy: false }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-01T00:00:00.000Z" },
    });
    expect(result.keepLocal).toEqual(["summary"]);
    expect(result.takeRemote).toEqual(["location", "busy"]);
    expect(result.lostLocal).toEqual([]);
  });

  it("相手側が変わっていなければ、未送信のローカルの変更を残す", () => {
    const result = merge({
      local: values({ summary: "ローカル" }),
      remote: values(),
      localPending: new Set(["summary"]),
    });
    expect(result.keepLocal).toEqual(["summary"]);
    expect(result.takeRemote).toEqual([]);
  });

  it("ローカルと相手側が同じ値なら、どの一覧にも入れない", () => {
    const result = merge({
      local: values({ summary: "同じ" }),
      remote: values({ summary: "同じ" }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2026-11-01T00:00:00.000Z" },
    });
    expect(result).toEqual({
      takeRemote: [],
      keepLocal: [],
      lostLocal: [],
      fieldUpdatedAt: { summary: "2026-11-01T00:00:00.000Z" },
    });
  });

  it("未来の時刻は now に丸めてから比べる", () => {
    // 相手側の時計が進んでいても、now より後とはみなさない。
    const remoteFuture = merge({
      local: values({ summary: "ローカル" }),
      remote: values({ summary: "相手側" }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: now.toISOString() },
      remoteUpdatedAt: "2027-01-01T00:00:00.000Z",
    });
    expect(remoteFuture.keepLocal).toEqual(["summary"]);

    // 相手側を採るときも、fieldUpdatedAt に未来の時刻は入れない。
    const taken = merge({
      local: values(),
      remote: values({ summary: "相手側" }),
      remoteUpdatedAt: "2027-01-01T00:00:00.000Z",
    });
    expect(taken.fieldUpdatedAt.summary).toBe(now.toISOString());

    // ローカルの未来の時刻も丸めるので、now より前の相手側の変更には勝つが、
    // 丸めた後の now と同じ相手側には負けない (同じ時刻はローカル)。
    const localFuture = merge({
      local: values({ summary: "ローカル" }),
      remote: values({ summary: "相手側" }),
      localPending: new Set(["summary"]),
      localFieldAt: { summary: "2027-01-01T00:00:00.000Z" },
      remoteUpdatedAt: "2026-11-30T23:59:59.000Z",
    });
    expect(localFuture.keepLocal).toEqual(["summary"]);
  });

  it("未送信の項目に時刻が無ければ相手側を採る", () => {
    const result = merge({
      local: values({ summary: "ローカル" }),
      remote: values({ summary: "相手側" }),
      localPending: new Set(["summary"]),
    });
    expect(result.takeRemote).toEqual(["summary"]);
    expect(result.lostLocal).toEqual(["summary"]);
  });
});
