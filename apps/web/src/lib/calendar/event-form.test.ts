import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import type { Attendee, CalendarEvent } from "@/lib/calendar/api";
import { toLocal } from "@/lib/calendar/dates";
import {
  attendeeEditableChanges,
  type EventForm,
  eventFormOf,
  formChanges,
  inviteFormView,
  newEventForm,
} from "@/lib/calendar/event-form";
import { event } from "@/lib/calendar/offline/test-support";

const TZ = "Asia/Tokyo";

const person = (
  email: string,
  overrides: Partial<Attendee> = {},
): Attendee => ({
  email,
  name: null,
  role: "required",
  status: "needs_action",
  self: false,
  ...overrides,
});

function formOf(value: CalendarEvent): EventForm {
  const local = toLocal(
    {
      eventId: value.id,
      masterId: value.id,
      recurrenceId: null,
      allDay: value.allDay,
      startAt: value.startAt,
      endAt: value.endAt,
      startDate: value.startDate,
      endDate: value.endDate,
    },
    TZ,
  );
  if (!local) throw new Error("local");
  return eventFormOf(value, local);
}

const meeting = event({
  organizer: { email: "me@example.com", self: true },
  attendees: [
    person("me@example.com", { self: true, status: "accepted" }),
    person("tanaka@example.com", { name: "田中", role: "optional" }),
  ],
});

describe("参加者の入出力", () => {
  it("自分は欄に出さず、ほかの参加者を札にする", () => {
    const form = formOf(meeting);
    expect(form.attendees.list).toEqual([
      { name: "田中", address: "tanaka@example.com" },
    ]);
    expect(form.busy).toBe(true);
  });

  it("参加者を変えなければ attendees を送らない", () => {
    const before = formOf(meeting);
    const changes = formChanges(
      { ...before, summary: "新しい題名" },
      TZ,
      before,
    );
    expect(changes).toEqual({ summary: "新しい題名" });
  });

  it("足すと、自分の行と既にいた人の役割を引き継いで送る (打ちかけのアドレスも含める)", () => {
    const before = formOf(meeting);
    const form: EventForm = {
      ...before,
      attendees: {
        list: [
          ...before.attendees.list,
          { name: "鈴木", address: "suzuki@example.com" },
        ],
        text: "sato@example.com",
      },
    };
    expect(formChanges(form, TZ, before)?.attendees).toEqual([
      { email: "me@example.com", name: null, role: "required" },
      { email: "tanaka@example.com", name: "田中", role: "optional" },
      { email: "suzuki@example.com", name: "鈴木", role: "required" },
      { email: "sato@example.com", name: null, role: "required" },
    ]);
  });

  it("外すと、残りだけを送る", () => {
    const before = formOf(meeting);
    const form: EventForm = { ...before, attendees: { list: [], text: "" } };
    expect(formChanges(form, TZ, before)?.attendees).toEqual([
      { email: "me@example.com", name: null, role: "required" },
    ]);
  });

  it("新しい予定は、参加者がいるときだけ attendees を送る", () => {
    const form = newEventForm({
      calendarId: "c",
      date: Temporal.PlainDate.from("2026-12-04"),
      minutes: 14 * 60,
      timeZone: TZ,
    });
    expect(formChanges(form, TZ, null)?.attendees).toBeUndefined();
    const withPeople: EventForm = {
      ...form,
      attendees: { list: [{ address: "a@example.com" }], text: "" },
    };
    expect(formChanges(withPeople, TZ, null)?.attendees).toEqual([
      { email: "a@example.com", name: null, role: "required" },
    ]);
  });

  it("招待された予定では、通知と予定あり / 空きだけを残す", () => {
    expect(
      attendeeEditableChanges({
        summary: "x",
        busy: false,
        reminders: [],
        useDefaultReminders: false,
        attendees: [],
      }),
    ).toEqual({ busy: false, reminders: [], useDefaultReminders: false });
  });
});

