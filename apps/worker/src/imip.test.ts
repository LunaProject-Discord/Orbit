/**
 * 招待メール (iMIP、imip-design 5・6 章) の送信の側を確かめる。
 * - buildMime の icalEvent (DB 不要)
 * - enqueueImip、送信元の解決、上限、processSends の imip_send、メールの processOutbox からの除外、
 *   CalDAV の書き戻しの成功後に積む処理 (実際の PostgreSQL。DATABASE_URL が無い環境では実行しない)
 */
import {
  buildItip,
  type ICalEventData,
  IMIP_RECIPIENTS_PER_HOUR,
  type ImipPlan,
  type ImipPlanMessage,
  type ImipSendPayload,
  type MailAddress,
  type OutgoingMessage,
  parseICalendar,
} from "@orbit/core";
import {
  type accounts,
  calendars,
  type Database,
  enqueueImip,
  eventAttendees,
  eventConflicts,
  events,
  findCalendarEvents,
  imipLimitExceeded,
  imipRecipientUsage,
  mailboxes,
  outbox,
  resolveCalendarImipSender,
} from "@orbit/db";
import { and, asc, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calendarImipAddresses } from "./calendar/account-calendar-sync.js";
import { processEventOutbox } from "./calendar/outbox.js";
import { FakeCalendarProvider } from "./calendar/testing/fake-provider.js";
import { makeProviderContext } from "./calendar/testing/provider-contract.js";
import {
  createTestDatabase,
  insertAccount,
  insertCalendar,
  insertUser,
  type TestDatabase,
} from "./calendar/testing/test-db.js";
import { buildMime } from "./mime.js";
import { processOutbox } from "./outbox.js";
import { processSends, type SendOutcome } from "./send.js";

const STAMP = "2026-11-27T03:00:00.000Z";

const sampleEvent: ICalEventData = {
  uid: "sample@orbit",
  recurrenceId: null,
  summary: "定例会議",
  location: "会議室 A",
  description: null,
  status: "confirmed",
  busy: true,
  allDay: false,
  startAt: "2026-12-05T01:00:00Z",
  endAt: "2026-12-05T02:00:00Z",
  startDate: null,
  endDate: null,
  startTimeZone: "Asia/Tokyo",
  endTimeZone: "Asia/Tokyo",
  rrule: null,
  rdates: null,
  exdates: null,
  organizer: { email: "me@example.com" },
  attendees: [
    { email: "guest@other.example", role: "required", status: "needs_action" },
  ],
  sequence: 0,
  conferenceUrl: null,
  reminders: null,
};

describe("buildMime の招待メール", () => {
  it("text/calendar; method=… の alternative と invite.ics の添付を入れる", async () => {
    const content = buildItip({
      method: "REQUEST",
      events: [sampleEvent],
      dtstamp: new Date(STAMP),
      defaultTimeZone: "Asia/Tokyo",
    });
    const message: OutgoingMessage = {
      from: { address: "me@example.com", name: "わたし" },
      to: [{ address: "guest@other.example" }],
      cc: [],
      bcc: [],
      subject: "招待: 定例会議 (2026/12/5)",
      text: "定例会議への招待です。",
      html: null,
      attachments: [],
      messageId: "<invite@example.com>",
      date: STAMP,
      inReplyTo: null,
      references: [],
      calendar: { method: "REQUEST", content },
    };
    const mime = (await buildMime(message, { keepBcc: false })).toString();
    expect(mime).toMatch(/Content-Type: multipart\/mixed/);
    expect(mime).toMatch(/Content-Type: multipart\/alternative/);
    expect(mime).toMatch(
      /Content-Type: text\/calendar; charset=utf-8; method=REQUEST/,
    );
    expect(mime).toMatch(/Content-Type: application\/ics; name=invite\.ics/);
    expect(mime).toContain("Content-Disposition: attachment");
    // テキストの本文が先 (alternative の中で text/plain → text/calendar の順)。
    expect(mime.indexOf("Content-Type: text/plain")).toBeLessThan(
      mime.indexOf("Content-Type: text/calendar"),
    );
    expect(mime).not.toContain("text/html");

    const parsed = await simpleParser(mime);
    expect(parsed.text?.trim()).toBe("定例会議への招待です。");
    const ics = parsed.attachments.find(
      (file) => file.filename === "invite.ics",
    );
    expect(ics?.contentType).toBe("application/ics");
    const read = parseICalendar(ics?.content.toString("utf8") ?? "", {
      defaultTimeZone: "UTC",
    });
    expect(read.method).toBe("REQUEST");
    expect(read.events[0]?.uid).toBe("sample@orbit");
    // text/calendar の alternative も同じ内容。
    const alternative = parsed.attachments.find((file) =>
      file.contentType.startsWith("text/calendar"),
    );
    expect(alternative?.content.toString("utf8")).toBe(content);
  });

  it("calendar の無いメールには text/calendar を入れない", async () => {
    const mime = (
      await buildMime(
        {
          from: { address: "me@example.com" },
          to: [{ address: "you@example.com" }],
          cc: [],
          bcc: [],
          subject: "ふつうのメール",
          text: "本文",
          messageId: "<plain@example.com>",
          date: STAMP,
          inReplyTo: null,
          references: [],
        },
        { keepBcc: false },
      )
    ).toString();
    expect(mime).not.toContain("text/calendar");
    expect(mime).not.toContain("invite.ics");
  });
});

