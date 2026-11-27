import { randomUUID } from "node:crypto";
import {
  googleCalendarChannelToken,
  googleCalendarWebhookUrl,
  normalizeRecurrenceId,
} from "@orbit/core";
import type {
  CalendarProvider,
  CalendarProviderDeps,
  CalendarRow,
  EventDelta,
  EventSnapshot,
  ProviderContext,
  RemoteCalendar,
  RemoteEvent,
  WriteResult,
} from "../provider.js";
import {
  failure,
  type GoogleResponse,
  googleRequest,
  segment,
} from "./client.js";
import {
  BIRTHDAYS_REMOTE_ID,
  birthdaysCalendar,
  calendarFromGoogle,
  createToGoogle,
  eventFromGoogle,
  type GoogleCalendarListEntry,
  type GoogleEvent,
  googleEventIdFor,
  googleTarget,
  parseGoogleRaw,
  patchToGoogle,
  recurrenceToGoogle,
} from "./convert.js";

/**
 * Google Calendar API のプロバイダ (担当 4)。
 * - 一覧は calendarList.list。primary の誕生日 (eventType: birthday) は、読み取り専用の
 *   「誕生日」カレンダー (remoteId: orbit:birthdays) として別に返し、primary の同期からは外す。
 * - 差分は events.list の syncToken。410 なら全件から取り直す (full: true)。
 *   https://developers.google.com/workspace/calendar/api/guides/sync
 * - 作成は events.id から決まる ID (base32hex) で行い、409 duplicate なら既にある予定を返す。
 * - 変更は PATCH に If-Match を付ける (412 は conflict)。回の削除 (原本の exdates が増えた) は、
 *   その回 (instance) を status: cancelled にする書き込みに変える。
 * - 変更通知は events.watch / channels.stop。トークンは鍵から作る HMAC で、Webhook が照合する。
 *   https://developers.google.com/workspace/calendar/api/guides/push
 */

/** 1 ページの件数 (events.list の既定は 250、上限は 2500)。 */
const PAGE_SIZE = 250;
/** 変更通知のチャンネルの期限 (秒)。Google の既定と同じ 7 日。 */
const CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 期限のこれだけ前にチャンネルを作り直す。 */
const CHANNEL_RENEW_MARGIN_MS = 24 * 60 * 60_000;
/** watch を断られた (push 非対応のカレンダーなど) ら、これだけあけてから試し直す。 */
const WATCH_RETRY_MS = 24 * 60 * 60_000;

type PageCursor = { pageToken: string; full: boolean };

function encodeCursor(cursor: PageCursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(value: string | null): PageCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PageCursor>;
    if (typeof parsed.pageToken !== "string") return null;
    return { pageToken: parsed.pageToken, full: parsed.full === true };
  } catch {
    return null;
  }
}

function eventsPath(calendarId: string, eventId?: string) {
  const base = `/calendars/${segment(calendarId)}/events`;
  return eventId === undefined ? base : `${base}/${segment(eventId)}`;
}

/** 書き込みの失敗の応答を WriteResult にする。 */
function writeFailure(response: {
  status: number;
  reason: string | null;
  message: string;
}): WriteResult {
  if (response.status === 412) return { status: "conflict" };
  if (response.status === 404 || response.status === 410) {
    return { status: "gone" };
  }
  return { status: "rejected", reason: response.message };
}

/** 削除済みの予定 (取り消された回ではない) か。 */
function isDeleted(item: GoogleEvent) {
  return item.status === "cancelled" && !item.recurringEventId;
}

function stateOf(calendar: CalendarRow): Record<string, unknown> {
  return calendar.providerState ?? {};
}

async function getGoogleEvent(
  ctx: ProviderContext,
  calendarId: string,
  eventId: string,
): Promise<GoogleEvent | null> {
  const response = await googleRequest<GoogleEvent>(
    ctx,
    eventsPath(calendarId, eventId),
  );
  if (response.ok) return response.body;
  if (response.status === 404 || response.status === 410) return null;
  throw failure(response);
}

