import {
  type GraphEvent,
  graphEventBody,
  graphOriginalStartToRecurrenceId,
  graphTimeZoneToIana,
  type MicrosoftEventWriteInput,
  type MicrosoftParsedEvent,
  normalizeRecurrenceId,
  parseGraphEvent,
  UnsupportedRecurrenceError,
} from "@orbit/core";
import {
  CalendarAuthError,
  type CalendarProvider,
  type CalendarProviderDeps,
  type CalendarRow,
  type EventDelta,
  type EventSnapshot,
  type EventWrite,
  type ProviderContext,
  type RemoteCalendar,
  type RemoteEvent,
  type WriteResult,
} from "../provider.js";
import {
  CalendarGraph,
  GraphError,
  type GraphPage,
  writeFailure,
} from "./graph.js";
import { maintainMicrosoftPush, stopMicrosoftPush } from "./push.js";
import {
  decodePageCursor,
  decodeSyncToken,
  encodePageCursor,
  encodeSyncToken,
  freshSyncState,
  type PageState,
  windowIsStale,
} from "./sync-state.js";

/**
 * Microsoft Graph の予定のプロバイダ (担当 5)。
 *
 * 差分の取り方: /me/calendars/{id}/calendarView/delta を使う。
 * - v1.0 で使える差分は calendarView/delta だけ (events/delta は beta)。期間の指定が必須で、
 *   繰り返しは回 (occurrence) と例外 (exception) に展開されて返り、原本 (seriesMaster) は返らない。
 * - 例外は seriesMasterId と originalStart を持つので、そのまま「例外の行」にできる。
 * - 原本は、回か例外が届いたときに /me/events/{seriesMasterId} で取り直す
 *   (patternedRecurrence と cancelledOccurrences を得る)。回 (occurrence) そのものは保存しない。
 * - 期間は過去 1 年〜未来 2 年。差分の位置 (deltaLink) は作った時の期間のままなので、
 *   30 日ずれたら全件を取り直す。期間の外の単発の予定は取り込まれない (設計資料の制限)。
 * - 原本が消えても原本の ID は差分に出てこない (回の @removed だけが届く)。そこで、
 *   見覚えのない ID の @removed が届いたら、知っている原本をすべて取り直して確かめる。
 *   知っている原本と例外の ID は、同期の位置 (syncToken) の中に持つ。
 */
