import { readFile } from "node:fs/promises";
import { zValidator } from "@hono/zod-validator";
import {
  attachmentPath,
  attachmentsDir,
  CALENDAR_WRITEBACK_SOURCES,
  type EventFieldChanges,
  type ParsedEvent,
  parseICalendar,
} from "@orbit/core";
import {
  accounts,
  attachments,
  calendars,
  eventAttendees,
  events,
  messages,
} from "@orbit/db";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { calendarIdentities, selfIsMe } from "../lib/calendar-identity.js";
import type { EventsHub } from "../lib/events-hub.js";
import {
  ensureReceivedAttachment,
  statusOfFetchError,
} from "../lib/received-attachments.js";

/**
 * メールの招待 (text/calendar の添付) の中身 `GET /v1/messages/:id/invite`。
 * 設計は calendar-dev/invites-design.md の 4.4 と 6 章。
 *
 * 8a ではメールの中身を予定の書き込みに使わない。表示用に読んで返し、利用者のカレンダーに
 * 同じ UID の予定があれば、その予定の ID を添える (返事はその予定に対して端末が送る)。
 */

/** これより大きい招待は読まない (9 章)。 */
export const MAX_INVITE_BYTES = 1024 * 1024;

/**
 * これより行の多い招待は読まない。ふつうの招待は数百行 (参加者が多くても数千行) なので余裕を見た値。
 * 1 MB に収まる悪意のある入力 (閉じない BEGIN、同じ UID の予定を並べる など) で API を止めないため。
 */
export const MAX_INVITE_LINES = 10_000;

export type InviteMethod = "request" | "cancel" | "reply" | "other";

export type MessageInvite = {
  method: InviteMethod;
  uid: string;
  sequence: number;
  recurrenceId: string | null;
  summary: string | null;
  location: string | null;
  /** PATCH の time と同じ形。 */
  time: NonNullable<EventFieldChanges["time"]>;
  rrule: string | null;
  organizer: { email: string; name: string | null } | null;
  attendeeCount: number;
  /** REPLY のとき、返事をした参加者 (先頭の ATTENDEE)。それ以外は null。 */
  reply: {
    email: string;
    name: string | null;
    status: ParsedEvent["attendees"][number]["status"];
  } | null;
  /** カレンダーにある同じ予定。無ければ null。 */
  eventId: string | null;
  /** その予定の sequence (メールが古いかの判定用)。 */
  eventSequence: number | null;
};

const METHODS: Record<string, InviteMethod> = {
  REQUEST: "request",
  CANCEL: "cancel",
  REPLY: "reply",
};

/** 招待として読む添付か。text/calendar を優先し、次に名前が .ics のもの。 */
function invitePriority(file: {
  filename: string | null;
  contentType: string;
}): number {
  const type = file.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "text/calendar") return 2;
  if (type === "application/ics" || /\.ics$/i.test(file.filename ?? "")) {
    return 1;
  }
  return 0;
}

function timeOf(event: ParsedEvent): MessageInvite["time"] | null {
  if (event.allDay) {
    if (!event.startDate || !event.endDate) return null;
    return {
      allDay: true,
      startDate: event.startDate,
      endDate: event.endDate,
    };
  }
  if (!event.startAt || !event.endAt) return null;
  return {
    allDay: false,
    startAt: event.startAt,
    endAt: event.endAt,
    startTimeZone: event.startTimeZone,
    endTimeZone: event.endTimeZone,
  };
}

