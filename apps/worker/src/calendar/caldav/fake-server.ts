import { parseXml, type XmlElement } from "@orbit/core";

/**
 * テスト用の小さな CalDAV サーバー。fetch の差し替えとして使う (本番のコードからは使わない)。
 * 探索 (well-known → principal → calendar-home-set)、PROPFIND、REPORT (calendar-query、
 * calendar-multiget、sync-collection)、GET / PUT / DELETE と、If-Match / If-None-Match を再現する。
 */

export type FakeCalendar = {
  path: string;
  displayName: string;
  color?: string;
  readOnly?: boolean;
  components?: string[];
};

export type FakeCaldavOptions = {
  origin?: string;
  username?: string;
  password?: string;
  /** sync-collection に対応する (supported-report-set に出す)。 */
  syncCollection?: boolean;
  /** PUT の応答に ETag を付けない (サーバーが内容を変えたときの動き)。 */
  omitEtagOnPut?: boolean;
  /** calendar-home-set を別のホストにする (iCloud のように)。 */
  homeOrigin?: string;
  calendars?: FakeCalendar[];
  /** OPTIONS の DAV ヘッダーに calendar-auto-schedule を入れる (招待を自分で送るサーバー)。 */
  autoSchedule?: boolean;
  /** OPTIONS に返す状態コード (失敗を再現する)。既定は 200。 */
  optionsStatus?: number;
};

type Resource = { etag: string; data: string };

export class FakeCaldavServer {
  readonly origin: string;
  readonly homeOrigin: string;
  readonly requests: {
    method: string;
    url: string;
    headers: Headers;
    body: string;
  }[] = [];
  readonly resources = new Map<string, Resource>();
  private version = 1;
  private readonly log: { version: number; path: string }[] = [];
  private readonly calendars: FakeCalendar[];
  /** 次の syncCollection の token を無効にする (403 valid-sync-token)。 */
  invalidateTokens = false;

  constructor(private readonly options: FakeCaldavOptions = {}) {
    this.origin = options.origin ?? "https://dav.example.com";
    this.homeOrigin = options.homeOrigin ?? this.origin;
    this.calendars = options.calendars ?? [
      { path: "/cal/user/work/", displayName: "仕事", color: "#FF2968FF" },
      {
        path: "/cal/user/tasks/",
        displayName: "タスク",
        components: ["VTODO"],
      },
    ];
  }

  /** リソースを直接置く (相手側での変更を再現する)。 */
  putDirect(path: string, data: string) {
    this.resources.set(path, { etag: `"e${this.version}"`, data });
    this.bump(path);
  }

  deleteDirect(path: string) {
    this.resources.delete(path);
    this.bump(path);
  }

  private bump(path: string) {
    this.log.push({ version: this.version, path });
    this.version++;
  }

