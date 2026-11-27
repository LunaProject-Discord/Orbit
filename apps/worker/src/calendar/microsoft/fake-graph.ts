import type { GraphEvent } from "@orbit/core";

/**
 * テスト用の偽の Microsoft Graph (カレンダーの部分だけ)。fetch の代わりに渡す。
 * 応答の形は公式ドキュメントの例に合わせたつもりだが、細部は推測を含む。
 * - calendarView/delta: 単発、例外、回 (原本ごとに 1 件) を返す。原本は返さない。
 *   消えた予定は @removed で返す。pageSize ごとに nextLink で分ける。
 * - 原本の cancelledOccurrences は $select で名指ししたときだけ返す。
 * - If-Match が @odata.etag と違えば 412。
 */

const BASE = "https://graph.microsoft.com/v1.0";

type Stored = GraphEvent & {
  id: string;
  _calendar: string;
  _version: number;
  /** 原本の回の originalStart (取り消していないもの)。 */
  _occurrences?: string[];
};

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export class FakeGraph {
  calendars: Record<string, unknown>[] = [
    {
      id: "cal-1",
      name: "予定表",
      hexColor: "#3366FF",
      canEdit: true,
      isDefaultCalendar: true,
    },
    { id: "cal-bd", name: "Birthdays", color: "lightGreen", canEdit: false },
  ];
  events = new Map<string, Stored>();
  removed: { id: string; calendar: string; version: number }[] = [];
  subscriptions = new Map<string, Record<string, unknown>>();
  requests: RecordedRequest[] = [];
  version = 0;
  nextId = 1;
  pageSize = 2;
  /** true なら、全件の差分の位置を無効 (410) にする。 */
  invalidateTokens = false;
  /** true なら、cancelledOccurrences の $select を 400 で拒む。 */
  rejectSelect = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([key, value]) => [key.toLowerCase(), value],
      ),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, url: url.toString(), headers, body });
    return this.handle(method, url, headers, body);
  };

  private json(status: number, value: unknown) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private error(status: number, code: string) {
    return this.json(status, { error: { code, message: code } });
  }

  private bump(event: Stored) {
    this.version += 1;
    event._version = this.version;
    event["@odata.etag"] = `W/"v${this.version}"`;
    event.changeKey = `v${this.version}`;
    event.lastModifiedDateTime = new Date(
      Date.UTC(2026, 10, 1) + this.version * 1000,
    ).toISOString();
  }

  /** 外に見せる形 (内部の項目を外す)。 */
  view(event: Stored, select?: string | null): GraphEvent {
    const {
      _calendar: _c,
      _version: _v,
      _occurrences: _o,
      cancelledOccurrences,
      ...rest
    } = event;
    const result: GraphEvent = { ...rest };
    if (
      event.type === "seriesMaster" &&
      select?.includes("cancelledOccurrences")
    ) {
      result.cancelledOccurrences = cancelledOccurrences ?? [];
    }
    return result;
  }

  /** 予定を直接入れる (相手側での変更のつもり)。 */
  put(calendar: string, event: Partial<GraphEvent> & { id?: string }) {
    const id = event.id ?? `ev-${this.nextId++}`;
    const stored = {
      type: "singleInstance",
      iCalUId: `ical-${id}`,
      isAllDay: false,
      showAs: "busy",
      ...event,
      id,
      _calendar: calendar,
      _version: 0,
    } as Stored;
    this.bump(stored);
    this.events.set(id, stored);
    return stored;
  }

  update(id: string, patch: Partial<GraphEvent>) {
    const stored = this.events.get(id);
    if (!stored) throw new Error(`no event ${id}`);
    Object.assign(stored, patch);
    this.bump(stored);
    return stored;
  }

  remove(id: string) {
    const stored = this.events.get(id);
    if (!stored) return;
    this.events.delete(id);
    this.version += 1;
    this.removed.push({
      id,
      calendar: stored._calendar,
      version: this.version,
    });
    if (stored.type === "seriesMaster") {
      // 原本を消すと、回と例外が @removed で届く (原本の ID は届かない)。
      this.removed.push({
        id: `${id}.occ`,
        calendar: stored._calendar,
        version: this.version,
      });
      this.removed = this.removed.filter((entry) => entry.id !== id);
      for (const child of [...this.events.values()]) {
        if (child.seriesMasterId === id) this.remove(child.id);
      }
    }
  }

  /** 原本の回 (まだ例外になっていないもの) を、回の予定の形で返す。 */
  private occurrencesOf(master: Stored): Stored[] {
    return (master._occurrences ?? []).map((originalStart) => ({
      id: `${master.id}.occ.${originalStart.slice(0, 10)}`,
      type: "occurrence",
      seriesMasterId: master.id,
      originalStart,
      originalStartTimeZone: master.originalStartTimeZone,
      isAllDay: master.isAllDay,
      subject: master.subject,
      start: master.start,
      end: master.end,
      _calendar: master._calendar,
      _version: master._version,
      "@odata.etag": master["@odata.etag"],
    }));
  }

  private deltaItems(calendar: string, since: number) {
    const items: Record<string, unknown>[] = [];
    for (const event of this.events.values()) {
      if (event._calendar !== calendar || event._version <= since) continue;
      if (event.type === "seriesMaster") {
        // 原本は返さず、回を 1 件だけ返す (原本が変わった合図)。
        items.push({
          ...this.view(event),
          id: `${event.id}.occ`,
          type: "occurrence",
          seriesMasterId: event.id,
          originalStart: event.start?.dateTime,
        });
      } else {
        items.push(this.view(event));
      }
    }
    if (since > 0) {
      for (const entry of this.removed) {
        if (entry.calendar === calendar && entry.version > since) {
          items.push({ id: entry.id, "@removed": { reason: "deleted" } });
        }
      }
    }
    return items;
  }

  private checkMatch(
    headers: Record<string, string>,
    event: Stored,
  ): Response | null {
    const match = headers["if-match"];
    if (match && match !== event["@odata.etag"]) {
      return this.error(412, "ErrorIrresolvableConflict");
    }
    return null;
  }

  private handle(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: unknown,
  ): Response {
    const path = url.pathname.replace(/^\/v1\.0/, "");
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (method === "GET" && path === "/me/calendars") {
      return this.json(200, { value: this.calendars });
    }

    // /me/calendars/{id}/calendarView/delta
    if (
      method === "GET" &&
      segments[0] === "me" &&
      segments[1] === "calendars" &&
      segments[3] === "calendarView" &&
      segments[4] === "delta"
    ) {
      const calendar = segments[2] ?? "";
      const token = url.searchParams.get("$deltatoken");
      if (token !== null && this.invalidateTokens) {
        return this.error(410, "SyncStateNotFound");
      }
      if (
        token === null &&
        url.searchParams.get("$skiptoken") === null &&
        (!url.searchParams.get("startDateTime") ||
          !url.searchParams.get("endDateTime"))
      ) {
        return this.error(400, "ErrorInvalidParameter");
      }
      const since = Number(url.searchParams.get("since") ?? token ?? "0");
      const offset = Number(url.searchParams.get("$skiptoken") ?? "0");
      const snapshot = Number(url.searchParams.get("upto") ?? this.version);
      const items = this.deltaItems(calendar, since);
      const page = items.slice(offset, offset + this.pageSize);
      const rest = offset + this.pageSize < items.length;
      const result: Record<string, unknown> = { value: page };
      if (rest) {
        result["@odata.nextLink"] =
          `${BASE}/me/calendars/${calendar}/calendarView/delta?$skiptoken=${offset + this.pageSize}&since=${since}&upto=${snapshot}`;
      } else {
        result["@odata.deltaLink"] =
          `${BASE}/me/calendars/${calendar}/calendarView/delta?$deltatoken=${snapshot}`;
      }
      return this.json(200, result);
    }

    // POST /me/calendars/{id}/events
    if (
      segments[0] === "me" &&
      segments[1] === "calendars" &&
      segments[3] === "events"
    ) {
      const calendar = segments[2] ?? "";
      if (method === "GET") {
        const filter = url.searchParams.get("$filter") ?? "";
        const tx = /transactionId eq '([^']+)'/.exec(filter)?.[1];
        return this.json(200, {
          value: [...this.events.values()]
            .filter((event) => event.transactionId === tx)
            .map((event) => this.view(event)),
        });
      }
      if (method === "POST") {
        const input = body as GraphEvent;
        const existing = [...this.events.values()].find(
          (event) =>
            input.transactionId && event.transactionId === input.transactionId,
        );
        if (existing) return this.json(201, this.view(existing));
        const created = this.put(calendar, {
          ...input,
          type: input.recurrence ? "seriesMaster" : "singleInstance",
          originalStartTimeZone: input.start?.timeZone,
          originalEndTimeZone: input.end?.timeZone,
        });
        if (created.type === "seriesMaster" && created.start?.dateTime) {
          created._occurrences = [`${created.start.dateTime.slice(0, 19)}Z`];
        }
        return this.json(201, this.view(created));
      }
    }

    // /me/events/{id}[/instances | /accept ...]
    if (segments[0] === "me" && segments[1] === "events" && segments[2]) {
      const id = segments[2];
      const action = segments[3];
      const occurrence = /^(.+)\.occ\.(\d{4}-\d{2}-\d{2})$/.exec(id);
      if (occurrence && !this.events.has(id)) {
        const master = this.events.get(occurrence[1] ?? "");
        const original = master?._occurrences?.find((value) =>
          value.startsWith(occurrence[2] ?? ""),
        );
        if (!master || !original) return this.error(404, "ErrorItemNotFound");
        if (method === "DELETE") {
          master._occurrences = master._occurrences?.filter(
            (value) => value !== original,
          );
          master.cancelledOccurrences = [
            ...(master.cancelledOccurrences ?? []),
            `OID.${master.id}.${occurrence[2]}`,
          ];
          this.bump(master);
          return new Response(null, { status: 204 });
        }
        if (method === "PATCH") {
          master._occurrences = master._occurrences?.filter(
            (value) => value !== original,
          );
          const created = this.put(master._calendar, {
            ...this.view(master),
            recurrence: null,
            id,
            type: "exception",
            seriesMasterId: master.id,
            originalStart: original,
            iCalUId: `ical-${id}`,
            ...(body as GraphEvent),
          });
          return this.json(200, this.view(created));
        }
      }
      const event = this.events.get(id);
      if (action === "instances" && method === "GET") {
        if (!event) return this.error(404, "ErrorItemNotFound");
        const exceptions = [...this.events.values()].filter(
          (item) => item.seriesMasterId === id,
        );
        return this.json(200, {
          value: [...this.occurrencesOf(event), ...exceptions].map((item) =>
            this.view(item),
          ),
        });
      }
      if (!event) return this.error(404, "ErrorItemNotFound");
      if (
        method === "POST" &&
        ["accept", "tentativelyAccept", "decline"].includes(action ?? "")
      ) {
        const response =
          action === "accept"
            ? "accepted"
            : action === "decline"
              ? "declined"
              : "tentativelyAccepted";
        this.update(id, { responseStatus: { response } });
        return new Response(null, { status: 202 });
      }
      if (method === "GET") {
        const select = url.searchParams.get("$select");
        if (select && this.rejectSelect) {
          return this.error(400, "RequestBroker--ParseUri");
        }
        return this.json(200, this.view(event, select));
      }
      if (method === "PATCH") {
        const conflict = this.checkMatch(headers, event);
        if (conflict) return conflict;
        const patch = body as GraphEvent;
        this.update(id, patch);
        if (patch.originalStartTimeZone === undefined && patch.start) {
          event.originalStartTimeZone = patch.start.timeZone;
        }
        return this.json(200, this.view(event));
      }
      if (method === "DELETE") {
        const conflict = this.checkMatch(headers, event);
        if (conflict) return conflict;
        this.remove(id);
        return new Response(null, { status: 204 });
      }
    }

    if (segments[0] === "subscriptions") {
      const id = segments[1];
      if (method === "POST" && !id) {
        const created = {
          ...(body as Record<string, unknown>),
          id: `sub-${this.nextId++}`,
        };
        this.subscriptions.set(created.id, created);
        return this.json(201, created);
      }
      const existing = id ? this.subscriptions.get(id) : undefined;
      if (!id || !existing) return this.error(404, "ResourceNotFound");
      if (method === "PATCH") {
        Object.assign(existing, body);
        return this.json(200, existing);
      }
      if (method === "DELETE") {
        this.subscriptions.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    return this.error(400, `unhandled ${method} ${path}`);
  }
}
