import type { GoogleCalendarListEntry, GoogleEvent } from "./convert.js";

/**
 * テスト用の偽の Google Calendar API (fetch の差し替え)。公式の資料にある応答の形を真似る。
 * - events.list: syncToken ("s<版>") で差分 (削除は status: cancelled)、知らない値は 410。
 *   全件では削除済みの予定を返さない (取り消した回は返す)。maxResults でページに分ける。
 * - events.insert: id が既にあれば 409 duplicate。iCalUID は "<id>@google.com"。
 * - PATCH / DELETE: If-Match が違えば 412。DELETE は status: cancelled にする (get では返る)。
 * - 回 (instance) は "<原本の ID>_<元の開始>" の ID で、instances の originalStart で引ける。
 * 本番のコードからは使わない。
 */

type Json = Record<string, unknown>;

export type FakeGoogleRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: Json | null;
};

type Injected = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export class FakeGoogleCalendar {
  calendars: GoogleCalendarListEntry[] = [];
  readonly requests: FakeGoogleRequest[] = [];
  readonly watches: Json[] = [];
  readonly stopped: Json[] = [];
  /** 受け付けるアクセストークン。 */
  validTokens = new Set(["test-token"]);
  /** 規則に当たらない回のつもりで、無いことにする回の ID。 */
  missingInstances = new Set<string>();
  private readonly events = new Map<string, Map<string, GoogleEvent>>();
  private readonly changed = new Map<string, Map<string, number>>();
  private version = 0;
  private etagSeq = 0;
  private readonly injected: {
    match: (r: FakeGoogleRequest) => boolean;
    response: Injected;
  }[] = [];

  /** 条件に合う次の要求に、決まった応答を返す (1 回だけ)。 */
  inject(match: (request: FakeGoogleRequest) => boolean, response: Injected) {
    this.injected.push({ match, response });
  }

  private bucket(calendarId: string) {
    let bucket = this.events.get(calendarId);
    if (!bucket) {
      bucket = new Map();
      this.events.set(calendarId, bucket);
    }
    return bucket;
  }

  private stamp(calendarId: string, event: GoogleEvent): GoogleEvent {
    this.version++;
    const next = {
      ...event,
      etag: `"e${++this.etagSeq}"`,
      updated: new Date(
        Date.UTC(2026, 10, 1, 0, 0, this.etagSeq),
      ).toISOString(),
    };
    this.bucket(calendarId).set(next.id, next);
    let changes = this.changed.get(calendarId);
    if (!changes) {
      changes = new Map();
      this.changed.set(calendarId, changes);
    }
    changes.set(next.id, this.version);
    return next;
  }

  /** 相手側に予定を置く。 */
  put(calendarId: string, event: Partial<GoogleEvent> & { id: string }) {
    return this.stamp(calendarId, {
      kind: "calendar#event",
      status: "confirmed",
      eventType: "default",
      ...(event.recurringEventId ? {} : { iCalUID: `${event.id}@google.com` }),
      ...event,
    } as GoogleEvent);
  }

  get(calendarId: string, id: string): GoogleEvent | undefined {
    return this.bucket(calendarId).get(id);
  }

  /** 今の同期の位置。 */
  syncToken() {
    return `s${this.version}`;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : null;
    const request: FakeGoogleRequest = {
      method: init?.method ?? "GET",
      url,
      headers,
      body,
    };
    this.requests.push(request);
    const index = this.injected.findIndex((item) => item.match(request));
    if (index >= 0) {
      const [item] = this.injected.splice(index, 1);
      const response = item?.response as Injected;
      return new Response(
        response.body === undefined ? null : JSON.stringify(response.body),
        {
          status: response.status,
          headers: { "content-type": "application/json", ...response.headers },
        },
      );
    }
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validTokens.has(token)) {
      return error(401, "authError", "Invalid Credentials");
    }
    return this.route(request);
  };

  private route({ method, url, headers, body }: FakeGoogleRequest): Response {
    const path = url.pathname.replace(/^\/calendar\/v3/, "");
    if (method === "GET" && path === "/users/me/calendarList") {
      return json({
        kind: "calendar#calendarList",
        items: this.calendars,
        nextSyncToken: "c1",
      });
    }
    if (method === "POST" && path === "/channels/stop") {
      this.stopped.push(body ?? {});
      return new Response(null, { status: 204 });
    }
    const match =
      /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?(?:\/(instances|watch))?$/.exec(
        path,
      );
    if (!match) return error(404, "notFound", "Not Found");
    const named = decodeURIComponent(match[1] as string);
    // "primary" は、ログインした利用者の primary のカレンダーを指す。
    const calendarId =
      named === "primary"
        ? (this.calendars.find((entry) => entry.primary)?.id ?? named)
        : named;
    const eventId =
      match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    const sub = match[3];
    if (eventId === "watch" && method === "POST") {
      const channel = {
        kind: "api#channel",
        id: body?.id,
        resourceId: `res-${calendarId}`,
        resourceUri: url.toString(),
        token: body?.token,
        expiration: String(Date.UTC(2026, 11, 4)),
      };
      this.watches.push({
        ...body,
        calendarId,
        eventTypes: url.searchParams.getAll("eventTypes"),
      });
      return json(channel);
    }
    if (eventId === undefined) {
      if (method === "GET") return this.list(calendarId, url);
      if (method === "POST") return this.insert(calendarId, body ?? {});
    }
    if (eventId !== undefined && sub === "instances" && method === "GET") {
      return this.instances(
        calendarId,
        eventId,
        url.searchParams.get("originalStart"),
      );
    }
    if (eventId !== undefined && sub === undefined) {
      const existing =
        this.get(calendarId, eventId) ??
        this.virtualInstance(calendarId, eventId);
      if (method === "GET") {
        return existing ? json(existing) : error(404, "notFound", "Not Found");
      }
      if (!existing) return error(404, "notFound", "Not Found");
      const ifMatch = headers.get("if-match");
      if (ifMatch && ifMatch !== existing.etag) {
        return error(412, "conditionNotMet", "Precondition Failed");
      }
      if (method === "DELETE") {
        if (existing.status === "cancelled")
          return error(410, "deleted", "Resource has been deleted");
        this.stamp(calendarId, { ...existing, status: "cancelled" });
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH")
        return json(this.patch(calendarId, existing, body ?? {}));
    }
    return error(400, "badRequest", "Bad Request");
  }

  private patch(
    calendarId: string,
    existing: GoogleEvent,
    body: Json,
  ): GoogleEvent {
    const next: Json = { ...existing };
    for (const [key, value] of Object.entries(body)) {
      if (key === "attendeesOmitted") continue;
      if (key === "attendees" && body.attendeesOmitted === true) {
        const list = [...(existing.attendees ?? [])];
        for (const attendee of value as Json[]) {
          const index = list.findIndex((item) => item.email === attendee.email);
          if (index >= 0) list[index] = { ...list[index], ...attendee };
          else list.push(attendee);
        }
        next.attendees = list;
        continue;
      }
      if (
        (key === "start" || key === "end") &&
        value &&
        typeof value === "object"
      ) {
        next[key] = Object.fromEntries(
          Object.entries({
            ...(existing[key] as Json),
            ...(value as Json),
          }).filter(([, item]) => item !== null),
        );
        continue;
      }
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return this.stamp(calendarId, next as GoogleEvent);
  }

  private insert(calendarId: string, body: Json): Response {
    const id = body.id as string;
    if (!/^[0-9a-v]{5,1024}$/.test(id))
      return error(400, "invalid", "Invalid resource id value.");
    if (this.get(calendarId, id))
      return error(
        409,
        "duplicate",
        "The requested identifier already exists.",
      );
    return json(this.put(calendarId, body as GoogleEvent));
  }

  private list(calendarId: string, url: URL): Response {
    const params = url.searchParams;
    const types = params.getAll("eventTypes");
    const all = [...this.bucket(calendarId).values()].filter(
      (event) =>
        types.length === 0 || types.includes(event.eventType ?? "default"),
    );
    const iCalUID = params.get("iCalUID");
    let items: GoogleEvent[];
    const syncToken = params.get("syncToken");
    if (iCalUID) {
      items = all.filter(
        (event) =>
          event.iCalUID === iCalUID ||
          (event.recurringEventId &&
            this.get(calendarId, event.recurringEventId)?.iCalUID === iCalUID),
      );
      items = items.filter(
        (event) => !(event.status === "cancelled" && !event.recurringEventId),
      );
    } else if (syncToken) {
      const since = /^s(\d+)$/.exec(syncToken);
      if (!since)
        return error(
          410,
          "fullSyncRequired",
          "Sync token is no longer valid, a full sync is required.",
        );
      const changes = this.changed.get(calendarId) ?? new Map();
      items = all.filter(
        (event) => (changes.get(event.id) ?? 0) > Number(since[1]),
      );
    } else {
      items = all.filter((event) => {
        if (event.status !== "cancelled") return true;
        // 取り消した回は返す (原本が残っている間)。
        if (!event.recurringEventId) return false;
        return (
          this.get(calendarId, event.recurringEventId)?.status !== "cancelled"
        );
      });
    }
    const size = Number(params.get("maxResults") ?? 250);
    const offset = Number(
      /^p(\d+)$/.exec(params.get("pageToken") ?? "")?.[1] ?? 0,
    );
    const page = items.slice(offset, offset + size);
    const more = offset + size < items.length;
    return json({
      kind: "calendar#events",
      items: page,
      ...(more
        ? { nextPageToken: `p${offset + size}` }
        : { nextSyncToken: this.syncToken() }),
    });
  }

  /** 元の開始 (UTC か日付) から、回の ID の後ろの部分を作る。 */
  private static suffix(value: string) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value.replaceAll("-", "")
      : new Date(value)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")
          .replaceAll(/[-:]/g, "");
  }

  /** 原本の、まだ例外になっていない回を作る (保存はしない)。 */
  private virtualInstance(
    calendarId: string,
    id: string,
  ): GoogleEvent | undefined {
    const match = /^(.+)_(\d{8})(?:T(\d{6})Z)?$/.exec(id);
    if (!match || this.missingInstances.has(id)) return undefined;
    const master = this.get(calendarId, match[1] as string);
    if (!master?.recurrence || master.status === "cancelled") return undefined;
    const date = match[2] as string;
    const ymd = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const original = match[3]
      ? {
          dateTime: `${ymd}T${match[3].slice(0, 2)}:${match[3].slice(2, 4)}:${match[3].slice(4, 6)}Z`,
          timeZone: master.start?.timeZone,
        }
      : { date: ymd };
    const duration =
      master.start?.dateTime && master.end?.dateTime
        ? Date.parse(master.end.dateTime) - Date.parse(master.start.dateTime)
        : 0;
    const { recurrence: _r, iCalUID, id: masterId, ...rest } = master;
    return {
      ...rest,
      id,
      iCalUID,
      etag: `"i-${id}-${master.etag}"`,
      recurringEventId: masterId,
      originalStartTime: original,
      start: original,
      end: original.dateTime
        ? {
            dateTime: new Date(
              Date.parse(original.dateTime) + duration,
            ).toISOString(),
            timeZone: original.timeZone,
          }
        : { date: ymd },
    } as GoogleEvent;
  }

  private instances(
    calendarId: string,
    masterId: string,
    originalStart: string | null,
  ): Response {
    const master = this.get(calendarId, masterId);
    if (!master) return error(404, "notFound", "Not Found");
    if (!originalStart) return json({ items: [] });
    const id = `${masterId}_${FakeGoogleCalendar.suffix(originalStart)}`;
    const instance =
      this.get(calendarId, id) ?? this.virtualInstance(calendarId, id);
    return json({ kind: "calendar#events", items: instance ? [instance] : [] });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      etag: ((body as Json)?.etag as string) ?? "",
    },
  });
}

export function error(
  status: number,
  reason: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message,
        errors: [{ domain: "global", reason, message }],
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}
