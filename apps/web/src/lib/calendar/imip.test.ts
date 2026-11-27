import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
  type Attendee,
  type CalendarEvent,
  calendarScheduling,
} from "@/lib/calendar/api";
import {
  conflictActionLabel,
  conflictMessage,
  conflictReason,
  errorReasonLabel,
} from "@/lib/calendar/conflict-labels";
import { toLocal } from "@/lib/calendar/dates";
import {
  type EventForm,
  eventFormOf,
  inviteFormView,
  newEventForm,
} from "@/lib/calendar/event-form";
import {
  blockedSenderAddress,
  imipConfigurable,
  imipSenderAccounts,
  inviteSenderAddress,
} from "@/lib/calendar/imip";
import { applyFields } from "@/lib/calendar/offline/overlay";
import { calendar, event } from "@/lib/calendar/offline/test-support";
import type { ConflictItem } from "@/lib/calendar/offline/types";
import { rsvpDelivery } from "@/lib/calendar/rsvp";

/** 招待メール (iMIP、段取り 8b) の画面の判定と文言。 */

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
  organizer: { email: "aoi@example.com", self: true },
  attendees: [
    person("aoi@example.com", { self: true, status: "accepted" }),
    person("tanaka@example.com", { name: "田中" }),
  ],
});

describe("calendarScheduling (画面)", () => {
  it("mail はそのまま、項目が無い・知らない値は none", () => {
    expect(calendarScheduling({ scheduling: "mail" })).toBe("mail");
    expect(calendarScheduling({ scheduling: "server" })).toBe("server");
    expect(calendarScheduling({})).toBe("none");
    expect(
      calendarScheduling({ scheduling: "future" as unknown as "none" }),
    ).toBe("none");
  });
});

describe("招待メールを送るカレンダーの注記 (imip-design 12.1)", () => {
  const base = (form: EventForm, before: EventForm | null) => ({
    form,
    before,
    timeZone: TZ,
    online: true,
    role: "organizer" as const,
    scheduling: "mail" as const,
    sender: "aoi@example.com",
  });
  const withGuest = (form: EventForm): EventForm => ({
    ...form,
    attendees: {
      list: [...form.attendees.list, { address: "guest@example.com" }],
      text: "",
    },
  });

  it("参加者を足すと送信元のアドレスを出し、「保存して招待を送る」", () => {
    const before = formOf(meeting);
    expect(inviteFormView(base(withGuest(before), before))).toMatchObject({
      attendees: "edit",
      note: "保存すると、aoi@example.com から参加者に招待メールを送ります",
      saveLabel: "保存して招待を送る",
      blocked: null,
    });
    expect(
      inviteFormView({ ...base(withGuest(before), before), online: false })
        .note,
    ).toBe("接続したときに、aoi@example.com から招待メールを送ります");
  });

  it("時刻を変えると「保存して連絡を送る」と変更のメールの注記", () => {
    const before = formOf(meeting);
    const view = inviteFormView(
      base({ ...before, startTime: "11:00", endTime: "12:00" }, before),
    );
    expect(view.saveLabel).toBe("保存して連絡を送る");
    expect(view.note).toBe(
      "保存すると、aoi@example.com から参加者に変更のメールを送ります",
    );
  });

  it("変えていなくても送信元は出す。メモがあれば「メモも参加者に送られます」", () => {
    const before = formOf(meeting);
    expect(inviteFormView(base(before, before))).toMatchObject({
      note: "招待メールは aoi@example.com から送ります",
      saveLabel: "保存",
      descriptionNote: null,
    });
    const memo = inviteFormView(
      base({ ...before, description: "議題" }, before),
    );
    expect(memo.descriptionNote).toBe("メモも参加者に送られます");
    expect(memo.saveLabel).toBe("保存して連絡を送る");
    const empty = newEventForm({
      calendarId: "c",
      date: Temporal.PlainDate.from("2026-12-01"),
      minutes: 600,
      timeZone: TZ,
    });
    expect(
      inviteFormView(base({ ...empty, description: "メモ" }, null))
        .descriptionNote,
    ).toBeNull();
  });

  it("送れない理由ごとの注記。送信元が無い・受信専用なら「送信元を選ぶ」を出す", () => {
    const before = formOf(meeting);
    const none = (
      schedulingBlocked: "no_sender" | "receive_only" | "unknown_server",
      form = before,
    ) =>
      inviteFormView({
        ...base(form, before),
        scheduling: "none",
        sender: null,
        schedulingBlocked,
        blockedAddress: "inbox@example.com",
      });
    expect(none("no_sender")).toMatchObject({
      note: "招待を送るには、送信できるメールアカウントが必要です",
      chooseSender: true,
      attendees: "remove_only",
      blocked: null,
    });
    expect(none("receive_only").note).toBe(
      "送信元の inbox@example.com は受信専用のため、招待を送れません",
    );
    expect(none("unknown_server")).toMatchObject({
      note: "サーバーが招待を送るかを確認中です。確認が済むまで参加者を追加できません",
      chooseSender: false,
    });
    const added = none("no_sender", withGuest(before));
    expect(added.warning).toBe(true);
    expect(added.blocked).toContain(
      "招待を送るには、送信できるメールアカウントが必要です",
    );
  });

  it("理由の分からない古いサーバーでは、今までの注記のまま", () => {
    const before = formOf(meeting);
    const view = inviteFormView({
      ...base(before, before),
      scheduling: "none",
      sender: undefined,
    });
    expect(view.note).toBe("このカレンダーからは招待を送れません");
    expect(view.chooseSender).toBe(false);
  });
});