export function createMicrosoftProvider(
  deps: CalendarProviderDeps & { now?: () => Date } = {},
): CalendarProvider {
  const now = () => deps.now?.() ?? new Date();
  /** cancelledOccurrences の $select が拒まれたら、以後は付けない。 */
  let selectSupported = true;

  const parse = (
    ctx: ProviderContext | null,
    json: GraphEvent,
  ): RemoteEvent | null => {
    const parsed = parseGraphEvent(json, {
      selfEmail: ctx?.account.email ?? null,
    });
    return parsed ? toRemote(parsed) : null;
  };

  /** 原本を取る (cancelledOccurrences 付き)。無ければ null。 */
  const fetchMaster = async (
    graph: CalendarGraph,
    id: string,
  ): Promise<GraphEvent | null> => {
    const path = `/me/events/${encodeURIComponent(id)}`;
    try {
      if (selectSupported) {
        try {
          return await graph.get<GraphEvent>(
            `${path}?$select=${MASTER_SELECT}`,
          );
        } catch (error) {
          if (!(error instanceof GraphError && error.status === 400)) {
            throw error;
          }
          selectSupported = false;
        }
      }
      return await graph.get<GraphEvent>(path);
    } catch (error) {
      if (error instanceof GraphError && isGone(error)) return null;
      throw error;
    }
  };

  /** 1 件を取る。原本なら cancelledOccurrences 付きで取り直す。無ければ null。 */
  const fetchOne = async (
    graph: CalendarGraph,
    id: string,
  ): Promise<GraphEvent | null> => {
    let event: GraphEvent;
    try {
      event = await graph.get<GraphEvent>(
        `/me/events/${encodeURIComponent(id)}`,
      );
    } catch (error) {
      if (error instanceof GraphError && isGone(error)) return null;
      throw error;
    }
    if (event?.type === "seriesMaster") return fetchMaster(graph, id);
    return event ?? null;
  };

  /** 原本の例外 (同期の期間の中) を集める。 */
  const listExceptions = async (
    graph: CalendarGraph,
    masterId: string,
  ): Promise<GraphEvent[]> => {
    const { start, end } = freshSyncState("x", now());
    const instances = await graph.getAll<GraphEvent>(
      `/me/events/${encodeURIComponent(masterId)}/instances?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`,
    );
    return instances.filter((item) => item.type === "exception");
  };

  /** 原本のある回 (recurrenceId) の、いまの姿 (回か例外) を探す。 */
  const findInstance = async (
    graph: CalendarGraph,
    masterId: string,
    recurrenceId: string,
  ): Promise<GraphEvent | null> => {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(recurrenceId);
    const center = Date.parse(
      allDay ? `${recurrenceId}T00:00:00Z` : recurrenceId,
    );
    if (Number.isNaN(center)) return null;
    const day = 24 * 60 * 60_000;
    const from = new Date(center - 2 * day).toISOString();
    const to = new Date(center + 2 * day).toISOString();
    const instances = await graph.getAll<GraphEvent>(
      `/me/events/${encodeURIComponent(masterId)}/instances?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}`,
      5,
    );
    const wanted = normalizeRecurrenceId(recurrenceId);
    return (
      instances.find((item) => {
        if (!item.originalStart) return false;
        const zone = graphTimeZoneToIana(item.originalStartTimeZone);
        return (
          graphOriginalStartToRecurrenceId(item.originalStart, allDay, zone) ===
          wanted
        );
      }) ?? null
    );
  };

  /** 回を取り消す (その回を消す)。回が無ければ何もしない。 */
  const cancelInstance = async (
    graph: CalendarGraph,
    masterId: string,
    recurrenceId: string,
  ) => {
    const instance = await findInstance(graph, masterId, recurrenceId);
    if (!instance?.id) return;
    try {
      await graph.request(
        "DELETE",
        `/me/events/${encodeURIComponent(instance.id)}`,
      );
    } catch (error) {
      if (!(error instanceof GraphError && isGone(error))) throw error;
    }
  };

  /** 書いたあとの姿 (原本なら原本だけ、例外ならその例外) を返す。 */
  const afterWrite = async (
    ctx: ProviderContext,
    graph: CalendarGraph,
    id: string,
    extra: GraphEvent[] = [],
  ): Promise<WriteResult> => {
    const event = await fetchOne(graph, id);
    if (!event) return { status: "gone" };
    const list = [event, ...extra]
      .map((item) => parse(ctx, item))
      .filter((item): item is RemoteEvent => item !== null);
    return { status: "ok", events: list };
  };

  const bodyFor = (
    write: EventWrite,
    event: EventSnapshot,
    fields: readonly string[],
    calendar: CalendarRow,
    exception: boolean,
  ) =>
    graphEventBody(writeInput(event), fields, {
      raw: rawJson(event.raw),
      fallbackTimeZone:
        calendar.timeZone ?? write.master?.startTimeZone ?? null,
      exception,
    });

  /** 例外をまだ相手側に無い回に作る (回を探して、その回を書き換える)。 */
  const writeNewException = async (
    ctx: ProviderContext,
    graph: CalendarGraph,
    calendar: CalendarRow,
    masterId: string,
    write: EventWrite,
    event: EventSnapshot,
    fields: readonly string[],
  ): Promise<WriteResult> => {
    if (event.recurrenceId === null) {
      return { status: "rejected", reason: "回の指定がありません。" };
    }
    const instance = await findInstance(graph, masterId, event.recurrenceId);
    if (!instance?.id) return { status: "gone" };
    const body = bodyFor(write, event, fields, calendar, true);
    try {
      if (Object.keys(body).length > 0) {
        await graph.request(
          "PATCH",
          `/me/events/${encodeURIComponent(instance.id)}`,
          { body },
        );
      }
    } catch (error) {
      return writeFailure(error);
    }
    return afterWrite(ctx, graph, instance.id);
  };

  const provider: CalendarProvider = {
    source: "microsoft",
    defaultPollSeconds: deps.defaultPollSeconds ?? 900,

    async listCalendars(ctx) {
      const graph = new CalendarGraph(ctx);
      let items: GraphCalendar[];
      try {
        items = await graph.getAll<GraphCalendar>("/me/calendars");
      } catch (error) {
        if (error instanceof GraphError && error.status === 403) {
          throw new CalendarAuthError(
            "Microsoft のカレンダーを読む権限がありません。カレンダーの権限を許可してください。",
            { consentRequired: true, cause: error },
          );
        }
        throw error;
      }
      return items
        .filter((item) => typeof item.id === "string")
        .map((item): RemoteCalendar => {
          const birthdays = BIRTHDAY_NAMES.test((item.name ?? "").trim());
          return {
            remoteId: item.id as string,
            name: item.name ?? "",
            description: null,
            color: calendarColor(item),
            timeZone: null,
            readOnly: item.canEdit === false,
            url: null,
            defaultReminders: null,
            kind: birthdays ? "birthdays" : "normal",
            providerState: { isDefault: item.isDefaultCalendar === true },
          };
        });
    },

    async syncEvents(ctx, calendar, cursor) {
      const graph = new CalendarGraph(ctx);
      const at = now();
      let state: PageState;
      const fromToken = cursor.pageCursor === null;
      if (cursor.pageCursor !== null) {
        const decoded = decodePageCursor(cursor.pageCursor);
        if (!decoded) throw new Error("差分の続きの位置が読めません。");
        state = decoded;
      } else {
        const saved = decodeSyncToken(cursor.syncToken);
        state =
          saved && !windowIsStale(saved, at)
            ? { ...saved, full: false, fetched: [], refreshAll: false }
            : { ...freshSyncState(calendar.remoteId ?? "", at) };
      }

      let page: GraphPage<GraphEvent>;
      try {
        page = await graph.get<GraphPage<GraphEvent>>(state.link);
      } catch (error) {
        if (
          error instanceof GraphError &&
          error.syncStateInvalid &&
          fromToken &&
          !state.full
        ) {
          // 差分の位置が無効になった。全件を取り直す。
          state = freshSyncState(calendar.remoteId ?? "", at);
          page = await graph.get<GraphPage<GraphEvent>>(state.link);
        } else {
          throw error;
        }
      }

      const masters = new Set(state.masters);
      const exceptions = new Map(Object.entries(state.exceptions));
      const fetched = new Set(state.fetched);
      const need = new Set<string>();
      const events: RemoteEvent[] = [];
      const deleted: string[] = [];
      let known: Map<string, unknown> | null = null;

      for (const item of page?.value ?? []) {
        if (!item?.id) continue;
        if (item["@removed"]) {
          deleted.push(item.id);
          const master = exceptions.get(item.id);
          if (master !== undefined) {
            // 例外が消えた (回の取り消しを含む)。原本の cancelledOccurrences が変わる。
            exceptions.delete(item.id);
            need.add(master);
          } else if (masters.has(item.id)) {
            masters.delete(item.id);
          } else if (!state.full) {
            known ??= await cursor.knownEvents();
            // 見覚えのない ID は、回の取り消しか、原本ごとの削除。原本を確かめ直す。
            if (!known.has(item.id)) state.refreshAll = true;
          }
          continue;
        }
        switch (item.type) {
          case "occurrence":
            // 回そのものは保存しない。原本を (この同期で 1 回だけ) 取り直す。
            if (item.seriesMasterId) need.add(item.seriesMasterId);
            break;
          case "exception": {
            const remote = parse(ctx, item);
            if (remote) events.push(remote);
            if (item.seriesMasterId) {
              exceptions.set(item.id, item.seriesMasterId);
              if (!masters.has(item.seriesMasterId)) {
                need.add(item.seriesMasterId);
              }
            }
            break;
          }
          case "seriesMaster": {
            const master = await fetchMaster(graph, item.id);
            const remote = master && parse(ctx, master);
            if (remote) events.push(remote);
            masters.add(item.id);
            fetched.add(item.id);
            break;
          }
          default: {
            const remote = parse(ctx, item);
            if (remote) events.push(remote);
          }
        }
      }

      const nextLink = page?.["@odata.nextLink"] ?? null;
      const deltaLink = page?.["@odata.deltaLink"] ?? null;
      if (!nextLink && !deltaLink) {
        throw new Error(
          "Microsoft Graph の差分の応答に続きの位置がありません。",
        );
      }
      if (!nextLink && state.refreshAll) {
        for (const id of masters) need.add(id);
      }
      for (const id of need) {
        if (fetched.has(id)) continue;
        fetched.add(id);
        const master = await fetchMaster(graph, id);
        if (!master) {
          // 原本ごと消えた。
          masters.delete(id);
          for (const [exceptionId, parent] of exceptions) {
            if (parent === id) exceptions.delete(exceptionId);
          }
          if (!state.full) deleted.push(id);
          continue;
        }
        const remote = parse(ctx, master);
        if (remote) events.push(remote);
        masters.add(id);
      }

      const next: PageState = {
        ...state,
        masters: [...masters],
        exceptions: Object.fromEntries(exceptions),
        fetched: [...fetched],
      };
      const delta: EventDelta = {
        events,
        deletedRemoteIds: [...new Set(deleted)],
        nextPageCursor: nextLink
          ? encodePageCursor({ ...next, link: nextLink })
          : null,
        nextSyncToken: deltaLink
          ? encodeSyncToken({ ...next, link: deltaLink })
          : null,
        full: state.full,
      };
      return delta;
    },

    async getEvent(ctx, _calendar, ref) {
      const graph = new CalendarGraph(ctx);
      const event = await fetchOne(graph, ref.remoteId);
      if (!event) return null;
      const extra =
        event.type === "seriesMaster" && event.id
          ? await listExceptions(graph, event.id)
          : [];
      return [event, ...extra]
        .map((item) => parse(ctx, item))
        .filter((item): item is RemoteEvent => item !== null);
    },

    parseRaw(raw, _calendar) {
      let json: GraphEvent;
      try {
        json = JSON.parse(raw) as GraphEvent;
      } catch {
        return [];
      }
      const remote = parse(null, json);
      return remote ? [remote] : [];
    },

    async createEvent(ctx, calendar, write) {
      const graph = new CalendarGraph(ctx);
      const event = write.event;
      if (event.recurrenceId !== null) {
        return {
          status: "rejected",
          reason: "繰り返しの回だけを新しく作ることはできません。",
        };
      }
      let body: Record<string, unknown>;
      try {
        body = bodyFor(write, event, ALL_FIELDS, calendar, false);
      } catch (error) {
        return rejectedFor(error);
      }
      // transactionId: 同じ値の作成をやり直しても、予定は 1 つにする (Graph が重複を防ぐ)。
      body.transactionId = event.id;
      let created: GraphEvent | undefined;
      try {
        const response = await graph.request<GraphEvent>(
          "POST",
          `/me/calendars/${encodeURIComponent(calendar.remoteId ?? "")}/events`,
          { body },
        );
        created = response.body;
      } catch (error) {
        if (!(error instanceof GraphError && error.status === 409)) {
          return writeFailure(error);
        }
        // 推測: 重複を 409 で返す場合に備え、transactionId で探す。
        created = await findByTransactionId(graph, calendar, event.id);
        if (!created) return writeFailure(error);
      }
      if (!created?.id) {
        return {
          status: "rejected",
          reason: "作った予定の ID が返りませんでした。",
        };
      }
      const id = created.id;
      // 作る前に決まっていた取り消しの回と例外を反映する (作り直しのとき)。
      const extra: GraphEvent[] = [];
      if (event.rrule) {
        for (const exdate of event.exdates ?? []) {
          await cancelInstance(graph, id, exdate).catch((error: unknown) => {
            ctx.log(
              `回 ${exdate} を取り消せませんでした: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        for (const exception of write.exceptions) {
          const result = await writeNewException(
            ctx,
            graph,
            calendar,
            id,
            { ...write, event: exception, master: event },
            exception,
            ALL_FIELDS,
          ).catch((error: unknown) => {
            ctx.log(
              `例外 ${exception.recurrenceId} を作れませんでした: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          });
          if (result?.status === "ok") {
            for (const remote of result.events) {
              extra.push(JSON.parse(remote.raw) as GraphEvent);
            }
          }
        }
      }
      return afterWrite(ctx, graph, id, extra);
    },

    async updateEvent(ctx, calendar, ref, write) {
      const graph = new CalendarGraph(ctx);
      const event = write.event;
      const exception = event.recurrenceId !== null;
      if (exception && event.remoteId === null) {
        // まだ相手側に無い回の例外。ref は原本を指す。
        return writeNewException(
          ctx,
          graph,
          calendar,
          ref.parentRemoteId ?? ref.remoteId,
          write,
          event,
          write.fields.filter((field) => field !== "recurrence"),
        );
      }

      let fields: string[] = [...write.fields];
      let added: string[] = [];
      if (exception) {
        fields = fields.filter((field) => field !== "recurrence");
      } else if (fields.includes("recurrence")) {
        // 回の削除は exdates の差で届く。Graph では、その回を消して取り消す。
        const previous = previousOf(event.raw);
        const before = new Set(previous?.exdates ?? []);
        const after = new Set(event.exdates ?? []);
        added = [...after].filter((value) => !before.has(value));
        const removed = [...before].filter((value) => !after.has(value));
        if (removed.length > 0) {
          ctx.log(
            `予定 ${ref.remoteId} の取り消した回 (${removed.join(", ")}) は、Microsoft のカレンダーでは戻せません`,
          );
        }
        // 規則そのものが変わっていなければ、recurrence は送らない (送ると例外が消えるため)。
        if (previous && (previous.rrule ?? null) === (event.rrule ?? null)) {
          fields = fields.filter((field) => field !== "recurrence");
        }
      }

      let body: Record<string, unknown>;
      try {
        body = bodyFor(write, event, fields, calendar, exception);
      } catch (error) {
        return rejectedFor(error);
      }
      if (!exception && !fields.includes("recurrence") && body.recurrence) {
        // 時刻だけの変更でも、開始日が変わらなければ recurrence は送らない (例外を残すため)。
        const before = rawJson(event.raw)?.recurrence?.range?.startDate;
        const after = (body.recurrence as { range?: { startDate?: string } })
          .range?.startDate;
        if (before && before.slice(0, 10) === after) delete body.recurrence;
      }
      if (Object.keys(body).length > 0) {
        try {
          await graph.request(
            "PATCH",
            `/me/events/${encodeURIComponent(ref.remoteId)}`,
            { body, ifMatch: ref.etag },
          );
        } catch (error) {
          return writeFailure(error);
        }
      } else if (added.length > 0 && ref.etag) {
        // 回の取り消しだけのときも、相手側が先に変わっていないかを確かめる。
        const current = await fetchOne(graph, ref.remoteId);
        if (!current) return { status: "gone" };
        if ((current["@odata.etag"] ?? null) !== ref.etag) {
          return { status: "conflict" };
        }
      }
      for (const recurrenceId of added) {
        await cancelInstance(graph, ref.remoteId, recurrenceId);
      }
      return afterWrite(ctx, graph, ref.remoteId);
    },

    async deleteEvent(ctx, _calendar, ref) {
      const graph = new CalendarGraph(ctx);
      try {
        await graph.request(
          "DELETE",
          `/me/events/${encodeURIComponent(ref.remoteId)}`,
          { ifMatch: ref.etag },
        );
      } catch (error) {
        return writeFailure(error);
      }
      return { status: "ok", events: [] };
    },

    async respond(ctx, _calendar, ref, response) {
      const graph = new CalendarGraph(ctx);
      const action =
        response.status === "accepted"
          ? "accept"
          : response.status === "tentative"
            ? "tentativelyAccept"
            : "decline";
      try {
        await graph.request(
          "POST",
          `/me/events/${encodeURIComponent(ref.remoteId)}/${action}`,
          { body: { comment: response.comment ?? "", sendResponse: true } },
        );
      } catch (error) {
        return writeFailure(error);
      }
      return afterWrite(ctx, graph, ref.remoteId);
    },

    maintainPush(ctx, rows) {
      return maintainMicrosoftPush(ctx, rows, now);
    },

    stopPush(ctx, calendar) {
      return stopMicrosoftPush(ctx, calendar);
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------

const ALL_FIELDS = [
  "summary",
  "location",
  "description",
  "status",
  "busy",
  "time",
  "recurrence",
  "conferenceUrl",
  "useDefaultReminders",
  "reminders",
  "attendees",
];

/**
 * 原本を取るときの $select。cancelledOccurrences は $select で名指ししないと返らない
 * (推測: v1.0 で使える。拒まれたら $select 無しで取り直す)。
 */
const MASTER_SELECT = [
  "id",
  "createdDateTime",
  "lastModifiedDateTime",
  "changeKey",
  "categories",
  "transactionId",
  "originalStartTimeZone",
  "originalEndTimeZone",
  "iCalUId",
  "reminderMinutesBeforeStart",
  "isReminderOn",
  "subject",
  "body",
  "importance",
  "sensitivity",
  "isAllDay",
  "isCancelled",
  "isOrganizer",
  "responseRequested",
  "seriesMasterId",
  "showAs",
  "type",
  "webLink",
  "onlineMeetingUrl",
  "isOnlineMeeting",
  "onlineMeetingProvider",
  "onlineMeeting",
  "recurrence",
  "responseStatus",
  "start",
  "end",
  "location",
  "locations",
  "attendees",
  "organizer",
  "cancelledOccurrences",
].join(",");

/**
 * 誕生日のカレンダーの名前。Graph のカレンダーには種類の項目が無いので名前で見分ける
 * (推測: Outlook.com では "Birthdays"、日本語の表示では "誕生日")。
 */
const BIRTHDAY_NAMES = /^(birthdays?|birthday calendar|誕生日)$/i;

type GraphCalendar = {
  id?: string;
  name?: string;
  color?: string;
  hexColor?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
};

/** calendar.color (プリセットの名前) のおおよその色。hexColor があればそちらを使う。 */
const PRESET_COLORS: Record<string, string> = {
  lightBlue: "#a6d1f5",
  lightGreen: "#87d28e",
  lightOrange: "#fcab73",
  lightGray: "#c0c0c0",
  lightYellow: "#f4d07a",
  lightTeal: "#9fe2e7",
  lightPink: "#efa5b5",
  lightBrown: "#d8b38c",
  lightRed: "#f69494",
};

function calendarColor(item: GraphCalendar): string | null {
  if (item.hexColor && /^#[0-9a-f]{6}$/i.test(item.hexColor)) {
    return item.hexColor.toLowerCase();
  }
  return (item.color && PRESET_COLORS[item.color]) || null;
}

function isGone(error: GraphError) {
  return error.status === 404 || error.status === 410;
}

function toRemote(parsed: MicrosoftParsedEvent): RemoteEvent {
  const { graphType: _type, uid, ...rest } = parsed;
  return uid === null ? rest : { ...rest, uid };
}

function rawJson(raw: string | null): GraphEvent | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GraphEvent;
  } catch {
    return null;
  }
}

function previousOf(raw: string | null): MicrosoftParsedEvent | null {
  const json = rawJson(raw);
  return json ? parseGraphEvent(json) : null;
}

function writeInput(event: EventSnapshot): MicrosoftEventWriteInput {
  return {
    summary: event.summary,
    location: event.location,
    description: event.description,
    status: event.status,
    busy: event.busy,
    allDay: event.allDay,
    startAt: event.startAt,
    endAt: event.endAt,
    startDate: event.startDate,
    endDate: event.endDate,
    startTimeZone: event.startTimeZone,
    endTimeZone: event.endTimeZone,
    rrule: event.rrule,
    rdates: event.rdates,
    useDefaultReminders: event.useDefaultReminders,
    reminders: event.reminders,
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      name: attendee.name,
      role: attendee.role,
    })),
  };
}

function rejectedFor(error: unknown): WriteResult {
  if (error instanceof UnsupportedRecurrenceError) {
    return { status: "rejected", reason: error.message };
  }
  if (error instanceof Error) {
    return { status: "rejected", reason: error.message };
  }
  throw error;
}

async function findByTransactionId(
  graph: CalendarGraph,
  calendar: CalendarRow,
  transactionId: string,
): Promise<GraphEvent | undefined> {
  const filter = encodeURIComponent(`transactionId eq '${transactionId}'`);
  const page = await graph.get<GraphPage<GraphEvent>>(
    `/me/calendars/${encodeURIComponent(calendar.remoteId ?? "")}/events?$filter=${filter}&$top=1`,
  );
  return page?.value?.[0];
}
