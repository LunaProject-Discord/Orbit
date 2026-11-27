import {
  CaldavAuthError,
  CaldavClient,
  CaldavHostError,
  CaldavHttpError,
  type CaldavResource,
  type CaldavResourceRef,
  CaldavSyncTokenError,
  type ICalEventData,
  ICalendarError,
  type ICalWriteEntry,
  ICLOUD_CALDAV_URL,
  normalizeRecurrenceId,
  parseICalendar,
  writeICalendar,
} from "@orbit/core";
import {
  type AccountRow,
  CalendarAuthError,
  type CalendarProvider,
  type CalendarProviderDeps,
  type CalendarRow,
  CalendarTransientError,
  type EventDelta,
  type EventSnapshot,
  type EventWrite,
  type ProviderContext,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
  type WriteResult,
} from "../provider.js";

/**
 * CalDAV (iCloud と一般の CalDAV サーバー) のプロバイダ。
 * - remoteId はリソースの href (パス)。1 つのリソースに原本と例外が入るので、同じ remoteId と etag の行が
 *   複数になり、raw にはリソース全体 (VCALENDAR) を入れる。
 * - 差分は、sync-collection (RFC 6578) に対応していればそれを、無ければ getctag と ETag の比較で取る。
 *   calendars.syncToken は "sync:<token>" か "ctag:<getctag>"。
 * - 書き込みは PUT (作成は If-None-Match: *、更新は If-Match)、削除は DELETE。
 *   回の削除は、原本に EXDATE を足してリソースを書き直す。
 * - 接続先の検査 (内部ネットワークへの接続を防ぐ) は CaldavClient が行う (リダイレクト先と href の先も)。
 */

/** 1 ページで中身を取るリソースの数 (calendar-multiget 1 回分)。 */
const PAGE_SIZE = 100;

export type CaldavProviderDeps = CalendarProviderDeps & {
  /** 名前解決の差し替え (テスト用)。 */
  isPrivateHost?: (host: string) => Promise<boolean>;
  now?: () => Date;
};

/** syncEvents のページの間で持ち回る状態 (cursor.pageCursor に JSON で入れる。保存はされない)。 */
type PageState = {
  fetch: string[];
  full: boolean;
  token: string | null;
  ctag: string | null;
};

/** カレンダーの providerState に入れるもの。 */
type CaldavCalendarState = { syncCollection?: boolean };

function startUrlOf(account: AccountRow): string {
  if (account.caldavUrl) return account.caldavUrl;
  if (account.provider === "icloud") return ICLOUD_CALDAV_URL;
  throw new CalendarAuthError("CalDAV サーバーの URL が設定されていません。");
}

function collectionUrlOf(calendar: CalendarRow): string {
  const url = calendar.url ?? calendar.remoteId;
  if (!url) throw new Error("カレンダーの URL がありません。");
  return url;
}