describe("送信元 (imip.ts)", () => {
  const accounts = [
    {
      id: "a1",
      email: "inbox@example.com",
      protocol: "pop3" as const,
      smtpHost: null,
    },
    {
      id: "a2",
      email: "Aoi@Example.com",
      protocol: "imap" as const,
      smtpHost: "smtp",
    },
    { id: "a3", email: "cal@example.com", mailEnabled: false },
    {
      id: "a4",
      email: "work@example.com",
      protocol: "graph" as const,
      smtpHost: null,
    },
  ];

  it("受信専用とメールを使わないアカウントは送信元に選べない", () => {
    expect(imipSenderAccounts(accounts).map((a) => a.id)).toEqual(["a2", "a4"]);
  });

  it("既にある予定は主催者のアドレス、新しい予定はカレンダーの送信元", () => {
    const local = calendar({
      imipSender: { accountId: "a2", email: "aoi@example.com" },
    });
    expect(
      inviteSenderAddress(local, { email: "old@example.com", self: true }),
    ).toBe("old@example.com");
    expect(inviteSenderAddress(local, { email: "", self: true })).toBe(
      "aoi@example.com",
    );
    expect(inviteSenderAddress(local, null)).toBe("aoi@example.com");
    expect(
      inviteSenderAddress(local, { email: "sato@example.com", self: false }),
    ).toBe("aoi@example.com");
    expect(
      blockedSenderAddress({ imipAccountId: "a1", accountId: null }, accounts),
    ).toBe("inbox@example.com");
  });

  it("設定を出すのは Orbit 内と招待を自分で送らない CalDAV だけ (古いサーバーでは出さない)", () => {
    expect(imipConfigurable(calendar({ imipAccountId: null }))).toBe(true);
    expect(imipConfigurable(calendar({}))).toBe(false);
    expect(
      imipConfigurable(
        calendar({
          source: "caldav",
          scheduling: "server",
          imipAccountId: null,
        }),
      ),
    ).toBe(false);
    expect(
      imipConfigurable(
        calendar({ source: "caldav", scheduling: "mail", imipAccountId: null }),
      ),
    ).toBe(true);
    expect(
      imipConfigurable(
        calendar({
          source: "google",
          scheduling: "server",
          imipAccountId: null,
        }),
      ),
    ).toBe(false);
    expect(
      imipConfigurable(calendar({ readOnly: true, imipAccountId: null })),
    ).toBe(false);
  });
});

