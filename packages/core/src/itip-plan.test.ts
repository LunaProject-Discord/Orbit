import { describe, expect, it } from "vitest";
import { parseICalendar } from "./icalendar.js";
import {
  type ImipAccepted,
  type ImipEvent,
  imipRecipientCount,
  planImip,
} from "./itip-plan.js";

const STAMP = new Date("2026-11-27T00:00:00Z");
const SENDER = { accountId: "acc-1", email: "me@example.com" };
const accepted = (
  operation: ImipAccepted["operation"],
  now?: Date,
): ImipAccepted => ({
  operation,
  stamp: STAMP,
  defaultTimeZone: "Asia/Tokyo",
  ...(now ? { now } : {}),
});

type Attendee = ImipEvent["attendees"][number];
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

function event(overrides: Partial<ImipEvent> = {}): ImipEvent {
  return {
    uid: "e1@orbit",
    recurrenceId: null,
    summary: "定例",
    location: null,
    description: null,
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: "2026-12-08T01:00:00Z",
    endAt: "2026-12-08T02:00:00Z",
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    endTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: null,
    exdates: null,
    organizer: { email: "me@example.com", name: "Me", self: true },
    attendees: [
      person("me@example.com", { self: true, status: "accepted" }),
      person("bob@example.com", { name: "Bob" }),
      person("carol@example.com"),
    ],
    sequence: 0,
    conferenceUrl: null,
    reminders: null,
    ...overrides,
  };
}

const to = (plan: ReturnType<typeof planImip>, index = 0) =>
  plan?.messages[index]?.to.map((address) => address.address);