/** 原本の例外 (変えた回と取り消した回) を読む。iCalUID で引き、recurringEventId で絞る。 */
async function listExceptions(
  ctx: ProviderContext,
  calendarId: string,
  master: GoogleEvent,
): Promise<GoogleEvent[]> {
  if (!master.iCalUID) return [];
  const result: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await googleRequest<{
      items?: GoogleEvent[];
      nextPageToken?: string;
    }>(ctx, eventsPath(calendarId), {
      query: { iCalUID: master.iCalUID, maxResults: PAGE_SIZE, pageToken },
    });
    if (!response.ok) throw failure(response);
    for (const item of response.body.items ?? []) {
      if (item.recurringEventId === master.id) result.push(item);
    }
    pageToken = response.body.nextPageToken;
    if (!pageToken) break;
  }
  return result;
}

/**
 * 原本の回 (instance) を探す。まず events.instances の originalStart で引き、無ければ
 * Google の回の ID の決まった形 (<原本の ID>_<元の開始>) で取る。無ければ null。
 */
async function findInstance(
  ctx: ProviderContext,
  calendarId: string,
  masterId: string,
  recurrenceId: string,
): Promise<GoogleEvent | null> {
  const wanted = normalizeRecurrenceId(recurrenceId);
  const matches = (item: GoogleEvent) => {
    const original = item.originalStartTime;
    const value = original?.date ?? original?.dateTime;
    if (!value) return false;
    return original?.date
      ? original.date === wanted
      : normalizeRecurrenceId(new Date(value).toISOString()) === wanted;
  };
  const response = await googleRequest<{ items?: GoogleEvent[] }>(
    ctx,
    `${eventsPath(calendarId, masterId)}/instances`,
    { query: { originalStart: wanted, showDeleted: true, maxResults: 10 } },
  );
  if (response.ok) {
    const found = (response.body.items ?? []).find(matches);
    if (found) return found;
  } else if (response.status === 404 || response.status === 410) {
    return null;
  } else if (response.status !== 400) {
    throw failure(response);
  }
  const suffix = /^\d{4}-\d{2}-\d{2}$/.test(wanted)
    ? wanted.replaceAll("-", "")
    : wanted.replaceAll(/[-:]/g, "");
  const direct = await getGoogleEvent(ctx, calendarId, `${masterId}_${suffix}`);
  return direct && matches(direct) ? direct : null;
}

/**
 * 回が見つからないときの結果。原本が残っていれば rejected (原本まで消させない)、
 * 原本も無ければ gone。
 */
async function missingInstance(
  ctx: ProviderContext,
  calendarId: string,
  masterId: string,
): Promise<WriteResult> {
  const master = await getGoogleEvent(ctx, calendarId, masterId);
  if (!master || isDeleted(master)) return { status: "gone" };
  return { status: "rejected", reason: "その回が相手側にありません。" };
}

/** 回を、変えた内容で上書きする (例外を作る)。取り消しは status: cancelled にする。 */
async function writeInstance(
  ctx: ProviderContext,
  calendar: CalendarRow,
  calendarId: string,
  masterId: string,
  recurrenceId: string,
  event: EventSnapshot,
  fields: readonly string[],
): Promise<WriteResult> {
  const instance = await findInstance(ctx, calendarId, masterId, recurrenceId);
  if (!instance) return missingInstance(ctx, calendarId, masterId);
  const body =
    event.status === "cancelled"
      ? { status: "cancelled" }
      : patchToGoogle(event, fields, calendar, instance);
  if (Object.keys(body).length === 0) {
    return { status: "ok", events: [eventFromGoogle(instance, calendar)] };
  }
  const response = await googleRequest<GoogleEvent>(
    ctx,
    eventsPath(calendarId, instance.id),
    {
      method: "PATCH",
      query: { sendUpdates: "all" },
      body,
      ifMatch: instance.etag ?? null,
    },
  );
  if (!response.ok) return writeFailure(response);
  return { status: "ok", events: [eventFromGoogle(response.body, calendar)] };
}