describe("編集画面の参加者の欄 (inviteFormView)", () => {
  const base = (form: EventForm, before: EventForm | null) => ({
    form,
    before,
    timeZone: TZ,
    online: true,
  });

  it("招待を送れるカレンダーで参加者を足すと「保存して招待を送る」", () => {
    const before = formOf(meeting);
    const form: EventForm = {
      ...before,
      attendees: {
        list: [...before.attendees.list, { address: "b@example.com" }],
        text: "",
      },
    };
    const view = inviteFormView({
      ...base(form, before),
      role: "organizer",
      scheduling: "server",
    });
    expect(view).toMatchObject({
      attendees: "edit",
      saveLabel: "保存して招待を送る",
      note: "保存すると参加者に招待が届きます",
      blocked: null,
    });
    expect(
      inviteFormView({
        ...base(form, before),
        online: false,
        role: "organizer",
        scheduling: "server",
      }).note,
    ).toBe("接続したときに参加者に招待が届きます");
  });

  it("参加者がいる予定の時刻を変えると「保存して連絡を送る」。通知だけなら「保存」", () => {
    const before = formOf(meeting);
    const moved = inviteFormView({
      ...base({ ...before, startTime: "11:00", endTime: "12:00" }, before),
      role: "organizer",
      scheduling: "server",
    });
    expect(moved.saveLabel).toBe("保存して連絡を送る");
    expect(moved.note).toBe("保存すると参加者に変更の連絡が届きます");
    const reminded = inviteFormView({
      ...base({ ...before, useDefaultReminders: false }, before),
      role: "organizer",
      scheduling: "server",
    });
    expect(reminded).toMatchObject({ saveLabel: "保存", note: null });
  });

  it("招待を送れないカレンダーでは欄を無効にし、既にいる参加者は外せる", () => {
    const before = formOf(meeting);
    const view = inviteFormView({
      ...base(before, before),
      role: "organizer",
      scheduling: "none",
    });
    expect(view).toMatchObject({
      attendees: "remove_only",
      note: "このカレンダーからは招待を送れません",
      saveLabel: "保存",
      blocked: null,
    });
    const removed = inviteFormView({
      ...base({ ...before, attendees: { list: [], text: "" } }, before),
      role: "organizer",
      scheduling: "none",
    });
    expect(removed).toMatchObject({ attendees: "disabled", blocked: null });
  });

  it("新しい予定で参加者を入れてから送れないカレンダーを選ぶと、保存を止めて理由を出す", () => {
    const form: EventForm = {
      ...newEventForm({
        calendarId: "c",
        date: Temporal.PlainDate.from("2026-12-04"),
        minutes: 600,
        timeZone: TZ,
      }),
      attendees: { list: [{ address: "a@example.com" }], text: "" },
    };
    const view = inviteFormView({
      ...base(form, null),
      role: "organizer",
      scheduling: "none",
    });
    expect(view.blocked).toContain("このカレンダーからは招待を送れません");
    expect(view.warning).toBe(true);
  });

  it("招待された予定は、通知と予定あり / 空き以外を無効にする", () => {
    const invited = event({
      organizer: { email: "boss@example.com", self: false },
      attendees: [person("me@example.com", { self: true })],
    });
    const before = formOf(invited);
    const view = inviteFormView({
      ...base(before, before),
      role: "attendee",
      scheduling: "server",
    });
    expect(view).toMatchObject({
      locked: true,
      attendees: "disabled",
      saveLabel: "保存",
    });
    expect(view.note).toContain("主催者の予定です");
  });

  it("参加者は 100 人まで", () => {
    const form: EventForm = {
      ...formOf(meeting),
      attendees: {
        list: Array.from({ length: 101 }, (_, index) => ({
          address: `p${index}@example.com`,
        })),
        text: "",
      },
    };
    const view = inviteFormView({
      ...base(form, null),
      role: "organizer",
      scheduling: "server",
    });
    expect(view.blocked).toBe("参加者は 100 人までです。");
  });
});

describe("終日の予定の通知の送り方", () => {
  it("終日 ⇄ 時刻ありを切り替えたら reminders も送り、時刻ありでは負の分を 0 にする", () => {
    const allDay: EventForm = {
      ...formOf(meeting),
      allDay: true,
      useDefaultReminders: false,
      reminders: [
        { method: "display", minutes: -540 },
        { method: "display", minutes: 900 },
      ],
    };
    const changes = formChanges({ ...allDay, allDay: false }, TZ, allDay);
    expect(changes?.reminders).toEqual([
      { method: "display", minutes: 0 },
      { method: "display", minutes: 900 },
    ]);
    const timed = { ...allDay, allDay: false, reminders: [] };
    expect(formChanges(timed, TZ, timed)?.reminders).toBeUndefined();
  });

  it("終日の予定の当日の時刻 (負の分) はそのまま送る", () => {
    const before = { ...formOf(meeting), allDay: true };
    const changes = formChanges(
      {
        ...before,
        useDefaultReminders: false,
        reminders: [{ method: "display", minutes: -540 }],
      },
      TZ,
      before,
    );
    expect(changes?.reminders).toEqual([{ method: "display", minutes: -540 }]);
  });
});