  private ctagOf(collection: string) {
    const last = [...this.log]
      .reverse()
      .find((entry) => entry.path.startsWith(collection));
    return `ctag-${last?.version ?? 0}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    this.requests.push({ method, url: url.toString(), headers, body });
    const expected = `Basic ${Buffer.from(
      `${this.options.username ?? "user"}:${this.options.password ?? "secret"}`,
    ).toString("base64")}`;
    if (url.origin !== this.origin && url.origin !== this.homeOrigin) {
      return new Response("unknown host", { status: 502 });
    }
    if (url.pathname === "/.well-known/caldav") {
      return new Response(null, {
        status: 301,
        headers: { location: "/dav/" },
      });
    }
    if (headers.get("authorization") !== expected) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="fake"' },
      });
    }
    const path = decodeURIComponent(url.pathname);
    if (method === "PROPFIND")
      return this.propfind(path, headers.get("depth") ?? "0", body);
    if (method === "REPORT") return this.report(path, body);
    if (method === "GET") {
      const resource = this.resources.get(path);
      if (!resource) return new Response("not found", { status: 404 });
      return new Response(resource.data, {
        status: 200,
        headers: { etag: resource.etag, "content-type": "text/calendar" },
      });
    }
    if (method === "PUT") return this.put(path, headers, body);
    if (method === "OPTIONS") {
      if (this.options.optionsStatus && this.options.optionsStatus !== 200) {
        return new Response(null, { status: this.options.optionsStatus });
      }
      return new Response(null, {
        status: 200,
        headers: {
          dav: [
            "1, 2, 3, access-control, calendar-access",
            ...(this.options.autoSchedule ? ["calendar-auto-schedule"] : []),
          ].join(", "),
        },
      });
    }
    if (method === "DELETE") {
      const resource = this.resources.get(path);
      if (!resource) return new Response(null, { status: 404 });
      const ifMatch = headers.get("if-match");
      if (ifMatch && ifMatch !== "*" && ifMatch !== resource.etag) {
        return new Response(null, { status: 412 });
      }
      this.deleteDirect(path);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };

  private calendarOf(path: string) {
    return this.calendars.find((calendar) => path.startsWith(calendar.path));
  }

  private put(path: string, headers: Headers, body: string): Response {
    const calendar = this.calendarOf(path);
    if (!calendar || path === calendar.path)
      return new Response(null, { status: 404 });
    if (calendar.readOnly) return new Response(null, { status: 403 });
    if (!/BEGIN:VCALENDAR/.test(body)) {
      return new Response(
        '<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:valid-calendar-data/></d:error>',
        { status: 403 },
      );
    }
    const existing = this.resources.get(path);
    const ifMatch = headers.get("if-match");
    const ifNoneMatch = headers.get("if-none-match");
    if (ifNoneMatch === "*" && existing)
      return new Response(null, { status: 412 });
    if (ifMatch === "*" && !existing)
      return new Response(null, { status: 412 });
    if (ifMatch && ifMatch !== "*" && ifMatch !== existing?.etag) {
      return new Response(null, { status: 412 });
    }
    this.putDirect(path, body);
    const etag = this.resources.get(path)?.etag ?? "";
    return new Response(null, {
      status: existing ? 204 : 201,
      headers: this.options.omitEtagOnPut ? {} : { etag },
    });
  }

  private multistatus(responses: string[], extra = ""): Response {
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">
${responses.join("\n")}${extra}
</D:multistatus>`,
      {
        status: 207,
        headers: { "content-type": "application/xml; charset=utf-8" },
      },
    );
  }

  private ok(href: string, props: string) {
    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  }

  private calendarProps(calendar: FakeCalendar) {
    const comps = (calendar.components ?? ["VEVENT"])
      .map((name) => `<C:comp name="${name}"/>`)
      .join("");
    const privileges = calendar.readOnly
      ? "<D:privilege><D:read/></D:privilege>"
      : "<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>";
    const reports = this.options.syncCollection
      ? "<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>"
      : "";
    return `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
<D:displayname>${calendar.displayName}</D:displayname>
<D:current-user-privilege-set>${privileges}</D:current-user-privilege-set>
<D:supported-report-set>${reports}</D:supported-report-set>
<C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>
${calendar.color ? `<A:calendar-color>${calendar.color}</A:calendar-color>` : ""}
<CS:getctag>${this.ctagOf(calendar.path)}</CS:getctag>
${this.options.syncCollection ? `<D:sync-token>http://fake/sync/${this.version - 1}</D:sync-token>` : ""}`;
  }

  private propfind(path: string, depth: string, _body: string): Response {
    if (path === "/dav/") {
      return this.multistatus([
        this.ok(
          "/dav/",
          "<D:current-user-principal><D:href>/principals/user/</D:href></D:current-user-principal><D:resourcetype><D:collection/></D:resourcetype>",
        ),
      ]);
    }
    if (path === "/principals/user/") {
      return this.multistatus([
        this.ok(
          "/principals/user/",
          `<C:calendar-home-set><D:href>${this.homeOrigin === this.origin ? "" : this.homeOrigin}/cal/user/</D:href></C:calendar-home-set>`,
        ),
      ]);
    }
    if (path === "/cal/user/") {
      const responses = [
        this.ok(
          "/cal/user/",
          "<D:resourcetype><D:collection/></D:resourcetype>",
        ),
      ];
      if (depth === "1") {
        responses.push(
          this.ok(
            "/cal/user/inbox/",
            "<D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>",
          ),
        );
        for (const calendar of this.calendars) {
          responses.push(this.ok(calendar.path, this.calendarProps(calendar)));
        }
      }
      return this.multistatus(responses);
    }
    const calendar = this.calendars.find((entry) => entry.path === path);
    if (calendar)
      return this.multistatus([
        this.ok(calendar.path, this.calendarProps(calendar)),
      ]);
    return new Response(null, { status: 404 });
  }

  private members(collection: string) {
    return [...this.resources].filter(([path]) => path.startsWith(collection));
  }

  private report(path: string, body: string): Response {
    const root = parseXml(body);
    const calendar = this.calendars.find((entry) => entry.path === path);
    if (!calendar) return new Response(null, { status: 404 });
    if (root.local === "calendar-query") {
      return this.multistatus(
        this.members(path)
          .filter(([, resource]) => /BEGIN:VEVENT/.test(resource.data))
          .map(([href, resource]) =>
            this.ok(href, `<D:getetag>${resource.etag}</D:getetag>`),
          ),
      );
    }
    if (root.local === "calendar-multiget") {
      const hrefs = root.children
        .filter((entry: XmlElement) => entry.local === "href")
        .map((entry: XmlElement) => decodeURIComponent(entry.text.trim()));
      return this.multistatus(
        hrefs.map((href) => {
          const resource = this.resources.get(href);
          if (!resource) {
            return `<D:response><D:href>${href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
          }
          const escaped = resource.data
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return this.ok(
            href,
            `<D:getetag>${resource.etag}</D:getetag><C:calendar-data>${escaped}</C:calendar-data>`,
          );
        }),
      );
    }
    if (root.local === "sync-collection") {
      if (!this.options.syncCollection)
        return new Response(null, { status: 501 });
      const tokenText =
        root.children
          .find((entry) => entry.local === "sync-token")
          ?.text.trim() ?? "";
      const match = /\/sync\/(\d+)$/.exec(tokenText);
      if ((tokenText && !match) || this.invalidateTokens) {
        this.invalidateTokens = false;
        return new Response(
          '<?xml version="1.0"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>',
          { status: 403 },
        );
      }
      const since = match ? Number(match[1]) : 0;
      const changed = new Set(
        this.log
          .filter(
            (entry) => entry.version > since && entry.path.startsWith(path),
          )
          .map((entry) => entry.path),
      );
      const responses = [...changed].map((href) => {
        const resource = this.resources.get(href);
        return resource
          ? this.ok(href, `<D:getetag>${resource.etag}</D:getetag>`)
          : `<D:response><D:href>${href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
      });
      return this.multistatus(
        responses,
        `<D:sync-token>http://fake/sync/${this.version - 1}</D:sync-token>`,
      );
    }
    return new Response(null, { status: 400 });
  }
}

/** テスト用の VCALENDAR。 */
export function vcalendar(...events: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export function vevent(lines: Record<string, string> | string[]): string {
  const body = Array.isArray(lines)
    ? lines
    : Object.entries(lines).map(([key, value]) => `${key}:${value}`);
  return ["BEGIN:VEVENT", ...body, "END:VEVENT"].join("\r\n");
}
