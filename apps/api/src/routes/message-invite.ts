import { zValidator } from "@hono/zod-validator";
import {
  attachmentsDir,
  CALENDAR_WRITEBACK_SOURCES,
  type EventFieldChanges,
  type InviteApplyResult,
  type MessageInviteImipFields,
  type ParsedEvent,
} from "@orbit/core";
import { calendars, eventAttendees, events } from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { calendarIdentities, selfIsMe } from "../lib/calendar-identity.js";
import type { EventsHub } from "../lib/events-hub.js";
import {
  applyInvite,
  inspectInvite,
  loadMessageInvite,
} from "../lib/invite-apply.js";

export { MAX_INVITE_BYTES, MAX_INVITE_LINES } from "../lib/invite-apply.js";

/**
 * メールの招待 (text/calendar の添付) の中身 `GET /v1/messages/:id/invite`。
 * 設計は calendar-dev/invites-design.md の 4.4 と 6 章。
 *
 * 表示用に読んで返し、利用者のカレンダーに同じ UID の予定があれば、その予定の ID を添える
 * (返事はその予定に対して端末が送る)。8b (imip-design 7・8・10.3 章) で、サーバーが決めた
 * 「いまできる操作」(action) を足し、書き込みは POST /:id/invite/apply だけが行う
 * (lib/invite-apply.ts。サーバーが添付を読み直す)。
 */

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
  /**
   * その予定のカレンダー上の日時 (time と同じ形)。メールと日時がずれていても、端末が
   * この日時で予定を探せるように添える。予定が無ければ null。
   */
  eventTime: MessageInvite["time"] | null;
} & MessageInviteImipFields;

const METHODS: Record<string, InviteMethod> = {
  REQUEST: "request",
  CANCEL: "cancel",
  REPLY: "reply",
};

/** 予定の行の日時を、time と同じ形にする。 */
function timeOfRow(row: {
  allDay: boolean;
  startAt: Date | null;
  endAt: Date | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  endTimeZone: string | null;
}): MessageInvite["time"] | null {
  if (row.allDay) {
    if (!row.startDate) return null;
    return {
      allDay: true,
      startDate: row.startDate,
      endDate: row.endDate ?? row.startDate,
    };
  }
  if (!row.startAt) return null;
  return {
    allDay: false,
    startAt: row.startAt.toISOString(),
    endAt: (row.endAt ?? row.startAt).toISOString(),
    startTimeZone: row.startTimeZone,
    endTimeZone: row.endTimeZone,
  };
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
      // 1〜4. メールを利用者の ID で探し、招待の添付を読む (先頭の UID の原本、無ければ最初の例外)。
      const loaded = await loadMessageInvite({ db, hub, dir }, userId, id);
      if (!loaded.ok) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      if (!loaded.invite) return c.json({ invite: null });
      const message = loaded.invite.message;
      const event: ParsedEvent = loaded.invite.primary;
      const time = timeOf(event);
      if (!time) return c.json({ invite: null });
      const method = METHODS[loaded.invite.method ?? ""] ?? "other";

      // 5. 利用者の予定から同じ UID を探す。書き込めるカレンダーで、self の参加者がいる行。
      //    共有カレンダーの self は自分とは限らないので、自分を指す行だけ (レビュー 3)。
      const rows = await db
        .select({
          id: events.id,
          calendarId: events.calendarId,
          sequence: events.sequence,
          recurrenceId: events.recurrenceId,
          allDay: events.allDay,
          startAt: events.startAt,
          endAt: events.endAt,
          startDate: events.startDate,
          endDate: events.endDate,
          startTimeZone: events.startTimeZone,
          endTimeZone: events.endTimeZone,
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
      const replying = method === "reply" ? event.attendees[0] : undefined;
      // 8b: いまできる操作 (取り込み・更新・取り消し・REPLY の反映)。
      const inspection = await inspectInvite(db, {
        userId,
        invite: loaded.invite,
        writable,
      });
      const { fields } = inspection;
      // 操作の対象の予定があれば、それを返す (8a の選び方と別の予定を指さないように。
      // self なしで取り込んだ予定も、更新・取り消しの対象として返す。レビュー 8b 指摘 17)。
      let found: (typeof rows)[number] | null = null;
      if (inspection.eventId) {
        found = rows.find((row) => row.id === inspection.eventId) ?? null;
        if (!found) {
          const [row] = await db
            .select({
              id: events.id,
              calendarId: events.calendarId,
              sequence: events.sequence,
              recurrenceId: events.recurrenceId,
              allDay: events.allDay,
              startAt: events.startAt,
              endAt: events.endAt,
              startDate: events.startDate,
              endDate: events.endDate,
              startTimeZone: events.startTimeZone,
              endTimeZone: events.endTimeZone,
              accountId: calendars.accountId,
              source: calendars.source,
              readOnly: calendars.readOnly,
              selfEmail: sql<string>`''`,
            })
            .from(events)
            .innerJoin(calendars, eq(calendars.id, events.calendarId))
            .where(
              and(
                eq(events.id, inspection.eventId),
                eq(events.userId, userId),
                eq(calendars.userId, userId),
              ),
            );
          found = row ?? null;
        }
      }
      found ??= candidates[0] ?? null;
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
        eventTime: found ? timeOfRow(found) : null,
        ...fields,
      };
      return c.json({ invite });
    },
  );

  /**
   * メールの招待を反映する (imip-design 10.3)。取り込み (import)、更新 (update)、
   * 取り消し (remove)、REPLY の反映 (apply_reply)。サーバーが添付を読み直して操作を決め、
   * expect と違えば 409 changed。済んでいれば applied: false (何度呼んでも同じ)。
   */
  app.post(
    "/:id/invite/apply",
    zValidator("param", z.object({ id: z.uuid() })),
    zValidator(
      "json",
      z.object({
        expect: z.enum(["import", "update", "remove", "apply_reply"]),
        calendarId: z.uuid().optional(),
        confirmed: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const loaded = await loadMessageInvite({ db, hub, dir }, userId, id);
      if (!loaded.ok) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      if (!loaded.invite) return c.json({ error: "unsupported_method" }, 409);
      const outcome = await applyInvite(db, {
        userId,
        invite: loaded.invite,
        writable,
        expect: body.expect,
        calendarId: body.calendarId,
        confirmed: body.confirmed,
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error }, outcome.status);
      }
      const response: InviteApplyResult = {
        applied: outcome.applied,
        eventId: outcome.eventId,
      };
      return c.json(response);
    },
  );

  return app;
}