/** CalDAV のエラーを、土台が扱う例外にする。 */
function translate(error: unknown): unknown {
  if (error instanceof CaldavAuthError) {
    return new CalendarAuthError(
      "CalDAV サーバーにログインできませんでした。パスワード (iCloud はアプリ用パスワード) を確かめてください。",
      { needsReauth: true, cause: error },
    );
  }
  if (error instanceof CaldavHostError) {
    if (error.reason === "host_not_found") return error;
    return new CalendarAuthError(error.message, { cause: error });
  }
  if (error instanceof CaldavHttpError && error.retryAfterMs !== null) {
    return new CalendarTransientError(error.message, {
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translate(error);
  }
}

function isTimeZone(zone: string | null): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function lastSegment(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const last = segments.at(-1) ?? url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** DB の行を、書き出す形にする。 */
function toData(snapshot: EventSnapshot): ICalEventData {
  return {
    uid: snapshot.uid,
    recurrenceId: snapshot.recurrenceId,
    summary: snapshot.summary,
    location: snapshot.location,
    description: snapshot.description,
    status: snapshot.status as ICalEventData["status"],
    busy: snapshot.busy,
    allDay: snapshot.allDay,
    startAt: snapshot.startAt,
    endAt: snapshot.endAt,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    startTimeZone: snapshot.startTimeZone,
    endTimeZone: snapshot.endTimeZone,
    rrule: snapshot.rrule,
    rdates: snapshot.rdates,
    exdates: snapshot.exdates,
    organizer: snapshot.organizer,
    attendees: snapshot.attendees.map((attendee) => ({
      email: attendee.email,
      name: attendee.name,
      role: attendee.role,
      status: attendee.status,
    })),
    sequence: snapshot.sequence,
    conferenceUrl: snapshot.conferenceUrl,
    useDefaultReminders: snapshot.useDefaultReminders,
    reminders: snapshot.useDefaultReminders ? null : snapshot.reminders,
  };
}

export function createCaldavProvider(
  deps: CaldavProviderDeps = {},
): CalendarProvider {
  const now = () => deps.now?.() ?? new Date();

  function clientOf(ctx: ProviderContext): CaldavClient {
    if (ctx.auth.type !== "password") {
      throw new CalendarAuthError(
        "CalDAV にはパスワードでのログインが必要です。",
      );
    }
    return new CaldavClient({
      username: ctx.auth.username,
      password: ctx.auth.password,
      fetchFn: ctx.fetchFn,
      signal: ctx.signal,
      allowPrivateHosts: ctx.allowPrivateHosts,
      ...(deps.isPrivateHost ? { isPrivateHost: deps.isPrivateHost } : {}),
    });
  }

  function selfAddresses(account: AccountRow): Set<string> {
    return new Set(
      [account.email, account.username]
        .filter((value) => value.includes("@"))
        .map((value) => value.toLowerCase()),
    );
  }

  /** リソース 1 つを予定の行にする。読めなければ空。 */
  function toRemoteEvents(
    resource: CaldavResource,
    calendar: CalendarRow,
    account: AccountRow | null,
  ): RemoteEvent[] {
    const parsed = parseICalendar(resource.data, {
      defaultTimeZone: calendar.timeZone ?? "UTC",
    });
    const self = account ? selfAddresses(account) : new Set<string>();
    return parsed.events.map((event) => ({
      ...event,
      raw: resource.data,
      remoteId: resource.href,
      etag: resource.etag,
      parentRemoteId: event.recurrenceId === null ? null : resource.href,
      attendees: event.attendees.map((attendee) => ({
        ...attendee,
        self: self.has(attendee.email.toLowerCase()),
      })),
    }));
  }

  /** リソースを予定の行にする。iCalendar を読めなければ null (ログに残す)。 */
  function safeRemoteEvents(
    ctx: ProviderContext,
    resource: CaldavResource,
    calendar: CalendarRow,
  ): RemoteEvent[] | null {
    try {
      return toRemoteEvents(resource, calendar, ctx.account);
    } catch (error) {
      if (!(error instanceof ICalendarError)) throw error;
      ctx.log(`予定 ${resource.href} の iCalendar を読めないので飛ばします`);
      return null;
    }
  }

  function absolute(calendar: CalendarRow, href: string): string {
    return new URL(href, collectionUrlOf(calendar)).toString();
  }

  /** 書いたあとの相手側の姿。ETag が返らなければ (サーバーが内容を変えた) 取り直す。 */
  async function afterWrite(
    ctx: ProviderContext,
    client: CaldavClient,
    calendar: CalendarRow,
    href: string,
    data: string,
    etag: string | null,
  ): Promise<WriteResult> {
    if (etag) {
      return {
        status: "ok",
        events: toRemoteEvents({ href, etag, data }, calendar, ctx.account),
      };
    }
    const fetched = await client.get(absolute(calendar, href));
    if (!fetched) return { status: "gone" };
    return {
      status: "ok",
      events: toRemoteEvents({ ...fetched, href }, calendar, ctx.account),
    };
  }

  /** 412 のとき、リソースが消えたのか (gone)、先に変わったのか (conflict) を確かめる。 */
  async function conflictOrGone(
    client: CaldavClient,
    calendar: CalendarRow,
    href: string,
  ): Promise<WriteResult> {
    const current = await client.get(absolute(calendar, href));
    return current ? { status: "conflict" } : { status: "gone" };
  }

  /** PUT してから WriteResult にする。 */
  async function putResource(
    ctx: ProviderContext,
    client: CaldavClient,
    calendar: CalendarRow,
    href: string,
    data: string,
    ifMatch: string | null,
  ): Promise<WriteResult> {
    const result = await client.put(absolute(calendar, href), data, {
      ifMatch: ifMatch ?? "*",
    });
    switch (result.status) {
      case "ok":
        return afterWrite(ctx, client, calendar, href, data, result.etag);
      case "precondition_failed":
        return conflictOrGone(client, calendar, href);
      case "not_found":
        return { status: "gone" };
      case "rejected":
        return { status: "rejected", reason: result.reason };
    }
  }

  function writeOptions(ctx: ProviderContext, calendar: CalendarRow) {
    const email = ctx.account.email.includes("@") ? ctx.account.email : null;
    return {
      defaultTimeZone: calendar.timeZone ?? "UTC",
      alarmEmail: email,
      // 参加者のいる予定に ORGANIZER が無ければ、このアカウントを主催者として書く。
      organizer: email ? { email, name: ctx.account.displayName } : null,
      now: now(),
    };
  }

  /** 差分の取り方を決め、取るべき href を並べる (syncEvents の最初のページ)。 */
  async function plan(
    client: CaldavClient,
    calendar: CalendarRow,
    cursor: Parameters<CalendarProvider["syncEvents"]>[2],
  ): Promise<PageState & { deleted: string[] }> {
    const url = collectionUrlOf(calendar);
    const state = (calendar.providerState ?? {}) as CaldavCalendarState;
    const syncSupported = state.syncCollection === true;
    const token = cursor.syncToken;

    if (token === null) {
      // 全件。ETag が同じでも取り直す (土台が行の etag を外して取り直しを求めることがあるため)。
      if (syncSupported) {
        try {
          const result = await client.syncCollection(url, null);
          return {
            fetch: result.changed.map((entry) => entry.href),
            deleted: [],
            full: true,
            token: result.syncToken ? `sync:${result.syncToken}` : null,
            ctag: null,
          };
        } catch (error) {
          if (!(error instanceof CaldavHttpError)) throw error;
          // sync-collection を断られたら、ETag の一覧で取る。
        }
      }
      const collection = await client.getCollectionState(url);
      const list = await client.listEtags(url);
      return {
        fetch: list.map((entry) => entry.href),
        deleted: [],
        full: true,
        token: `ctag:${collection.ctag ?? ""}`,
        ctag: collection.ctag,
      };
    }

    if (token.startsWith("sync:") && syncSupported) {
      try {
        const result = await client.syncCollection(url, token.slice(5));
        const known = await cursor.knownEtags();
        return {
          fetch: changedHrefs(result.changed, known),
          deleted: result.removed.filter((href) => known.has(href)),
          full: false,
          token: result.syncToken ? `sync:${result.syncToken}` : token,
          ctag: null,
        };
      } catch (error) {
        if (!(error instanceof CaldavSyncTokenError)) throw error;
        // 同期の位置が無効になった。下の ETag の比較で取り直す。
      }
    }

    // getctag と ETag の比較。getctag が前回と同じなら何も取らない。
    const collection = await client.getCollectionState(url);
    const nextToken =
      syncSupported && collection.syncToken
        ? `sync:${collection.syncToken}`
        : `ctag:${collection.ctag ?? ""}`;
    if (
      token.startsWith("ctag:") &&
      collection.ctag !== null &&
      token === `ctag:${collection.ctag}`
    ) {
      return {
        fetch: [],
        deleted: [],
        full: false,
        token,
        ctag: collection.ctag,
      };
    }
    const list = await client.listEtags(url);
    const known = await cursor.knownEtags();
    const listed = new Set(list.map((entry) => entry.href));
    return {
      fetch: changedHrefs(list, known),
      deleted: [...known.keys()].filter((href) => !listed.has(href)),
      full: false,
      token: nextToken,
      ctag: collection.ctag,
    };
  }

  return {
    source: "caldav",
    defaultPollSeconds: deps.defaultPollSeconds ?? 300,

    listCalendars(ctx) {
      return guarded(async () => {
        const client = clientOf(ctx);
        const found = await client.discover(startUrlOf(ctx.account));
        const collections = found.calendarUrl
          ? [await client.getCalendar(found.calendarUrl)]
          : (
              await Promise.all(
                found.homeUrls.map((home) => client.listCalendars(home)),
              )
            ).flat();
        const seen = new Set<string>();
        const result: RemoteCalendar[] = [];
        for (const collection of collections) {
          if (!collection?.supportsEvents || seen.has(collection.url)) continue;
          seen.add(collection.url);
          result.push({
            remoteId: collection.url,
            name: collection.displayName ?? lastSegment(collection.url),
            description: collection.description,
            color: collection.color,
            timeZone: isTimeZone(collection.timeZone)
              ? collection.timeZone
              : null,
            readOnly: collection.readOnly,
            url: collection.url,
            defaultReminders: null,
            kind: "normal",
            providerState: {
              syncCollection: collection.supportsSyncCollection,
            } satisfies CaldavCalendarState,
          });
        }
        return result;
      });
    },

    syncEvents(ctx, calendar, cursor) {
      return guarded(async (): Promise<EventDelta> => {
        const client = clientOf(ctx);
        let state: PageState;
        let deleted: string[] = [];
        if (cursor.pageCursor) {
          state = JSON.parse(cursor.pageCursor) as PageState;
        } else {
          const planned = await plan(client, calendar, cursor);
          deleted = planned.deleted;
          state = planned;
        }
        const batch = state.fetch.slice(0, PAGE_SIZE);
        const rest = state.fetch.slice(PAGE_SIZE);
        const resources = await client.multiget(
          collectionUrlOf(calendar),
          batch,
        );
        const got = new Set(resources.map((resource) => resource.href));
        // 一覧と取得の間に消えたリソース。全件なら、出てこなければ土台が消す。
        if (!state.full) {
          deleted.push(...batch.filter((href) => !got.has(href)));
        }
        const events: RemoteEvent[] = [];
        // 読めなかったリソースは、全件同期で土台に消させない (相手側にはあるため)。
        const unreadable: string[] = [];
        for (const resource of resources) {
          const rows = safeRemoteEvents(ctx, resource, calendar);
          if (rows) events.push(...rows);
          else unreadable.push(resource.href);
        }
        const last = rest.length === 0;
        return {
          events,
          deletedRemoteIds: deleted,
          ...(unreadable.length > 0 ? { keptRemoteIds: unreadable } : {}),
          nextPageCursor: last
            ? null
            : JSON.stringify({ ...state, fetch: rest } satisfies PageState),
          nextSyncToken: last ? state.token : null,
          ...(last && state.ctag !== null ? { nextEtag: state.ctag } : {}),
          full: state.full,
        };
      });
    },

    getEvent(ctx, calendar, ref) {
      return guarded(async () => {
        const client = clientOf(ctx);
        const fetched = await client.get(absolute(calendar, ref.remoteId));
        if (!fetched) return null;
        return (
          safeRemoteEvents(ctx, { ...fetched, href: ref.remoteId }, calendar) ??
          []
        );
      });
    },

    parseRaw(raw, calendar) {
      return toRemoteEvents(
        { href: "", etag: null, data: raw },
        calendar,
        null,
      );
    },

    createEvent(ctx, calendar, write) {
      return guarded(async (): Promise<WriteResult> => {
        const client = clientOf(ctx);
        const collection = new URL(collectionUrlOf(calendar));
        const href = `${collection.pathname.replace(/\/?$/, "/")}${encodeURIComponent(write.event.id)}.ics`;
        const entries: ICalWriteEntry[] = [
          { event: toData(write.event), fields: "all" },
          ...write.exceptions.map((exception) => ({
            event: { ...toData(exception), uid: write.event.uid },
            fields: "all" as const,
          })),
        ];
        const data = writeICalendar({
          base: write.event.raw,
          entries,
          ...writeOptions(ctx, calendar),
        });
        const result = await client.put(absolute(calendar, href), data, {
          ifNoneMatch: "*",
        });
        switch (result.status) {
          case "ok":
            return afterWrite(ctx, client, calendar, href, data, result.etag);
          case "precondition_failed": {
            // 前回の実行で作成まで済んでいた (events.id から決まる href に既にある)。
            const existing = await client.get(absolute(calendar, href));
            if (!existing) return { status: "conflict", remoteId: href };
            return {
              status: "ok",
              events: toRemoteEvents(
                { ...existing, href },
                calendar,
                ctx.account,
              ),
            };
          }
          case "not_found":
            return {
              status: "rejected",
              reason: "カレンダーが CalDAV サーバーに見つかりません。",
            };
          case "rejected":
            return { status: "rejected", reason: result.reason };
        }
      });
    },

    updateEvent(ctx, calendar, ref, write) {
      return guarded(() => updateResource(ctx, calendar, ref, write));
    },

    deleteEvent(ctx, calendar, ref) {
      return guarded(async (): Promise<WriteResult> => {
        const client = clientOf(ctx);
        if (ref.recurrenceId === null) {
          const result = await client.delete(
            absolute(calendar, ref.remoteId),
            ref.etag,
          );
          switch (result.status) {
            case "ok":
              return { status: "ok", events: [] };
            case "not_found":
              return { status: "gone" };
            case "precondition_failed":
              return conflictOrGone(client, calendar, ref.remoteId);
            case "rejected":
              return { status: "rejected", reason: result.reason };
          }
        }
        // 回の削除: 原本に EXDATE を足し、その回の例外を取り除いて書き直す。
        const current = await client.get(absolute(calendar, ref.remoteId));
        if (!current) return { status: "gone" };
        if (ref.etag && current.etag && ref.etag !== current.etag) {
          return { status: "conflict" };
        }
        const rows = toRemoteEvents(
          { ...current, href: ref.remoteId },
          calendar,
          ctx.account,
        );
        const master = rows.find((row) => row.recurrenceId === null);
        const target = normalizeRecurrenceId(ref.recurrenceId);
        const others = rows.filter(
          (row) =>
            row.recurrenceId !== null &&
            normalizeRecurrenceId(row.recurrenceId) !== target,
        );
        if (!master && others.length === 0) {
          // 例外だけのリソース (1 回だけ招待された予定など) の最後の回は、リソースごと消す。
          const removed = await client.delete(
            absolute(calendar, ref.remoteId),
            current.etag,
          );
          if (removed.status === "ok" || removed.status === "not_found") {
            return { status: "ok", events: [] };
          }
          return removed.status === "precondition_failed"
            ? { status: "conflict" }
            : { status: "rejected", reason: removed.reason };
        }
        const data = writeICalendar({
          base: current.data,
          entries: master
            ? [
                {
                  event: {
                    ...(master as ICalEventData),
                    exdates: [...new Set([...(master.exdates ?? []), target])],
                  },
                  fields: ["recurrence"],
                },
              ]
            : [],
          remove: [target],
          ...writeOptions(ctx, calendar),
        });
        return putResource(
          ctx,
          client,
          calendar,
          ref.remoteId,
          data,
          current.etag,
        );
      });
    },

    respond(ctx, calendar, ref, response) {
      return guarded(async (): Promise<WriteResult> => {
        const client = clientOf(ctx);
        const current = await client.get(absolute(calendar, ref.remoteId));
        if (!current) return { status: "gone" };
        if (ref.etag && current.etag && ref.etag !== current.etag) {
          return { status: "conflict" };
        }
        const rows = toRemoteEvents(
          { ...current, href: ref.remoteId },
          calendar,
          ctx.account,
        );
        const target =
          ref.recurrenceId === null
            ? null
            : normalizeRecurrenceId(ref.recurrenceId);
        const row = rows.find(
          (entry) =>
            (entry.recurrenceId === null
              ? null
              : normalizeRecurrenceId(entry.recurrenceId)) === target,
        );
        if (!row) {
          return {
            status: "rejected",
            reason: "返事をする回が見つかりません。",
          };
        }
        if (!row.attendees.some((attendee) => attendee.self)) {
          return {
            status: "rejected",
            reason: "この予定の参加者に自分が入っていません。",
          };
        }
        const data = writeICalendar({
          base: current.data,
          entries: [
            {
              event: {
                ...(row as ICalEventData),
                attendees: row.attendees.map((attendee) =>
                  attendee.self
                    ? { ...attendee, status: response.status }
                    : attendee,
                ),
              },
              fields: ["attendees"],
            },
          ],
          ...writeOptions(ctx, calendar),
        });
        return putResource(
          ctx,
          client,
          calendar,
          ref.remoteId,
          data,
          current.etag,
        );
      });
    },
  };

  /** 予定の書き換え。原本なら変えた項目を、例外ならその回の VEVENT を差し替えて、リソース全体を PUT する。 */
  async function updateResource(
    ctx: ProviderContext,
    calendar: CalendarRow,
    ref: RemoteEventRef,
    write: EventWrite,
  ): Promise<WriteResult> {
    const client = clientOf(ctx);
    const href = ref.remoteId;
    const newException = write.event.remoteId === null && write.master !== null;
    let base = write.event.raw ?? write.master?.raw ?? null;
    // まだ相手側に無い回は、原本の ETag で書く (原本を黙って上書きしないため)。
    let ifMatch =
      ref.etag ?? (newException ? (write.master?.etag ?? null) : null);
    if (base === null || ifMatch === null) {
      // ETag が分からなければ、手元の raw は古いかもしれないので、いまの内容と ETag を基に書く
      // (If-Match: * で古い内容を基に上書きしないため)。
      const current = await client.get(absolute(calendar, href));
      if (!current) return { status: "gone" };
      base = current.data;
      // ETag が分かっているなら、それで書く (先に変わっていれば 412 で競合にする)。
      ifMatch = ifMatch ?? current.etag;
    }
    const event = toData(write.event);
    const remove: string[] = [];
    if (write.event.recurrenceId === null) {
      // EXDATE に入った回の例外は、リソースから取り除く (回の削除)。
      const excluded = new Set(
        (event.exdates ?? []).map(normalizeRecurrenceId),
      );
      try {
        for (const row of parseICalendar(base, {
          defaultTimeZone: calendar.timeZone ?? "UTC",
        }).events) {
          if (
            row.recurrenceId &&
            excluded.has(normalizeRecurrenceId(row.recurrenceId))
          ) {
            remove.push(row.recurrenceId);
          }
        }
      } catch (error) {
        if (!(error instanceof ICalendarError)) throw error;
      }
    } else if (write.master) {
      event.uid = write.master.uid;
    }
    const data = writeICalendar({
      base,
      entries: [{ event, fields: newException ? "all" : write.fields }],
      remove,
      ...writeOptions(ctx, calendar),
    });
    return putResource(ctx, client, calendar, href, data, ifMatch);
  }
}

/** ETag が DB と違う (または DB に無い) href。 */
function changedHrefs(
  list: readonly CaldavResourceRef[],
  known: Map<string, string | null>,
): string[] {
  return list
    .filter(
      (entry) => entry.etag === null || known.get(entry.href) !== entry.etag,
    )
    .map((entry) => entry.href);
}