const adminUrl = process.env.DATABASE_URL;

type AccountRow = typeof accounts.$inferSelect;
type CalendarRow = typeof calendars.$inferSelect;

describe.skipIf(!adminUrl)("招待メール (imip_send)", () => {
  let test: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_imip");
    db = test.db;
  });

  afterAll(async () => {
    await test?.drop();
  });

  let counter = 0;
  /** 利用者 (上限を分けるため、テストごとに作る)、送信できるメールアカウント、Orbit 内のカレンダー。 */
  const fresh = async () => {
    counter++;
    const userId = await insertUser(db, `imip${counter}@example.com`);
    const mail = await insertAccount(db, userId, {
      email: `me${counter}@example.com`,
      username: `me${counter}@example.com`,
      displayName: "わたし",
      provider: "generic",
      authType: "password",
      protocol: "imap",
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
    });
    const [calendar] = await db
      .insert(calendars)
      .values({
        userId,
        accountId: null,
        source: "local",
        name: "Orbit",
        timeZone: "Asia/Tokyo",
      })
      .returning();
    if (!calendar) throw new Error("カレンダーを作れませんでした。");
    return { userId, mail, calendar };
  };

  /** 予定と参加者を入れ、findCalendarEvents の形で返す。 */
  const insertEvent = async (
    userId: string,
    calendar: CalendarRow,
    options: {
      organizer: string | null;
      attendees: { email: string; self?: boolean; status?: string }[];
      summary?: string;
      remoteId?: string | null;
    },
  ) => {
    const id = crypto.randomUUID();
    await db.insert(events).values({
      id,
      userId,
      calendarId: calendar.id,
      uid: `${id}@orbit`,
      summary: options.summary ?? "定例会議",
      startAt: new Date("2026-12-05T01:00:00Z"),
      endAt: new Date("2026-12-05T02:00:00Z"),
      startTimeZone: "Asia/Tokyo",
      endTimeZone: "Asia/Tokyo",
      organizer: options.organizer
        ? { email: options.organizer, self: true }
        : null,
      remoteId: options.remoteId ?? null,
      fieldUpdatedAt: { summary: new Date().toISOString() },
    });
    if (options.attendees.length > 0) {
      await db.insert(eventAttendees).values(
        options.attendees.map((attendee) => ({
          eventId: id,
          email: attendee.email,
          self: attendee.self ?? false,
          status: (attendee.status ?? "needs_action") as "needs_action",
        })),
      );
    }
    const rows = await findCalendarEvents(db, calendar.id, {
      remoteIds: [],
      uids: [`${id}@orbit`],
    });
    return { id, rows };
  };

  const plan = (
    senderAccountId: string,
    messages: ImipPlanMessage[],
  ): ImipPlan => ({ senderAccountId, stamp: STAMP, messages });

  const request = (to: MailAddress[]): ImipPlanMessage => ({
    method: "REQUEST",
    to,
    scope: "series",
    reason: "create",
  });

  const imipRows = (accountId: string) =>
    db
      .select()
      .from(outbox)
      .where(and(eq(outbox.accountId, accountId), eq(outbox.kind, "imip_send")))
      .orderBy(asc(outbox.createdAt), asc(outbox.idempotencyKey));

  const conflictsOf = (userId: string) =>
    db.select().from(eventConflicts).where(eq(eventConflicts.userId, userId));

  const guests = (count: number): MailAddress[] =>
    Array.from({ length: count }, (_, i) => ({
      address: `guest${i}@other.example`,
    }));

  describe("enqueueImip", () => {
    it("Orbit 内のカレンダーの REQUEST を積み、同じ計画をもう一度積んでも増えない", async () => {
      const { userId, mail, calendar } = await fresh();
      const { id, rows } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: [
          { email: "a@other.example" },
          { email: "b@other.example" },
          { email: mail.email, self: true, status: "accepted" },
        ],
      });
      const context = {
        userId,
        calendarId: calendar.id,
        eventId: id,
        baseKey: `event_create:${id}`,
        defaultTimeZone: "Asia/Tokyo",
      };
      const p = plan(mail.id, [
        request([
          { address: "a@other.example", name: "A さん" },
          { address: "b@other.example" },
        ]),
      ]);
      const first = await db.transaction((tx) =>
        enqueueImip(tx, p, rows, context),
      );
      expect(first).toEqual({ enqueued: 1, skipped: null, incomplete: 0 });
      const again = await db.transaction((tx) =>
        enqueueImip(tx, p, rows, context),
      );
      expect(again.enqueued).toBe(0);

      const [row] = await imipRows(mail.id);
      expect(row?.idempotencyKey).toBe(`imip:event_create:${id}:REQUEST:0`);
      expect(row?.status).toBe("pending");
      const payload = row?.payload as unknown as ImipSendPayload;
      expect(payload.message.from).toEqual({
        address: mail.email,
        name: "わたし",
      });
      expect(payload.message.to.map((to) => to.address)).toEqual([
        "a@other.example",
        "b@other.example",
      ]);
      expect(payload.message.subject).toBe("招待: 定例会議 (2026/12/5)");
      expect(payload.message.text).toContain(
        "日時: 2026/12/5(土) 10:00 〜 11:00 (Asia/Tokyo)",
      );
      expect(payload.message.text).toContain(
        "このメールは Orbit のカレンダーから送信されました。",
      );
      expect(payload.message.date).toBe(STAMP);
      expect(payload.message.messageId).toMatch(
        /^<[0-9a-f-]{36}@example\.com>$/,
      );
      expect(payload.message.calendar?.method).toBe("REQUEST");
      const ics = parseICalendar(payload.message.calendar?.content ?? "", {
        defaultTimeZone: "UTC",
      });
      expect(ics.method).toBe("REQUEST");
      expect(ics.events[0]?.organizer?.email).toBe(mail.email);
      expect(ics.events[0]?.dtstamp).toBe("2026-11-27T03:00:00Z");
      expect(payload.imip).toMatchObject({
        method: "REQUEST",
        reason: "create",
        userId,
        calendarId: calendar.id,
        eventId: id,
        uid: `${id}@orbit`,
        recurrenceId: null,
        sequence: 0,
        title: "定例会議",
      });
    });

    it("宛先を 50 件ごとに分け、通し番号の冪等キーで積む", async () => {
      const { userId, mail, calendar } = await fresh();
      const { id, rows } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: guests(120).map((to) => ({ email: to.address })),
      });
      const result = await db.transaction((tx) =>
        enqueueImip(tx, plan(mail.id, [request(guests(120))]), rows, {
          userId,
          calendarId: calendar.id,
          eventId: id,
          baseKey: "base",
          defaultTimeZone: "Asia/Tokyo",
        }),
      );
      expect(result.enqueued).toBe(3);
      const list = await imipRows(mail.id);
      expect(list.map((row) => row.idempotencyKey).sort()).toEqual([
        "imip:base:REQUEST:0",
        "imip:base:REQUEST:1",
        "imip:base:REQUEST:2",
      ]);
      expect(
        list
          .map(
            (row) =>
              (row.payload as unknown as ImipSendPayload).message.to.length,
          )
          .sort(),
      ).toEqual([20, 50, 50]);
    });

    it("参加者を外す CANCEL は外した人だけを ATTENDEE に書き、REPLY は自分の 1 行とコメント", async () => {
      const { userId, mail, calendar } = await fresh();
      const organized = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: [{ email: "kept@other.example" }],
      });
      await db.transaction((tx) =>
        enqueueImip(
          tx,
          plan(mail.id, [
            {
              method: "CANCEL",
              to: [{ address: "gone@other.example" }],
              scope: "series",
              attendees: ["gone@other.example"],
              reason: "remove",
            },
          ]),
          organized.rows,
          {
            userId,
            calendarId: calendar.id,
            eventId: organized.id,
            baseKey: "remove",
            defaultTimeZone: "Asia/Tokyo",
          },
        ),
      );
      // 参加者として受けた予定 (主催者は他人)。
      const invited = await insertEvent(userId, calendar, {
        organizer: null,
        attendees: [
          { email: "boss@other.example" },
          { email: mail.email, self: true, status: "tentative" },
        ],
      });
      await db
        .update(events)
        .set({ organizer: { email: "boss@other.example", name: "上司" } })
        .where(eq(events.id, invited.id));
      await db
        .update(eventAttendees)
        .set({ comment: "少し遅れます" })
        .where(eq(eventAttendees.eventId, invited.id));
      const invitedRows = await findCalendarEvents(db, calendar.id, {
        remoteIds: [],
        uids: [`${invited.id}@orbit`],
      });
      await db.transaction((tx) =>
        enqueueImip(
          tx,
          plan(mail.id, [
            {
              method: "REPLY",
              to: [{ address: "boss@other.example", name: "上司" }],
              scope: "occurrence",
              attendees: [mail.email],
              reason: "respond",
              recurrenceId: null,
            },
          ]),
          invitedRows,
          {
            userId,
            calendarId: calendar.id,
            eventId: invited.id,
            baseKey: "respond",
            defaultTimeZone: "Asia/Tokyo",
          },
        ),
      );
      const list = await imipRows(mail.id);
      const byMethod = (method: string) =>
        list
          .map((row) => row.payload as unknown as ImipSendPayload)
          .find((payload) => payload.imip.method === method);
      const cancel = byMethod("CANCEL");
      expect(cancel?.message.subject).toBe("取り消し: 定例会議 (2026/12/5)");
      expect(cancel?.message.text).toContain(
        "この予定の参加者から外れました。",
      );
      const cancelIcs = parseICalendar(
        cancel?.message.calendar?.content ?? "",
        {
          defaultTimeZone: "UTC",
        },
      );
      expect(cancelIcs.events[0]?.attendees.map((a) => a.email)).toEqual([
        "gone@other.example",
      ]);
      const reply = byMethod("REPLY");
      expect(reply?.message.subject).toBe("未定: 定例会議");
      expect(reply?.message.to).toEqual([
        { address: "boss@other.example", name: "上司" },
      ]);
      const replyIcs = parseICalendar(reply?.message.calendar?.content ?? "", {
        defaultTimeZone: "UTC",
      });
      expect(replyIcs.events[0]?.attendees).toHaveLength(1);
      expect(replyIcs.events[0]?.attendees[0]?.email).toBe(mail.email);
      expect(replyIcs.events[0]?.comment).toBe("少し遅れます");
      expect(reply?.message.text).toContain("少し遅れます");
    });

    it("scheduling が mail でないカレンダー (二重送信の表) には積まない", async () => {
      const { userId, mail } = await fresh();
      const cases: Partial<typeof calendars.$inferInsert>[] = [
        { source: "google" },
        { source: "microsoft" },
        { source: "caldav", providerState: { autoSchedule: true } },
        { source: "caldav", providerState: {} },
        { source: "caldav", providerState: null },
        {
          source: "caldav",
          providerState: { autoSchedule: false },
          readOnly: true,
        },
        { source: "local", readOnly: true },
        { source: "ics" },
      ];
      for (const overrides of cases) {
        const calendar = await insertCalendar(db, userId, mail.id, overrides);
        const { id, rows } = await insertEvent(userId, calendar, {
          organizer: mail.email,
          attendees: [{ email: "a@other.example" }],
        });
        const result = await db.transaction((tx) =>
          enqueueImip(
            tx,
            plan(mail.id, [request([{ address: "a@other.example" }])]),
            rows,
            {
              userId,
              calendarId: calendar.id,
              eventId: id,
              baseKey: id,
              defaultTimeZone: "UTC",
            },
          ),
        );
        expect(result.skipped, JSON.stringify(overrides)).toBe("not_mail");
      }
      // 自動スケジュールでないと分かっている CalDAV は mail。
      const caldav = await insertCalendar(db, userId, mail.id, {
        source: "caldav",
        providerState: { autoSchedule: false },
      });
      const { id, rows } = await insertEvent(userId, caldav, {
        organizer: mail.email,
        attendees: [{ email: "a@other.example" }],
      });
      const ok = await db.transaction((tx) =>
        enqueueImip(
          tx,
          plan(mail.id, [request([{ address: "a@other.example" }])]),
          rows,
          {
            userId,
            calendarId: caldav.id,
            eventId: id,
            baseKey: id,
            defaultTimeZone: "UTC",
          },
        ),
      );
      expect(ok.enqueued).toBe(1);
      expect(await imipRows(mail.id)).toHaveLength(1);
    });

    it("送信元が受信専用・他人のアカウント・主催者と違うアドレスなら積まない", async () => {
      const { userId, mail, calendar } = await fresh();
      const receiveOnly = await insertAccount(db, userId, {
        provider: "generic",
        authType: "password",
        protocol: "pop3",
        smtpHost: null,
      });
      const other = await fresh();
      const { id, rows } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: [{ email: "a@other.example" }],
      });
      const run = (senderAccountId: string) =>
        db.transaction((tx) =>
          enqueueImip(
            tx,
            plan(senderAccountId, [request([{ address: "a@other.example" }])]),
            rows,
            {
              userId,
              calendarId: calendar.id,
              eventId: id,
              baseKey: senderAccountId,
              defaultTimeZone: "UTC",
            },
          ),
        );
      expect((await run(receiveOnly.id)).skipped).toBe("sender_unavailable");
      expect((await run(other.mail.id)).skipped).toBe("sender_unavailable");
      // 同じ利用者の、送信できる別のアドレス (ORGANIZER と違う)。
      const second = await insertAccount(db, userId, {
        provider: "generic",
        authType: "password",
        smtpHost: "smtp.example.com",
      });
      expect((await run(second.id)).skipped).toBe("sender_mismatch");
      expect(await imipRows(second.id)).toHaveLength(0);
      expect(await imipRows(mail.id)).toHaveLength(0);
    });

    it("行が消える操作は計画の content を使い、content も行も無いメッセージは飛ばす", async () => {
      const { userId, mail, calendar } = await fresh();
      const goneId = crypto.randomUUID();
      const content = buildItip({
        method: "CANCEL",
        events: [
          {
            ...sampleEvent,
            uid: `${goneId}@orbit`,
            organizer: { email: mail.email },
          },
        ],
        dtstamp: new Date(STAMP),
        defaultTimeZone: "Asia/Tokyo",
      });
      const result = await db.transaction((tx) =>
        enqueueImip(
          tx,
          plan(mail.id, [
            {
              method: "CANCEL",
              to: [{ address: "guest@other.example" }],
              scope: "series",
              reason: "delete",
              recurrenceId: null,
              content,
            },
            {
              method: "CANCEL",
              to: [{ address: "guest@other.example" }],
              scope: "occurrence",
              reason: "delete",
              recurrenceId: "2026-12-12T01:00:00Z",
            },
          ]),
          [],
          {
            userId,
            calendarId: calendar.id,
            eventId: goneId,
            baseKey: `event_delete:${goneId}`,
            defaultTimeZone: "Asia/Tokyo",
          },
        ),
      );
      expect(result).toEqual({ enqueued: 1, skipped: null, incomplete: 1 });
      const [row] = await imipRows(mail.id);
      const payload = row?.payload as unknown as ImipSendPayload;
      expect(payload.message.calendar?.content).toBe(content);
      expect(payload.message.subject).toBe("取り消し: 定例会議 (2026/12/5)");
      expect(payload.message.text).toContain("この予定は取り消されました。");
      expect(payload.imip.uid).toBe(`${goneId}@orbit`);
    });

    it("送信数の上限 (1 時間) を超える計画は積まず、REPLY は数えない", async () => {
      const { userId, mail, calendar } = await fresh();
      const { id, rows } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: guests(60).map((to) => ({ email: to.address })),
      });
      // 直近に 190 件送った (REPLY の 50 件は数えない)。
      const sent = (count: number, method: string, key: string) =>
        db.insert(outbox).values({
          accountId: mail.id,
          kind: "imip_send",
          status: "done",
          idempotencyKey: key,
          payload: {
            message: { to: guests(count) },
            imip: { method },
          },
        });
      await sent(50, "REQUEST", "k1");
      await sent(50, "REQUEST", "k2");
      await sent(50, "CANCEL", "k3");
      await sent(40, "REQUEST", "k4");
      await sent(50, "REPLY", "k5");
      // まだ書き戻していない CalDAV の計画も数える。
      await db.insert(outbox).values({
        accountId: mail.id,
        kind: "event_update",
        idempotencyKey: "pending-plan",
        payload: {
          eventId: id,
          calendarId: calendar.id,
          fields: ["summary"],
          imip: plan(mail.id, [
            request(guests(5)),
            {
              method: "REPLY",
              to: guests(1),
              scope: "occurrence",
              reason: "respond",
            },
          ]),
        },
      });
      expect(await imipRecipientUsage(db, userId)).toEqual({
        hour: 195,
        day: 195,
      });
      const small = plan(mail.id, [request(guests(5))]);
      const large = plan(mail.id, [request(guests(6))]);
      expect(IMIP_RECIPIENTS_PER_HOUR).toBe(200);
      expect(await imipLimitExceeded(db, userId, small)).toBe(false);
      expect(await imipLimitExceeded(db, userId, large)).toBe(true);
      const replyOnly = plan(mail.id, [
        {
          method: "REPLY",
          to: guests(1),
          scope: "occurrence",
          reason: "respond",
        },
      ]);
      expect(await imipLimitExceeded(db, userId, replyOnly)).toBe(false);
      // 1 時間より前の分は 1 時間の上限に数えない。
      const later = new Date(Date.now() + 2 * 60 * 60_000);
      expect(await imipLimitExceeded(db, userId, large, { now: later })).toBe(
        false,
      );

      const result = await db.transaction((tx) =>
        enqueueImip(tx, large, rows, {
          userId,
          calendarId: calendar.id,
          eventId: id,
          baseKey: "limit",
          defaultTimeZone: "UTC",
        }),
      );
      expect(result.skipped).toBe("limit");
      // いま処理している event_* の行の計画は、除けば数えない。
      const [pendingPlan] = await db
        .select({ id: outbox.id })
        .from(outbox)
        .where(eq(outbox.idempotencyKey, "pending-plan"));
      expect(
        await imipLimitExceeded(db, userId, large, {
          excludeOutboxId: pendingPlan?.id as string,
        }),
      ).toBe(false);
    });
  });

  describe("resolveCalendarImipSender (imip-design 4.2)", () => {
    const sendable = (userId: string, overrides = {}) =>
      insertAccount(db, userId, {
        provider: "generic",
        authType: "password",
        smtpHost: "smtp.example.com",
        ...overrides,
      });
    const receiveOnly = (userId: string, overrides = {}) =>
      insertAccount(db, userId, {
        provider: "generic",
        authType: "password",
        protocol: "pop3",
        smtpHost: null,
        ...overrides,
      });

    it("選んだ送信元 → カレンダーのアカウント → 同じアドレス → 1 つだけ → 並び順の先頭", async () => {
      const userId = await insertUser(db, "resolve1@example.com");
      const caldav = await insertAccount(db, userId, {
        email: "me@dav.example",
        username: "me@dav.example",
        provider: "generic",
        authType: "password",
        mailEnabled: false,
        calendarEnabled: true,
      });
      // 1 つも無い。
      expect(
        await resolveCalendarImipSender(db, {
          userId,
          accountId: caldav.id,
          imipAccountId: null,
        }),
      ).toEqual({ sender: null, blocked: "no_sender" });
      // 1 つだけ (4)。
      const only = await sendable(userId, { email: "only@example.com" });
      expect(
        (
          await resolveCalendarImipSender(db, {
            userId,
            accountId: caldav.id,
            imipAccountId: null,
          })
        ).sender?.accountId,
      ).toBe(only.id);
      // 2 つ以上は並び順の先頭 (5)。
      const first = await sendable(userId, {
        email: "first@example.com",
        sortOrder: 0,
      });
      expect(
        (
          await resolveCalendarImipSender(db, {
            userId,
            accountId: caldav.id,
            imipAccountId: null,
          })
        ).sender?.accountId,
      ).toBe(first.id);
      // 同じアドレスの別のアカウント (3)。
      const same = await sendable(userId, {
        email: "ME@dav.example",
        sortOrder: 5,
      });
      expect(
        await resolveCalendarImipSender(db, {
          userId,
          accountId: caldav.id,
          imipAccountId: null,
        }),
      ).toEqual({
        sender: {
          accountId: same.id,
          email: "ME@dav.example",
          displayName: null,
        },
        blocked: null,
      });
      // 選んだ送信元 (1)。
      expect(
        (
          await resolveCalendarImipSender(db, {
            userId,
            accountId: caldav.id,
            imipAccountId: only.id,
          })
        ).sender?.accountId,
      ).toBe(only.id);
      // カレンダーのアカウント自身 (2)。
      expect(
        (
          await resolveCalendarImipSender(db, {
            userId,
            accountId: first.id,
            imipAccountId: null,
          })
        ).sender?.accountId,
      ).toBe(first.id);
      // Orbit 内のカレンダー (アカウント無し) は 4・5。
      expect(
        (
          await resolveCalendarImipSender(db, {
            userId,
            accountId: null,
            imipAccountId: null,
          })
        ).sender?.accountId,
      ).toBe(first.id);
    });

    it("選んだ送信元・当たる送信元が受信専用なら receive_only (ほかへ進まない)", async () => {
      const userId = await insertUser(db, "resolve2@example.com");
      await sendable(userId, { email: "other@example.com" });
      const pop = await receiveOnly(userId, { email: "pop@example.com" });
      expect(
        await resolveCalendarImipSender(db, {
          userId,
          accountId: null,
          imipAccountId: pop.id,
        }),
      ).toEqual({ sender: null, blocked: "receive_only" });
      // カレンダーのアカウントがメールも使うが受信専用。
      expect(
        await resolveCalendarImipSender(db, {
          userId,
          accountId: pop.id,
          imipAccountId: null,
        }),
      ).toEqual({ sender: null, blocked: "receive_only" });
      // カレンダーだけのアカウントと同じアドレスの、受信専用のアカウントだけ。
      const dav = await insertAccount(db, userId, {
        email: "pop@example.com",
        username: "pop-calendar",
        provider: "generic",
        authType: "password",
        mailEnabled: false,
      });
      expect(
        await resolveCalendarImipSender(db, {
          userId,
          accountId: dav.id,
          imipAccountId: null,
        }),
      ).toEqual({ sender: null, blocked: "receive_only" });
    });
  });

  describe("processSends の imip_send", () => {
    const enqueueOne = async (
      method: "REQUEST" | "REPLY" = "REQUEST",
      overrides: Partial<typeof outbox.$inferInsert> = {},
    ) => {
      const ctx = await fresh();
      const { id, rows } = await insertEvent(ctx.userId, ctx.calendar, {
        organizer: method === "REQUEST" ? ctx.mail.email : "boss@other.example",
        attendees:
          method === "REQUEST"
            ? [{ email: "a@other.example" }]
            : [
                { email: "boss@other.example" },
                { email: ctx.mail.email, self: true, status: "accepted" },
              ],
      });
      await db.transaction((tx) =>
        enqueueImip(
          tx,
          plan(ctx.mail.id, [
            method === "REQUEST"
              ? request([{ address: "a@other.example" }])
              : {
                  method: "REPLY",
                  to: [{ address: "boss@other.example" }],
                  scope: "occurrence",
                  attendees: [ctx.mail.email],
                  reason: "respond",
                },
          ]),
          rows,
          {
            userId: ctx.userId,
            calendarId: ctx.calendar.id,
            eventId: id,
            baseKey: id,
            defaultTimeZone: "Asia/Tokyo",
          },
        ),
      );
      if (Object.keys(overrides).length > 0) {
        await db
          .update(outbox)
          .set(overrides)
          .where(eq(outbox.accountId, ctx.mail.id));
      }
      // 送信済みフォルダがあっても、招待メールの控えは保存しない。
      await db.insert(mailboxes).values({
        accountId: ctx.mail.id,
        path: "Sent",
        name: "Sent",
        specialUse: "sent",
      });
      return { ...ctx, eventId: id };
    };
    const run = (account: AccountRow, outcome: SendOutcome | Error) => {
      const send = vi.fn(async (_message: OutgoingMessage) => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      const logs: string[] = [];
      return {
        send,
        logs,
        result: processSends(db, account, send, (line) => logs.push(line)),
      };
    };
    const allRows = (accountId: string) =>
      db.select().from(outbox).where(eq(outbox.accountId, accountId));

    it("送れたら done にし、送信済みフォルダへの控え (append) は積まない", async () => {
      const { mail, userId } = await enqueueOne();
      const { send, result } = run(mail, { status: "sent" });
      expect(await result).toMatchObject({ sent: 1, failed: 0, queued: false });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].calendar?.method).toBe("REQUEST");
      const list = await allRows(mail.id);
      expect(list.map((row) => [row.kind, row.status])).toEqual([
        ["imip_send", "done"],
      ]);
      expect(await conflictsOf(userId)).toHaveLength(0);
    });

    it("確定した失敗は failed と invite_failed を 1 件残す", async () => {
      const { mail, userId, calendar, eventId } = await enqueueOne();
      const { result } = run(mail, {
        status: "failed",
        reason: "宛先が拒否されました",
      });
      expect(await result).toMatchObject({ sent: 0, failed: 1 });
      const [row] = await allRows(mail.id);
      expect(row?.status).toBe("failed");
      const conflicts = await conflictsOf(userId);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        kind: "invite_failed",
        calendarId: calendar.id,
        eventId,
        title: "定例会議",
        reason: "招待メールを送れませんでした: 宛先が拒否されました",
        lost: { outboxId: row?.id, method: "REQUEST", to: ["a@other.example"] },
      });
    });

    it("REPLY の失敗は出欠の返事の文言にする", async () => {
      const { mail, userId } = await enqueueOne("REPLY");
      await run(mail, { status: "failed", reason: "x" }).result;
      const [conflict] = await conflictsOf(userId);
      expect(conflict?.reason).toBe("出欠の返事を主催者へ送れませんでした: x");
    });

    it("一時的な失敗は時間を置いてやり直し、例外もやり直す", async () => {
      const { mail, userId } = await enqueueOne();
      await run(mail, { status: "retry", reason: "接続できません" }).result;
      let [row] = await allRows(mail.id);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(1);
      expect(row?.runAfter.getTime()).toBeGreaterThan(Date.now());
      await db
        .update(outbox)
        .set({ runAfter: new Date(0) })
        .where(eq(outbox.accountId, mail.id));
      await run(mail, new Error("socket hang up")).result;
      [row] = await allRows(mail.id);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(2);
      expect(await conflictsOf(userId)).toHaveLength(0);
    });

    it("送信の途中で止まった行 (processing) は送り直し、上限を超えたら失敗にする", async () => {
      const { mail } = await enqueueOne("REQUEST", {
        status: "processing",
        attempts: 1,
      });
      const { send, result } = run(mail, { status: "sent" });
      expect((await result).sent).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      const [row] = await allRows(mail.id);
      expect(row?.status).toBe("done");
      expect(row?.attempts).toBe(2);

      const exhausted = await enqueueOne("REQUEST", {
        status: "processing",
        attempts: 5,
      });
      const second = run(exhausted.mail, { status: "sent" });
      expect((await second.result).failed).toBe(1);
      expect(second.send).not.toHaveBeenCalled();
      expect((await allRows(exhausted.mail.id))[0]?.status).toBe("failed");
      expect(await conflictsOf(exhausted.userId)).toHaveLength(1);
    });

    it("送る直前に scheduling が mail でなくなっていたら送らない", async () => {
      const { mail, userId, calendar } = await enqueueOne();
      await db
        .update(calendars)
        .set({ readOnly: true })
        .where(eq(calendars.id, calendar.id));
      const { send, result } = run(mail, { status: "sent" });
      expect((await result).failed).toBe(1);
      expect(send).not.toHaveBeenCalled();
      expect((await allRows(mail.id))[0]?.status).toBe("failed");
      expect(await conflictsOf(userId)).toHaveLength(1);

      // 送信元が受信専用になった。
      const other = await enqueueOne();
      const receiveOnly = { ...other.mail, smtpHost: null };
      const second = run(receiveOnly, { status: "sent" });
      expect((await second.result).failed).toBe(1);
      expect(second.send).not.toHaveBeenCalled();
    });

    it("一部の宛先だけ拒否されたら done にし、partial の記録を残す", async () => {
      const { mail, userId } = await enqueueOne();
      await run(mail, {
        status: "sent",
        warning: "次の宛先には送信できませんでした: a@other.example",
      }).result;
      const [row] = await allRows(mail.id);
      expect(row?.status).toBe("done");
      const [conflict] = await conflictsOf(userId);
      expect(conflict?.lost).toMatchObject({ partial: true });
    });

    it("メールの processOutbox は imip_send を拾わない", async () => {
      const { mail } = await enqueueOne();
      const execute = vi.fn(async () => ({ ok: true as const }));
      const result = await processOutbox(db, mail.id, execute, () => {});
      expect(result).toEqual({ done: 0, failed: 0 });
      expect(execute).not.toHaveBeenCalled();
      expect((await allRows(mail.id))[0]?.status).toBe("pending");
    });
  });

  describe("CalDAV の書き戻しの成功後に積む", () => {
    const setup = async () => {
      const { userId, mail } = await fresh();
      const dav = await insertAccount(db, userId, {
        email: "me@dav.example",
        username: "me@dav.example",
        provider: "generic",
        authType: "password",
        mailEnabled: false,
        calendarEnabled: true,
      });
      const calendar = await insertCalendar(db, userId, dav.id, {
        source: "caldav",
        providerState: { autoSchedule: false },
        timeZone: "Asia/Tokyo",
      });
      const fake = new FakeCalendarProvider({ source: "caldav" });
      fake.putRemote(calendar.remoteId as string, []);
      const run = () =>
        processEventOutbox({
          db,
          account: dav,
          provider: fake,
          ctx: makeProviderContext({ account: dav }),
          log: () => {},
        });
      return { userId, mail, dav, calendar, fake, run };
    };
    let order = 0;
    const enqueueEvent = (
      accountId: string,
      kind: "event_create" | "event_update" | "event_delete",
      payload: Record<string, unknown>,
      key: string,
    ) => {
      order++;
      return db.insert(outbox).values({
        accountId,
        kind,
        payload,
        idempotencyKey: key,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)),
      });
    };

    it("作成が相手側に書けたら、送信元のメールアカウントに imip_send を積む", async () => {
      const { userId, mail, dav, calendar, run } = await setup();
      const { id } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: [{ email: "a@other.example" }],
      });
      await enqueueEvent(
        dav.id,
        "event_create",
        {
          eventId: id,
          calendarId: calendar.id,
          imip: plan(mail.id, [request([{ address: "a@other.example" }])]),
        },
        `event_create:${id}`,
      );
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      const list = await imipRows(mail.id);
      expect(list).toHaveLength(1);
      expect(list[0]?.idempotencyKey).toBe(`imip:event_create:${id}:REQUEST:0`);
      // カレンダーのアカウント (CalDAV) には積まない。
      expect(await imipRows(dav.id)).toHaveLength(0);
      const payload = list[0]?.payload as unknown as ImipSendPayload;
      expect(payload.imip.calendarId).toBe(calendar.id);
      expect(payload.imip.eventId).toBe(id);
    });

    it("確定した失敗 (巻き戻し) では積まない", async () => {
      const { userId, mail, dav, calendar, fake, run } = await setup();
      const { id } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: [{ email: "a@other.example" }],
      });
      fake.enqueue("createEvent", {
        status: "rejected",
        reason: "サーバーに拒否されました",
      });
      await enqueueEvent(
        dav.id,
        "event_create",
        {
          eventId: id,
          calendarId: calendar.id,
          imip: plan(mail.id, [request([{ address: "a@other.example" }])]),
        },
        `event_create:${id}`,
      );
      expect(await run()).toMatchObject({ done: 0, failed: 1 });
      expect(await imipRows(mail.id)).toHaveLength(0);
    });

    it("削除は相手側の DELETE の後に CANCEL を積み、相手側に作る前に消した予定には送らない", async () => {
      const { userId, mail, dav, calendar, fake, run } = await setup();
      fake.putRemote(calendar.remoteId as string, [
        { remoteId: "ev", summary: "定例会議" },
      ]);
      const goneId = crypto.randomUUID();
      const cancel = (uid: string) =>
        buildItip({
          method: "CANCEL",
          events: [{ ...sampleEvent, uid, organizer: { email: mail.email } }],
          dtstamp: new Date(STAMP),
          defaultTimeZone: "Asia/Tokyo",
        });
      const target = (remoteId: string | null) => ({
        eventId: goneId,
        remoteId,
        etag: null,
        uid: "ev@fake",
        recurrenceId: null,
        parentRemoteId: null,
      });
      const deletePlan = plan(mail.id, [
        {
          method: "CANCEL",
          to: [{ address: "a@other.example" }],
          scope: "series",
          reason: "delete",
          content: cancel("ev@fake"),
        },
      ]);
      await enqueueEvent(
        dav.id,
        "event_delete",
        {
          calendarId: calendar.id,
          target: target("ev"),
          deletedAt: new Date().toISOString(),
          imip: deletePlan,
        },
        `event_delete:${goneId}`,
      );
      await enqueueEvent(
        dav.id,
        "event_delete",
        {
          calendarId: calendar.id,
          target: { ...target(null), eventId: crypto.randomUUID() },
          deletedAt: new Date().toISOString(),
          imip: deletePlan,
        },
        "event_delete:never-created",
      );
      expect(await run()).toMatchObject({ done: 2, failed: 0 });
      expect(
        fake.calls.filter((call) => call.method === "deleteEvent"),
      ).toHaveLength(1);
      const list = await imipRows(mail.id);
      expect(list.map((row) => row.idempotencyKey)).toEqual([
        `imip:event_delete:${goneId}:CANCEL:0`,
      ]);
      expect(userId).toBeTruthy();
    });

    it("書き戻しの後で送信元が使えなくなっていたら、送らずに invite_failed を残す", async () => {
      const { userId, mail, dav, calendar, run } = await setup();
      const { id } = await insertEvent(userId, calendar, {
        organizer: "someone-else@example.com",
        attendees: [{ email: "a@other.example" }],
      });
      await enqueueEvent(
        dav.id,
        "event_create",
        {
          eventId: id,
          calendarId: calendar.id,
          imip: plan(mail.id, [request([{ address: "a@other.example" }])]),
        },
        `event_create:${id}`,
      );
      expect(await run()).toMatchObject({ done: 1, failed: 0 });
      expect(await imipRows(mail.id)).toHaveLength(0);
      const conflicts = await conflictsOf(userId);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        kind: "invite_failed",
        eventId: id,
        lost: { outboxId: null, method: "REQUEST", to: ["a@other.example"] },
      });
    });

    it("自動スケジュールに変わったカレンダーでは積まず、記録も残さない", async () => {
      const { userId, mail, dav, calendar, run } = await setup();
      await db
        .update(calendars)
        .set({ providerState: { autoSchedule: true } })
        .where(eq(calendars.id, calendar.id));
      const { id } = await insertEvent(userId, calendar, {
        organizer: mail.email,
        attendees: [{ email: "a@other.example" }],
      });
      await enqueueEvent(
        dav.id,
        "event_create",
        {
          eventId: id,
          calendarId: calendar.id,
          imip: plan(mail.id, [request([{ address: "a@other.example" }])]),
        },
        `event_create:${id}`,
      );
      expect(await run()).toMatchObject({ done: 1 });
      expect(await imipRows(mail.id)).toHaveLength(0);
      expect(await conflictsOf(userId)).toHaveLength(0);
    });

    it("同期の周回は、CalDAV のカレンダーごとの送信元のアドレスを self の判定に渡す", async () => {
      const { userId, mail, dav, calendar } = await setup();
      const auto = await insertCalendar(db, userId, dav.id, {
        source: "caldav",
        providerState: { autoSchedule: true },
      });
      const addresses = await calendarImipAddresses(db, dav);
      expect(addresses.get(calendar.id)).toBe(mail.email);
      // サーバーが招待を送るカレンダーには足さない。
      expect(addresses.has(auto.id)).toBe(false);
    });
  });
});