describe("planImip (主催者)", () => {
  it("参加者付きで作成 → 参加者全員 (自分を除く) に REQUEST", () => {
    const plan = planImip(
      null,
      event(),
      accepted("create"),
      "organizer",
      SENDER,
    );
    expect(plan).toMatchObject({
      senderAccountId: "acc-1",
      stamp: "2026-11-27T00:00:00.000Z",
    });
    expect(plan?.messages).toHaveLength(1);
    expect(plan?.messages[0]).toMatchObject({
      method: "REQUEST",
      scope: "series",
      reason: "create",
    });
    expect(plan?.messages[0]?.to).toEqual([
      { address: "bob@example.com", name: "Bob" },
      { address: "carol@example.com" },
    ]);
    expect(imipRecipientCount(plan)).toBe(2);
  });

  it("送れないアドレスと主催者自身は宛先から除き、non_participant には送る", () => {
    const plan = planImip(
      null,
      event({
        organizer: { email: "Me@Example.com", self: true },
        attendees: [
          person("me@example.com"),
          person("not-an-address"),
          person("a b@example.com"),
          person("room@example.com", { role: "non_participant" }),
        ],
      }),
      accepted("create"),
      "organizer",
      SENDER,
    );
    expect(to(plan)).toEqual(["room@example.com"]);
  });

  it("参加者を足した → 足した人に REQUEST (予定の全体)", () => {
    const before = event();
    const after = event({
      attendees: [...before.attendees, person("dave@example.com")],
    });
    const plan = planImip(
      before,
      after,
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages).toHaveLength(1);
    expect(plan?.messages[0]).toMatchObject({
      method: "REQUEST",
      reason: "add",
      scope: "series",
    });
    expect(to(plan)).toEqual(["dave@example.com"]);
  });

  it("参加者を外した → 外した人に、その人の ATTENDEE だけの CANCEL", () => {
    const before = event();
    const after = event({ attendees: before.attendees.slice(0, 2) });
    const plan = planImip(
      before,
      after,
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages).toEqual([
      {
        method: "CANCEL",
        to: [{ address: "carol@example.com" }],
        scope: "series",
        attendees: ["carol@example.com"],
        reason: "remove",
      },
    ]);
  });

  it("時刻を変えた → 残っている全員に REQUEST。足した人には add、外した人には CANCEL", () => {
    const before = event();
    const after = event({
      startAt: "2026-12-09T01:00:00Z",
      endAt: "2026-12-09T02:00:00Z",
      sequence: 1,
      attendees: [
        person("me@example.com", { self: true }),
        person("bob@example.com", { name: "Bob" }),
        person("dave@example.com"),
      ],
    });
    const plan = planImip(
      before,
      after,
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(
      plan?.messages.map((message) => [
        message.method,
        message.reason,
        message.to.map((address) => address.address),
      ]),
    ).toEqual([
      ["REQUEST", "update", ["bob@example.com"]],
      ["REQUEST", "add", ["dave@example.com"]],
      ["CANCEL", "remove", ["carol@example.com"]],
    ]);
  });

  it("繰り返しを変えた → 残っている全員に REQUEST", () => {
    const before = event({ rrule: "FREQ=WEEKLY" });
    const after = event({ rrule: "FREQ=DAILY", sequence: 1 });
    const plan = planImip(
      before,
      after,
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages[0]).toMatchObject({
      method: "REQUEST",
      reason: "update",
    });
    expect(to(plan)).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it.each([
    ["summary", { summary: "改題" }],
    ["location", { location: "会議室 B" }],
    ["description", { description: "メモ" }],
    ["conferenceUrl", { conferenceUrl: "https://meet.example.com/x" }],
  ])("%s を変えた → REQUEST (SEQUENCE は同じ)", (_, change) => {
    const plan = planImip(
      event(),
      event(change as Partial<ImipEvent>),
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages).toHaveLength(1);
    expect(plan?.messages[0]).toMatchObject({
      method: "REQUEST",
      reason: "update",
    });
  });

  it("通知・予定あり/空きだけ変えた → 送らない", () => {
    const plan = planImip(
      event(),
      event({
        busy: false,
        reminders: [{ method: "display", minutes: 5 }],
        useDefaultReminders: false,
      }),
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan).toBeNull();
  });

  it("参加者の出欠だけが変わった (他人の返事) → 送らない", () => {
    const before = event();
    const after = event({
      attendees: [
        person("me@example.com", { self: true, status: "accepted" }),
        person("bob@example.com", { name: "Bob", status: "accepted" }),
        person("carol@example.com"),
      ],
    });
    expect(
      planImip(before, after, accepted("update"), "organizer", SENDER),
    ).toBeNull();
  });

  it("1 回だけ変えた (例外の行) → その回の全員に RECURRENCE-ID 付きの REQUEST", () => {
    const exception = event({
      recurrenceId: "2026-12-15T01:00:00Z",
      startAt: "2026-12-15T05:00:00Z",
      endAt: "2026-12-15T06:00:00Z",
    });
    const created = planImip(
      null,
      exception,
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(created?.messages[0]).toMatchObject({
      method: "REQUEST",
      scope: "occurrence",
      reason: "update",
      recurrenceId: "2026-12-15T01:00:00Z",
    });
    const changed = planImip(
      exception,
      { ...exception, summary: "この回だけ" },
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(changed?.messages[0]).toMatchObject({
      method: "REQUEST",
      scope: "occurrence",
      recurrenceId: "2026-12-15T01:00:00Z",
    });
    expect(to(changed)).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("1 回だけ消した (原本の EXDATE) → 全員に RECURRENCE-ID 付きの CANCEL (iCalendar 入り)", () => {
    const before = event({ rrule: "FREQ=WEEKLY" });
    const after = event({
      rrule: "FREQ=WEEKLY",
      exdates: ["2026-12-15T01:00:00Z"],
    });
    const plan = planImip(
      before,
      after,
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages).toHaveLength(1);
    const [message] = plan?.messages ?? [];
    expect(message).toMatchObject({
      method: "CANCEL",
      scope: "occurrence",
      reason: "delete",
      recurrenceId: "2026-12-15T01:00:00Z",
    });
    const calendar = parseICalendar(message?.content ?? "", {
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(calendar.method).toBe("CANCEL");
    expect(calendar.events[0]).toMatchObject({
      uid: "e1@orbit",
      recurrenceId: "2026-12-15T01:00:00Z",
      startAt: "2026-12-15T01:00:00Z",
      sequence: 0,
      status: "cancelled",
      rrule: null,
    });
  });

  it("予定を消した → 全員に CANCEL (SEQUENCE + 1、iCalendar 入り)", () => {
    const plan = planImip(
      event({ sequence: 2 }),
      null,
      accepted("delete"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages[0]).toMatchObject({
      method: "CANCEL",
      scope: "series",
      reason: "delete",
      recurrenceId: null,
    });
    expect(to(plan)).toEqual(["bob@example.com", "carol@example.com"]);
    const [parsed] = parseICalendar(plan?.messages[0]?.content ?? "", {
      defaultTimeZone: "Asia/Tokyo",
    }).events;
    expect(parsed?.sequence).toBe(3);
    expect(parsed?.status).toBe("cancelled");
  });

  it("例外の行を消した → その回の CANCEL", () => {
    const plan = planImip(
      event({ recurrenceId: "2026-12-15T01:00:00Z" }),
      null,
      accepted("delete"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages[0]).toMatchObject({
      method: "CANCEL",
      scope: "occurrence",
      recurrenceId: "2026-12-15T01:00:00Z",
    });
  });

  it("取り消し (STATUS:CANCELLED) にした → 全員に CANCEL", () => {
    const plan = planImip(
      event(),
      event({ status: "cancelled" }),
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages[0]).toMatchObject({
      method: "CANCEL",
      reason: "delete",
    });
    expect(plan?.messages[0]?.content).toBeUndefined();
  });

  it("取り消しを戻した → 全員に REQUEST (L2)", () => {
    const plan = planImip(
      event({ status: "cancelled", sequence: 3 }),
      event({ sequence: 4 }),
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages).toMatchObject([
      { method: "REQUEST", reason: "update" },
    ]);
    expect(to(plan)).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("参加者の役割の変更は REQUEST、名前だけの変更は送らない (L9)", () => {
    const roleChanged = event({
      attendees: [
        person("me@example.com", { self: true, status: "accepted" }),
        person("bob@example.com", { name: "Bob", role: "optional" }),
        person("carol@example.com"),
      ],
    });
    expect(
      planImip(event(), roleChanged, accepted("update"), "organizer", SENDER)
        ?.messages[0],
    ).toMatchObject({ method: "REQUEST", reason: "update" });
    const renamed = event({
      attendees: [
        person("me@example.com", { self: true, status: "accepted" }),
        person("bob@example.com", { name: "Robert" }),
        person("carol@example.com"),
      ],
    });
    expect(
      planImip(event(), renamed, accepted("update"), "organizer", SENDER),
    ).toBeNull();
  });
});

describe("planImip (送らない場合)", () => {
  it("参加者のいない予定", () => {
    const alone = event({
      attendees: [person("me@example.com", { self: true })],
    });
    expect(
      planImip(null, alone, accepted("create"), "organizer", SENDER),
    ).toBeNull();
    expect(
      planImip(alone, null, accepted("delete"), "organizer", SENDER),
    ).toBeNull();
  });

  it("役割が attendee / none の作成・変更・削除", () => {
    for (const role of ["attendee", "none"] as const) {
      expect(
        planImip(null, event(), accepted("create"), role, SENDER),
      ).toBeNull();
      expect(
        planImip(
          event(),
          event({ summary: "x" }),
          accepted("update"),
          role,
          SENDER,
        ),
      ).toBeNull();
      expect(
        planImip(event(), null, accepted("delete"), role, SENDER),
      ).toBeNull();
    }
  });

  it("送信元が無い", () => {
    expect(
      planImip(null, event(), accepted("create"), "organizer", null),
    ).toBeNull();
  });

  it("終了済みの予定の変更・取り消し", () => {
    const past = event({
      startAt: "2026-11-01T01:00:00Z",
      endAt: "2026-11-01T02:00:00Z",
    });
    expect(
      planImip(
        past,
        { ...past, summary: "改題" },
        accepted("update"),
        "organizer",
        SENDER,
      ),
    ).toBeNull();
    expect(
      planImip(past, null, accepted("delete"), "organizer", SENDER),
    ).toBeNull();
    const pastDay = event({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-11-26",
      endDate: "2026-11-27",
    });
    expect(
      planImip(pastDay, null, accepted("delete"), "organizer", SENDER),
    ).toBeNull();
    // 今日の終日の予定はまだ終わっていない。
    expect(
      planImip(
        { ...pastDay, startDate: "2026-11-27", endDate: "2026-11-28" },
        null,
        accepted("delete"),
        "organizer",
        SENDER,
      ),
    ).not.toBeNull();
  });

  it("繰り返しは最後の回が過去なら終了済み、続いていれば送る", () => {
    const ended = event({
      startAt: "2026-10-01T01:00:00Z",
      endAt: "2026-10-01T02:00:00Z",
      rrule: "FREQ=WEEKLY;COUNT=3",
    });
    expect(
      planImip(ended, null, accepted("delete"), "organizer", SENDER),
    ).toBeNull();
    const ongoing = { ...ended, rrule: "FREQ=WEEKLY" };
    expect(
      planImip(ongoing, null, accepted("delete"), "organizer", SENDER),
    ).not.toBeNull();
    const untilNext = { ...ended, rrule: "FREQ=WEEKLY;UNTIL=20261231T000000Z" };
    expect(
      planImip(untilNext, null, accepted("delete"), "organizer", SENDER),
    ).not.toBeNull();
  });

  it("繰り返しは今日の回が終わった後でも、続いていれば送る (毎日・毎週・終日・COUNT 付き)", () => {
    // 2026-11-27 15:00 (Asia/Tokyo)。今日 9:00-10:00 の回はもう終わっている。
    const afternoon = new Date("2026-11-27T06:00:00Z");
    const daily = event({
      startAt: "2026-11-01T00:00:00Z",
      endAt: "2026-11-01T01:00:00Z",
      rrule: "FREQ=DAILY",
    });
    const weeklyFriday = { ...daily, rrule: "FREQ=WEEKLY;BYDAY=FR" };
    const dailyCount = { ...daily, rrule: "FREQ=DAILY;COUNT=60" };
    const allDayDaily = event({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      startTimeZone: null,
      endTimeZone: null,
      rrule: "FREQ=DAILY",
    });
    const allDayCount = { ...allDayDaily, rrule: "FREQ=DAILY;COUNT=40" };
    for (const series of [
      daily,
      weeklyFriday,
      dailyCount,
      allDayDaily,
      allDayCount,
    ]) {
      expect(
        planImip(
          series,
          null,
          accepted("delete", afternoon),
          "organizer",
          SENDER,
        ),
      ).not.toBeNull();
      expect(
        planImip(
          series,
          { ...series, summary: "新しい題名" },
          accepted("update", afternoon),
          "organizer",
          SENDER,
        ),
      ).not.toBeNull();
    }
    // COUNT の最後の回が今日で、もう終わっている → 終了済み。
    const lastToday = { ...daily, rrule: "FREQ=DAILY;COUNT=27" };
    expect(
      planImip(
        lastToday,
        null,
        accepted("delete", afternoon),
        "organizer",
        SENDER,
      ),
    ).toBeNull();
    // 最後の回が今日で、まだ終わっていない → 送る。
    expect(
      planImip(
        lastToday,
        null,
        accepted("delete", new Date("2026-11-26T23:30:00Z")),
        "organizer",
        SENDER,
      ),
    ).not.toBeNull();
  });

  it("過去の予定を未来へ動かしたら送る", () => {
    const past = event({
      startAt: "2026-11-01T01:00:00Z",
      endAt: "2026-11-01T02:00:00Z",
    });
    const plan = planImip(
      past,
      event({ sequence: 1 }),
      accepted("update"),
      "organizer",
      SENDER,
    );
    expect(plan?.messages[0]?.method).toBe("REQUEST");
  });
});

describe("planImip (参加者の出欠)", () => {
  const invited = (status: Attendee["status"]) =>
    event({
      organizer: { email: "boss@example.com", name: "Boss" },
      attendees: [
        person("boss@example.com", { status: "accepted" }),
        person("me@example.com", { self: true, status }),
      ],
      sequence: 3,
    });
  const replySender = { accountId: "acc-2", email: "me@example.com" };

  it("出欠を返した → 主催者へ REPLY (自分の ATTENDEE だけ)", () => {
    const plan = planImip(
      invited("needs_action"),
      invited("accepted"),
      accepted("respond"),
      "attendee",
      replySender,
    );
    expect(plan).toEqual({
      senderAccountId: "acc-2",
      stamp: "2026-11-27T00:00:00.000Z",
      messages: [
        {
          method: "REPLY",
          to: [{ address: "boss@example.com", name: "Boss" }],
          scope: "occurrence",
          attendees: ["me@example.com"],
          reason: "respond",
          recurrenceId: null,
          content: expect.stringContaining("METHOD:REPLY"),
        },
      ],
    });
    expect(imipRecipientCount(plan)).toBe(0);
    // 本文は受け付けた時点で作る (M4: 書き戻しの前に行が消えても送れる)。
    const reply = parseICalendar(plan?.messages[0]?.content ?? "", {
      defaultTimeZone: "Asia/Tokyo",
    });
    expect(reply.events[0]?.attendees).toMatchObject([
      { email: "me@example.com", status: "accepted" },
    ]);
  });

  it("例外の行への返事は RECURRENCE-ID 付き", () => {
    const plan = planImip(
      null,
      { ...invited("declined"), recurrenceId: "2026-12-08T01:00:00Z" },
      accepted("respond"),
      "attendee",
      replySender,
    );
    expect(plan?.messages[0]?.recurrenceId).toBe("2026-12-08T01:00:00Z");
  });

  it("主催者・送信元・自分の行が無い、役割が違う、取り消し済みなら送らない", () => {
    const after = invited("accepted");
    expect(
      planImip(
        null,
        { ...after, organizer: null },
        accepted("respond"),
        "attendee",
        replySender,
      ),
    ).toBeNull();
    expect(
      planImip(null, after, accepted("respond"), "attendee", null),
    ).toBeNull();
    expect(
      planImip(null, after, accepted("respond"), "organizer", replySender),
    ).toBeNull();
    expect(
      planImip(
        null,
        {
          ...after,
          attendees: after.attendees.map((a) => ({ ...a, self: false })),
        },
        accepted("respond"),
        "attendee",
        replySender,
      ),
    ).toBeNull();
    expect(
      planImip(
        null,
        { ...after, status: "cancelled" },
        accepted("respond"),
        "attendee",
        replySender,
      ),
    ).toBeNull();
    expect(
      planImip(
        null,
        invited("needs_action"),
        accepted("respond"),
        "attendee",
        replySender,
      ),
    ).toBeNull();
  });
});