/** 回を取り消す。既に取り消されていればそのまま返す。見つからなければ null。 */
async function cancelInstance(
  ctx: ProviderContext,
  calendar: CalendarRow,
  calendarId: string,
  masterId: string,
  recurrenceId: string,
): Promise<RemoteEvent | null> {
  const instance = await findInstance(ctx, calendarId, masterId, recurrenceId);
  if (!instance) return null;
  if (instance.status === "cancelled") {
    return eventFromGoogle(instance, calendar);
  }
  const response = await googleRequest<GoogleEvent>(
    ctx,
    eventsPath(calendarId, instance.id),
    {
      method: "PATCH",
      query: { sendUpdates: "all" },
      body: { status: "cancelled" },
      ifMatch: instance.etag ?? null,
    },
  );
  if (response.ok) return eventFromGoogle(response.body, calendar);
  if (response.status === 404 || response.status === 410) return null;
  if (response.status === 412) {
    throw new Error("回の取り消しが、相手側の変更と重なりました。");
  }
  throw failure(response);
}

function sameList(a: readonly string[] | null, b: readonly string[] | null) {
  const left = [...(a ?? [])].map(normalizeRecurrenceId).sort();
  const right = [...(b ?? [])].map(normalizeRecurrenceId).sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function birthdaysRejected(): WriteResult {
  return {
    status: "rejected",
    reason: "誕生日のカレンダーには書き込めません。",
  };
}

export function createGoogleProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  const defaultPollSeconds = deps.defaultPollSeconds ?? 900;

  const provider: CalendarProvider = {
    source: "google",
    defaultPollSeconds,

    async listCalendars(ctx) {
      const entries: GoogleCalendarListEntry[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page++) {
        const response = await googleRequest<{
          items?: GoogleCalendarListEntry[];
          nextPageToken?: string;
        }>(ctx, "/users/me/calendarList", {
          query: { maxResults: 250, pageToken },
        });
        if (!response.ok) throw failure(response);
        entries.push(...(response.body.items ?? []));
        pageToken = response.body.nextPageToken;
        if (!pageToken) break;
      }
      const result: RemoteCalendar[] = [];
      for (const entry of entries) {
        const calendar = calendarFromGoogle(entry);
        if (calendar) result.push(calendar);
      }
      const primary = entries.find((entry) => entry.primary && !entry.deleted);
      if (primary) result.push(birthdaysCalendar(primary));
      return result;
    },

    async syncEvents(ctx, calendar, cursor) {
      const target = googleTarget(calendar);
      const state = decodeCursor(cursor.pageCursor);
      let full = state ? state.full : cursor.syncToken === null;
      let pageToken = state?.pageToken;
      let response: GoogleResponse<{
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>;
      for (;;) {
        response = await googleRequest(ctx, eventsPath(target.calendarId), {
          query: {
            maxResults: PAGE_SIZE,
            eventTypes: target.eventTypes,
            pageToken,
            syncToken: full ? undefined : (cursor.syncToken ?? undefined),
          },
        });
        // 同期の位置が無効になった (410 fullSyncRequired)。全件から取り直す。
        if (!response.ok && response.status === 410 && !full) {
          ctx.log(
            `「${calendar.name}」の同期の位置が無効になったので、全件を取り直します`,
          );
          full = true;
          pageToken = undefined;
          continue;
        }
        break;
      }
      if (!response.ok) throw failure(response);
      const events: RemoteEvent[] = [];
      const deletedRemoteIds: string[] = [];
      for (const item of response.body.items ?? []) {
        // 誕生日は「誕生日」カレンダーの方で取り込む。
        if (!target.birthdays && item.eventType === "birthday") continue;
        if (isDeleted(item)) {
          deletedRemoteIds.push(item.id);
          continue;
        }
        events.push(eventFromGoogle(item, calendar));
      }
      const next = response.body.nextPageToken ?? null;
      const delta: EventDelta = {
        events,
        deletedRemoteIds,
        nextPageCursor: next ? encodeCursor({ pageToken: next, full }) : null,
        nextSyncToken: next ? null : (response.body.nextSyncToken ?? null),
        full,
      };
      return delta;
    },

    async getEvent(ctx, calendar, ref) {
      const target = googleTarget(calendar);
      const item = await getGoogleEvent(ctx, target.calendarId, ref.remoteId);
      if (!item || isDeleted(item)) return null;
      const result = [eventFromGoogle(item, calendar)];
      if (!item.recurringEventId && (item.recurrence?.length ?? 0) > 0) {
        for (const exception of await listExceptions(
          ctx,
          target.calendarId,
          item,
        )) {
          result.push(eventFromGoogle(exception, calendar));
        }
      }
      return result;
    },

    parseRaw(raw, calendar) {
      const item = parseGoogleRaw(raw);
      return item ? [eventFromGoogle(item, calendar)] : [];
    },

    async createEvent(ctx, calendar, write) {
      const target = googleTarget(calendar);
      if (target.birthdays) return birthdaysRejected();
      const id = googleEventIdFor(write.event.id);
      const body = createToGoogle(id, write.event, calendar);
      const response = await googleRequest<GoogleEvent>(
        ctx,
        eventsPath(target.calendarId),
        { method: "POST", query: { sendUpdates: "all" }, body },
      );
      let created: GoogleEvent;
      if (response.ok) {
        created = response.body;
      } else if (response.status === 409) {
        // 前回の実行で作成まで済んでいた (結果を保存する前に止まった)。
        const existing = await getGoogleEvent(ctx, target.calendarId, id);
        if (!existing) return { status: "conflict", remoteId: id };
        if (isDeleted(existing)) {
          // 同じ ID の予定が相手側で消されていた (作り直し)。消した予定を戻して上書きする。
          const { id: _id, ...rest } = body;
          const restored = await googleRequest<GoogleEvent>(
            ctx,
            eventsPath(target.calendarId, id),
            {
              method: "PATCH",
              query: { sendUpdates: "all" },
              body: { ...rest, status: rest.status ?? "confirmed" },
            },
          );
          if (!restored.ok) return writeFailure(restored);
          created = restored.body;
        } else {
          created = existing;
        }
      } else if (response.status === 404) {
        return { status: "gone" };
      } else {
        return { status: "rejected", reason: response.message };
      }
      const events = [eventFromGoogle(created, calendar)];
      // 作り直しで例外も持っていれば、その回を上書きする。
      for (const exception of write.exceptions) {
        if (!exception.recurrenceId) continue;
        const result = await writeInstance(
          ctx,
          calendar,
          target.calendarId,
          created.id,
          exception.recurrenceId,
          exception,
          [
            "summary",
            "location",
            "description",
            "status",
            "busy",
            "time",
            "reminders",
            "attendees",
          ],
        );
        if (result.status === "ok") events.push(...result.events);
        else {
          ctx.log(
            `予定 ${write.event.id} の回 ${exception.recurrenceId} を書けませんでした (${result.status})`,
          );
        }
      }
      return { status: "ok", events };
    },

    async updateEvent(ctx, calendar, ref, write) {
      const target = googleTarget(calendar);
      if (target.birthdays) return birthdaysRejected();
      const { event } = write;
      // まだ相手側に無い回の例外。原本の回を上書きして例外にする。
      if (event.remoteId === null && write.master && ref.recurrenceId) {
        return writeInstance(
          ctx,
          calendar,
          target.calendarId,
          ref.remoteId,
          ref.recurrenceId,
          event,
          write.fields,
        );
      }
      const base = parseGoogleRaw(event.raw);
      const body = patchToGoogle(event, write.fields, calendar, base);
      let cancel: string[] = [];
      if (event.recurrenceId === null && write.fields.includes("recurrence")) {
        const before = base ? eventFromGoogle(base, calendar) : null;
        const baseExdates = new Set(
          (before?.exdates ?? []).map(normalizeRecurrenceId),
        );
        const current = (event.exdates ?? []).map(normalizeRecurrenceId);
        if (before) {
          // 増えた exdates は、Google では回の取り消し (cancelled の例外) にする。
          cancel = current.filter((value) => !baseExdates.has(value));
          const kept = current.filter((value) => baseExdates.has(value));
          const changed =
            (before.rrule ?? null) !== (event.rrule ?? null) ||
            !sameList(before.rdates, event.rdates) ||
            !sameList([...baseExdates], kept);
          if (changed) {
            body.recurrence = recurrenceToGoogle({
              rrule: event.rrule,
              rdates: event.rdates,
              exdates: kept,
            });
          }
          // 繰り返しをやめたなら、回の取り消しは要らない。
          if (!event.rrule && !(event.rdates && event.rdates.length > 0)) {
            cancel = [];
          }
        } else {
          body.recurrence = recurrenceToGoogle(event);
        }
      }

      let written: GoogleEvent | null = null;
      if (Object.keys(body).length > 0) {
        const response = await googleRequest<GoogleEvent>(
          ctx,
          eventsPath(target.calendarId, ref.remoteId),
          {
            method: "PATCH",
            query: { sendUpdates: "all" },
            body,
            ifMatch: ref.etag,
          },
        );
        if (!response.ok) return writeFailure(response);
        if (isDeleted(response.body)) return { status: "gone" };
        written = response.body;
      }
      const events: RemoteEvent[] = [];
      for (const recurrenceId of cancel) {
        const cancelled = await cancelInstance(
          ctx,
          calendar,
          target.calendarId,
          ref.remoteId,
          recurrenceId,
        );
        if (cancelled) events.push(cancelled);
        else {
          ctx.log(
            `予定 ${ref.remoteId} の回 ${recurrenceId} が相手側に見つからないので、取り消しを飛ばしました`,
          );
        }
      }
      if (!written) {
        written = await getGoogleEvent(ctx, target.calendarId, ref.remoteId);
        if (!written || isDeleted(written)) return { status: "gone" };
      }
      return {
        status: "ok",
        events: [eventFromGoogle(written, calendar), ...events],
      };
    },

    async deleteEvent(ctx, calendar, ref) {
      const target = googleTarget(calendar);
      if (target.birthdays) return birthdaysRejected();
      // 回 (例外) の ID を消すと、Google ではその回の取り消しになる。
      const response = await googleRequest<null>(
        ctx,
        eventsPath(target.calendarId, ref.remoteId),
        {
          method: "DELETE",
          query: { sendUpdates: "all" },
          ifMatch: ref.etag,
        },
      );
      if (!response.ok) return writeFailure(response);
      return { status: "ok", events: [] };
    },

    async respond(ctx, calendar, ref, response) {
      const target = googleTarget(calendar);
      if (target.birthdays) return birthdaysRejected();
      const item = await getGoogleEvent(ctx, target.calendarId, ref.remoteId);
      if (!item || isDeleted(item)) return { status: "gone" };
      const email = ctx.account.email.toLowerCase();
      const self =
        item.attendees?.find((attendee) => attendee.self) ??
        item.attendees?.find(
          (attendee) => attendee.email?.toLowerCase() === email,
        );
      if (!self?.email) {
        return {
          status: "rejected",
          reason: "この予定の参加者ではないため、返事できません。",
        };
      }
      // attendeesOmitted で、自分の返事だけを書き換える (ほかの参加者は触らない)。
      const result = await googleRequest<GoogleEvent>(
        ctx,
        eventsPath(target.calendarId, item.id),
        {
          method: "PATCH",
          query: { sendUpdates: "all" },
          body: {
            attendeesOmitted: true,
            attendees: [
              {
                email: self.email,
                responseStatus: response.status,
                ...(response.comment === null
                  ? {}
                  : { comment: response.comment }),
              },
            ],
          },
        },
      );
      if (!result.ok) return writeFailure(result);
      return { status: "ok", events: [eventFromGoogle(result.body, calendar)] };
    },

    async maintainPush(ctx, calendarRows) {
      const address = googleCalendarWebhookUrl(ctx.webhookBaseUrl);
      if (!address) return;
      const now = Date.now();
      for (const calendar of calendarRows) {
        if (ctx.signal.aborted) return;
        if (!calendar.remoteId) continue;
        if (
          calendar.pushChannelId &&
          calendar.pushExpiresAt &&
          calendar.pushExpiresAt.getTime() - CHANNEL_RENEW_MARGIN_MS > now
        ) {
          continue;
        }
        const state = stateOf(calendar);
        const failedAt =
          typeof state.watchFailedAt === "string"
            ? Date.parse(state.watchFailedAt)
            : Number.NaN;
        if (!Number.isNaN(failedAt) && now - failedAt < WATCH_RETRY_MS) {
          continue;
        }
        const target = googleTarget(calendar);
        const channelId = randomUUID();
        const response = await googleRequest<{
          id?: string;
          resourceId?: string;
          expiration?: string | number;
        }>(ctx, `${eventsPath(target.calendarId)}/watch`, {
          method: "POST",
          query: { eventTypes: target.eventTypes },
          body: {
            id: channelId,
            type: "web_hook",
            address,
            token: googleCalendarChannelToken(ctx.encryptionKey, channelId),
            params: { ttl: String(CHANNEL_TTL_SECONDS) },
          },
        });
        if (!response.ok) {
          // push に対応しないカレンダー (祝日など) は、しばらく試さない。
          ctx.log(
            `「${calendar.name}」の変更通知を設定できませんでした: ${response.message}`,
          );
          await ctx.saveCalendarState(calendar.id, {
            providerState: { watchFailedAt: new Date(now).toISOString() },
          });
          continue;
        }
        const expiration = Number(response.body.expiration);
        // 古いチャンネルは止める (重なる間は、Webhook が知らないチャンネルとして捨てる)。
        if (calendar.pushChannelId) {
          await stopChannel(ctx, calendar).catch((error: unknown) => {
            ctx.log(
              `「${calendar.name}」の古い変更通知を止められませんでした: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        await ctx.saveCalendarState(calendar.id, {
          pushChannelId: channelId,
          pushExpiresAt: new Date(
            Number.isFinite(expiration) && expiration > 0
              ? expiration
              : now + CHANNEL_TTL_SECONDS * 1000,
          ),
          providerState: {
            pushResourceId: response.body.resourceId ?? null,
            watchFailedAt: null,
          },
        });
      }
    },

    async stopPush(ctx, calendar) {
      await stopChannel(ctx, calendar);
      await ctx.saveCalendarState(calendar.id, {
        pushChannelId: null,
        pushExpiresAt: null,
        providerState: { pushResourceId: null },
      });
    },
  };
  return provider;
}

/** channels.stop。チャンネルが既に無ければ (404) 止まっているとみなす。 */
async function stopChannel(ctx: ProviderContext, calendar: CalendarRow) {
  const resourceId = stateOf(calendar).pushResourceId;
  if (!calendar.pushChannelId || typeof resourceId !== "string") return;
  const response = await googleRequest<null>(ctx, "/channels/stop", {
    method: "POST",
    body: { id: calendar.pushChannelId, resourceId },
  });
  if (!response.ok && response.status !== 404) throw failure(response);
}

export { BIRTHDAYS_REMOTE_ID };