describe("返事の届け方 (rsvpDelivery)", () => {
  const invited = event({
    organizer: { email: "sato@example.com", self: false },
    attendees: [person("aoi@example.com", { self: true })],
  });
  const mail = calendar({ scheduling: "mail" });

  it("mail は自分のアドレスの送信できるアカウントから送る", () => {
    expect(
      rsvpDelivery(invited, mail, [
        { id: "a2", email: "AOI@example.com", protocol: "imap", smtpHost: "s" },
      ]),
    ).toEqual({ via: "mail", from: "AOI@example.com" });
  });

  it("自分のアドレスのアカウントが無い・受信専用なら通知されない (no_sender)", () => {
    expect(
      rsvpDelivery(invited, mail, [
        {
          id: "a1",
          email: "aoi@example.com",
          protocol: "pop3",
          smtpHost: null,
        },
      ]),
    ).toEqual({ via: "none", reason: "no_sender" });
    expect(rsvpDelivery(invited, mail, [])).toEqual({
      via: "none",
      reason: "no_sender",
    });
  });

  it("アカウントの一覧が分からなければ、自分のアドレスから送るものとして出す", () => {
    expect(rsvpDelivery(invited, mail, null)).toEqual({
      via: "mail",
      from: "aoi@example.com",
    });
  });

  it("server と none", () => {
    expect(
      rsvpDelivery(invited, calendar({ scheduling: "server" }), null),
    ).toEqual({
      via: "server",
    });
    expect(
      rsvpDelivery(
        invited,
        calendar({ scheduling: "none", schedulingBlocked: "receive_only" }),
        null,
      ),
    ).toEqual({ via: "none", reason: "no_sender" });
    expect(
      rsvpDelivery(
        invited,
        calendar({ source: "caldav", scheduling: "none" }),
        null,
      ),
    ).toEqual({ via: "none", reason: "calendar_only" });
  });
});

describe("招待メールの送信の失敗 (invite_failed) の文言", () => {
  const item = (overrides: Partial<ConflictItem> = {}): ConflictItem => ({
    id: "k1",
    source: "server",
    kind: "invite_failed",
    calendarId: null,
    eventId: null,
    recurrenceId: null,
    title: "定例",
    fields: [],
    lost: null,
    kept: null,
    snapshot: null,
    reason: "招待メールを送れませんでした: SMTP サーバーに断られました",
    createdAt: "2026-11-27T00:00:00.000Z",
    actions: ["resend", "dismiss"],
    opId: null,
    invite: { method: "REQUEST", to: ["a@example.com"] },
    ...overrides,
  });

  it("METHOD ごとの見出しと、前置きを外した理由", () => {
    expect(conflictMessage(item(), undefined)).toBe(
      "「定例」の招待メールを送れませんでした。",
    );
    expect(conflictReason(item())).toBe("SMTP サーバーに断られました");
    expect(
      conflictMessage(item({ invite: { method: "CANCEL" } }), undefined),
    ).toBe("「定例」の取り消しのメールを送れませんでした。");
    expect(
      conflictMessage(item({ invite: { method: "REPLY" } }), undefined),
    ).toBe("「定例」への出欠の返事を主催者へ送れませんでした。");
    expect(conflictActionLabel(item(), "resend")).toBe("もう一度送る");
  });

  it("一部の宛先だけ送れなかったときは宛先を出す", () => {
    expect(
      conflictReason(
        item({
          invite: {
            method: "REQUEST",
            partial: true,
            to: ["a@x", "b@x", "c@x", "d@x"],
          },
        }),
      ),
    ).toBe("次の宛先には送れませんでした: a@x、b@x、c@x ほか 1 件");
  });

  it("送信数の上限の断り", () => {
    expect(errorReasonLabel("invite_limit")).toBe(
      "招待メールの送信数が上限に達しました。しばらくしてからもう一度保存してください",
    );
  });
});

describe("オフライン層で新しい項目が落ちない", () => {
  it("参加者を変えても、残る人の返事のコメントと反映時刻は残る", () => {
    const base = event({
      attendees: [
        person("tanaka@example.com", {
          status: "accepted",
          comment: "少し遅れます",
          repliedAt: "2026-11-27T00:00:00.000Z",
        }),
      ],
      inviteDelivery: "pending",
    });
    const next = applyFields(base, {
      attendees: [
        { email: "tanaka@example.com", name: "田中" },
        { email: "new@example.com" },
      ],
    });
    expect(next.attendees[0]).toMatchObject({
      email: "tanaka@example.com",
      name: "田中",
      status: "accepted",
      comment: "少し遅れます",
      repliedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(next.attendees[1]?.comment).toBeUndefined();
    expect(next.inviteDelivery).toBe("pending");
  });
});