export function messageInviteRoutes({
  db,
  hub,
  writebackSources = CALENDAR_WRITEBACK_SOURCES,
}: Pick<RouteDeps, "db"> & {
  hub: EventsHub;
  /** 予定を書き戻せるプロバイダの source (テストで差し替える)。 */
  writebackSources?: readonly string[];
}) {
  const app = new Hono<AppEnv>();
  const dir = attachmentsDir();
  const writable = new Set(writebackSources);

  app.get(
    "/:id/invite",
    zValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.var.user.id;
      // 1. メールを利用者の ID で探す。
      const [message] = await db
        .select({ id: messages.id, accountId: messages.accountId })
        .from(messages)
        .innerJoin(accounts, eq(accounts.id, messages.accountId))
        .where(and(eq(messages.id, id), eq(accounts.userId, userId)));
      if (!message) return c.json({ error: "not_found" }, 404);

      // 2. 対象の添付を 1 つ選ぶ。
      const files = await db
        .select({
          id: attachments.id,
          filename: attachments.filename,
          contentType: attachments.contentType,
          size: attachments.size,
        })
        .from(attachments)
        .where(eq(attachments.messageId, id))
        .orderBy(asc(attachments.partId));
      const candidate = files
        .filter((file) => invitePriority(file) > 0)
        .sort((a, b) => invitePriority(b) - invitePriority(a))[0];
      if (!candidate || candidate.size > MAX_INVITE_BYTES) {
        return c.json({ invite: null });
      }

      // 3. 実体を用意して読む。
      const result = await ensureReceivedAttachment(
        { db, hub, dir },
        userId,
        id,
        candidate.id,
      );
      if (!result.ok) {
        return c.json(
          { error: result.error },
          statusOfFetchError(result.error),
        );
      }
      const content = await readFile(
        attachmentPath(dir, result.attachment.storageKey),
      ).catch(() => null);
      if (!content) return c.json({ error: "fetch_failed" }, 502);
      if (content.byteLength > MAX_INVITE_BYTES)
        return c.json({ invite: null });

      // 4. 先頭の UID の予定 (原本があれば原本、無ければ最初の例外) を使う。
      let parsed: ReturnType<typeof parseICalendar>;
      try {
        parsed = parseICalendar(content.toString("utf8"), {
          defaultTimeZone: "UTC",
          maxEvents: 100,
          maxLines: MAX_INVITE_LINES,
        });
      } catch {
        return c.json({ invite: null });
      }
      const uid = parsed.events[0]?.uid;
      const sameUid = parsed.events.filter((event) => event.uid === uid);
      const event =
        sameUid.find((entry) => entry.recurrenceId === null) ?? sameUid[0];
      const time = event ? timeOf(event) : null;
      if (!event || !time) return c.json({ invite: null });
      const method = METHODS[parsed.method ?? ""] ?? "other";

      // 5. 利用者の予定から同じ UID を探す。書き込めるカレンダーで、self の参加者がいる行。
      //    共有カレンダーの self は自分とは限らないので、自分を指す行だけ (レビュー 3)。
      const rows = await db
        .select({
          id: events.id,
          calendarId: events.calendarId,
          sequence: events.sequence,
          recurrenceId: events.recurrenceId,
          accountId: calendars.accountId,
          source: calendars.source,
          readOnly: calendars.readOnly,
          selfEmail: eventAttendees.email,
        })
        .from(events)
        .innerJoin(calendars, eq(calendars.id, events.calendarId))
        .innerJoin(
          eventAttendees,
          and(
            eq(eventAttendees.eventId, events.id),
            eq(eventAttendees.self, true),
          ),
        )
        .where(
          and(
            eq(events.userId, userId),
            eq(calendars.userId, userId),
            eq(events.uid, event.uid),
          ),
        );
      const identities = await calendarIdentities(
        db,
        rows.map((row) => row.calendarId),
      );
      const candidates = rows
        .filter(
          (row) =>
            !row.readOnly &&
            (row.source === "local" ||
              (writable.has(row.source) && row.accountId !== null)),
        )
        .filter((row) =>
          selfIsMe(
            [{ email: row.selfEmail, self: true }],
            identities.get(row.calendarId),
          ),
        )
        // 同じ回 (例外) を先に、無ければ原本。
        .filter(
          (row) =>
            row.recurrenceId === event.recurrenceId ||
            row.recurrenceId === null,
        )
        .sort((a, b) => {
          const sameOccurrence =
            Number(b.recurrenceId === event.recurrenceId) -
            Number(a.recurrenceId === event.recurrenceId);
          if (sameOccurrence !== 0) return sameOccurrence;
          return (
            Number(b.accountId === message.accountId) -
            Number(a.accountId === message.accountId)
          );
        });
      const found = candidates[0] ?? null;

      const replying = method === "reply" ? event.attendees[0] : undefined;
      const invite: MessageInvite = {
        method,
        uid: event.uid,
        sequence: event.sequence,
        recurrenceId: event.recurrenceId,
        summary: event.summary,
        location: event.location,
        time,
        rrule: event.rrule,
        organizer: event.organizer
          ? { email: event.organizer.email, name: event.organizer.name ?? null }
          : null,
        attendeeCount: event.attendees.length,
        reply: replying
          ? {
              email: replying.email,
              name: replying.name,
              status: replying.status,
            }
          : null,
        eventId: found?.id ?? null,
        eventSequence: found?.sequence ?? null,
      };
      return c.json({ invite });
    },
  );

  return app;
}
