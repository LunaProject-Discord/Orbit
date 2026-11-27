import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CaldavAuthError,
  CaldavClient,
  CaldavXmlError,
  createPinnedLookup,
  hasAutoSchedule,
  parseXml,
  retryAfterMs,
  sameDavPath,
} from "./caldav.js";

describe("parseXml", () => {
  it("名前空間の接頭辞が違っても同じ要素として読み、実体と CDATA を戻す", () => {
    const root = parseXml(`<?xml version="1.0"?>
<!DOCTYPE x [<!ENTITY e "x">]>
<multistatus xmlns="DAV:" xmlns:C='urn:ietf:params:xml:ns:caldav'>
  <!-- コメント -->
  <response><href>/a%20b.ics</href>
    <C:calendar-data><![CDATA[BEGIN:VCALENDAR]]>&#10;&lt;&amp;&gt;</C:calendar-data>
    <C:comp name="VEVENT"/>
  </response>
</multistatus>`);
    expect(root).toMatchObject({ ns: "DAV:", local: "multistatus" });
    const response = root.children[0];
    expect(response?.children.map((child) => [child.ns, child.local])).toEqual([
      ["DAV:", "href"],
      ["urn:ietf:params:xml:ns:caldav", "calendar-data"],
      ["urn:ietf:params:xml:ns:caldav", "comp"],
    ]);
    expect(response?.children[1]?.text).toBe("BEGIN:VCALENDAR\n<&>");
    expect(response?.children[2]?.attrs).toEqual({ name: "VEVENT" });
  });

  it("壊れた XML は CaldavXmlError", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(CaldavXmlError);
    expect(() => parseXml("<a>")).toThrow(CaldavXmlError);
  });
});

describe("補助の関数", () => {
  it("Retry-After を秒と日付で読む", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(
      retryAfterMs(
        "Wed, 21 Oct 2015 07:28:10 GMT",
        Date.parse("2015-10-21T07:28:00Z"),
      ),
    ).toBe(10_000);
    expect(retryAfterMs(null)).toBeNull();
  });

  it("href は末尾の / とエンコードの違いを無視して比べる", () => {
    expect(sameDavPath("/cal/a%40b/", "/cal/a@b")).toBe(true);
    expect(sameDavPath("/cal/a/", "/cal/b/")).toBe(false);
  });
});

describe("CaldavClient", () => {
  it("URL に認証情報や http(s) 以外は使わない", async () => {
    const client = new CaldavClient({
      username: "u",
      password: "p",
      isPrivateHost: async () => false,
    });
    await expect(client.checkUrl("ftp://example.com/")).rejects.toThrow();
    await expect(client.checkUrl("https://a:b@example.com/")).rejects.toThrow();
    await expect(
      client.checkUrl("https://example.com/"),
    ).resolves.toBeUndefined();
  });

  it("名前を解決できないホストは host_not_found", async () => {
    const client = new CaldavClient({
      username: "u",
      password: "p",
      isPrivateHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    await expect(
      client.checkUrl("https://nowhere.example/"),
    ).rejects.toMatchObject({
      reason: "host_not_found",
    });
  });

  it("PUT と DELETE はリダイレクトを追わず、412 と 404 を結果で返す", async () => {
    const statuses = [302, 412, 404];
    const client = new CaldavClient({
      username: "u",
      password: "p",
      isPrivateHost: async () => false,
      fetchFn: async () =>
        new Response(null, {
          status: statuses.shift() ?? 500,
          headers: { location: "/x" },
        }),
    });
    expect(
      (await client.put("https://dav.example.com/a.ics", "x")).status,
    ).toBe("rejected");
    expect(
      await client.put("https://dav.example.com/a.ics", "x", {
        ifMatch: '"1"',
      }),
    ).toEqual({
      status: "precondition_failed",
    });
    expect(await client.delete("https://dav.example.com/a.ics", null)).toEqual({
      status: "not_found",
    });
  });

  describe("calendar-auto-schedule (OPTIONS の DAV ヘッダー)", () => {
    const clientWith = (
      reply: (url: string) => Response | Promise<Response>,
      seen: string[] = [],
    ) =>
      new CaldavClient({
        username: "u",
        password: "p",
        isPrivateHost: async () => false,
        fetchFn: async (input, init) => {
          seen.push(`${init?.method} ${String(input)}`);
          return reply(String(input));
        },
      });

    it("hasAutoSchedule は区切りの空白と大文字小文字を気にしない", () => {
      expect(
        hasAutoSchedule(
          "1, 2, access-control, calendar-access, Calendar-Auto-Schedule",
        ),
      ).toBe(true);
      expect(hasAutoSchedule("1, 2, calendar-access")).toBe(false);
      expect(hasAutoSchedule("calendar-auto-schedule-x")).toBe(false);
      expect(hasAutoSchedule(null)).toBe(false);
    });

    it("ヘッダーにあれば true、無ければ false", async () => {
      const seen: string[] = [];
      const yes = clientWith(
        () =>
          new Response(null, {
            headers: { dav: "1, 2, calendar-access, calendar-auto-schedule" },
          }),
        seen,
      );
      expect(
        await yes.supportsAutoSchedule(["https://dav.example.com/cal/"]),
      ).toBe(true);
      expect(seen).toEqual(["OPTIONS https://dav.example.com/cal/"]);
      const no = clientWith(
        () => new Response(null, { headers: { dav: "1, calendar-access" } }),
      );
      expect(
        await no.supportsAutoSchedule(["https://dav.example.com/cal/"]),
      ).toBe(false);
    });

    it("どれも一時的に失敗したら null (調べられなかった)。4xx が混じっても一時的な失敗があれば null", async () => {
      const network = clientWith(() => {
        throw new Error("ECONNRESET");
      });
      expect(
        await network.supportsAutoSchedule([
          "https://dav.example.com/home/cal/",
          "https://dav.example.com/home/",
        ]),
      ).toBeNull();
      for (const status of [500, 503, 408, 429]) {
        const busy = clientWith(() => new Response(null, { status }));
        expect(
          await busy.supportsAutoSchedule(["https://dav.example.com/cal/"]),
        ).toBeNull();
      }
      const mixed = clientWith((url) =>
        url.endsWith("/cal/")
          ? new Response(null, { status: 405 })
          : new Response(null, { status: 503 }),
      );
      expect(
        await mixed.supportsAutoSchedule([
          "https://dav.example.com/home/cal/",
          "https://dav.example.com/home/",
        ]),
      ).toBeNull();
    });

    it("コレクションで失敗したらホームを試し、どれも 4xx なら false", async () => {
      const seen: string[] = [];
      const fallback = clientWith((url) => {
        if (url.endsWith("/cal/")) throw new Error("ECONNRESET");
        return new Response(null, {
          headers: { dav: "calendar-auto-schedule" },
        });
      }, seen);
      expect(
        await fallback.supportsAutoSchedule([
          "https://dav.example.com/home/cal/",
          "https://dav.example.com/home/",
        ]),
      ).toBe(true);
      expect(seen).toHaveLength(2);
      const failing = clientWith(() => new Response(null, { status: 405 }));
      expect(
        await failing.supportsAutoSchedule(["https://dav.example.com/cal/"]),
      ).toBe(false);
    });

    it("401 は認証の失敗として投げる", async () => {
      const client = clientWith(() => new Response(null, { status: 401 }));
      await expect(
        client.supportsAutoSchedule(["https://dav.example.com/cal/"]),
      ).rejects.toBeInstanceOf(CaldavAuthError);
    });
  });
});

describe("CaldavClient (接続先の安全)", () => {
  const multistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;

  it("https で始めたら http へのリダイレクトを追わない (allowPrivateHosts なら追う)", async () => {
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https:")) {
        return new Response(null, {
          status: 301,
          headers: { location: "http://dav.example.com/dav/" },
        });
      }
      return new Response(multistatus, { status: 207 });
    };
    const client = new CaldavClient({
      username: "u",
      password: "p",
      isPrivateHost: async () => false,
      fetchFn,
    });
    await expect(
      client.request("PROPFIND", "https://dav.example.com/dav/"),
    ).rejects.toMatchObject({ name: "CaldavHostError" });
    expect(seen).toEqual(["https://dav.example.com/dav/"]);

    const dev = new CaldavClient({
      username: "u",
      password: "p",
      allowPrivateHosts: true,
      fetchFn,
    });
    await expect(
      dev.request("PROPFIND", "https://dav.example.com/dav/"),
    ).resolves.toMatchObject({ status: 207 });
  });

  it("https で始めたら、サーバーが返す http の href へ移らない", async () => {
    const client = new CaldavClient({
      username: "u",
      password: "p",
      isPrivateHost: async () => false,
      fetchFn: async () =>
        new Response(
          `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat>
<d:prop><d:current-user-principal><d:href>http://dav.example.com/principal/</d:href></d:current-user-principal></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
          { status: 207 },
        ),
    });
    await expect(
      client.discover("https://dav.example.com/dav/"),
    ).rejects.toMatchObject({ name: "CaldavHostError" });
  });

  it("認証情報は同じスキームとホストにだけ送る (iCloud だけは icloud.com の下をまとめる)", async () => {
    const run = async (from: string, to: string) => {
      const sent: (string | null)[] = [];
      const client = new CaldavClient({
        username: "u",
        password: "p",
        isPrivateHost: async () => false,
        fetchFn: async (input, init) => {
          sent.push(new Headers(init?.headers).get("authorization"));
          return String(input) === from
            ? new Response(null, { status: 302, headers: { location: to } })
            : new Response(multistatus, { status: 207 });
        },
      });
      await client.request("PROPFIND", from);
      return sent.map((value) => value !== null);
    };
    // github.io の下の別の利用者のサイト (私的な公開サフィックス) には送らない。
    expect(
      await run("https://a.github.io/dav/", "https://b.github.io/dav/"),
    ).toEqual([true, false]);
    // 同じホストでもポートが違えば送らない。
    expect(
      await run("https://dav.example.com/", "https://dav.example.com:8443/"),
    ).toEqual([true, false]);
    expect(
      await run("https://dav.example.com/", "https://dav.example.com/other/"),
    ).toEqual([true, true]);
    expect(
      await run(
        "https://caldav.icloud.com/",
        "https://p01-caldav.icloud.com/123/",
      ),
    ).toEqual([true, true]);
  });

  it("接続のときの名前解決が内部ネットワークなら、検査のあとでも接続しない (DNS rebinding)", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(207, { "content-type": "application/xml" });
      response.end(multistatus);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      // 検査 (isPrivateHost) は公開のアドレスだと答えたが、接続のときには 127.0.0.1 になる。
      const client = new CaldavClient({
        username: "u",
        password: "p",
        isPrivateHost: async () => false,
      });
      await expect(
        client.request("PROPFIND", `http://localhost:${port}/`),
      ).rejects.toMatchObject({
        name: "CaldavHostError",
        reason: "host_not_allowed",
      });
      // allowPrivateHosts なら検査しない。
      const dev = new CaldavClient({
        username: "u",
        password: "p",
        allowPrivateHosts: true,
      });
      await expect(
        dev.request("PROPFIND", `http://localhost:${port}/`),
      ).resolves.toMatchObject({ status: 207 });
    } finally {
      server.close();
    }
  });

  it("接続のときの名前解決は、解決した IP をそのまま使わせる", async () => {
    const resolve =
      (addresses: { address: string; family: number }[]) =>
      (
        _host: string,
        callback: (
          error: Error | null,
          list: { address: string; family: number }[],
        ) => void,
      ) =>
        callback(null, addresses);
    const call = (
      lookup: ReturnType<typeof createPinnedLookup>,
      options: { all?: boolean; family?: number },
    ) =>
      new Promise<{ error: unknown; address: unknown; family: unknown }>(
        (done) =>
          lookup("dav.example.com", options, (error, address, family) =>
            done({ error, address, family }),
          ),
      );
    const publicLookup = createPinnedLookup(
      resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800::1", family: 6 },
      ]),
    );
    expect(await call(publicLookup, {})).toEqual({
      error: null,
      address: "93.184.216.34",
      family: 4,
    });
    expect(await call(publicLookup, { all: true, family: 6 })).toMatchObject({
      error: null,
      address: [{ address: "2606:2800::1", family: 6 }],
    });
    const rebinding = createPinnedLookup(
      resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    expect((await call(rebinding, { all: true })).error).toMatchObject({
      name: "CaldavHostError",
      reason: "host_not_allowed",
    });
  });

  it("content-length の無い応答も、上限を超えたら読むのをやめる", async () => {
    let pulled = 0;
    const client = new CaldavClient({
      username: "u",
      password: "p",
      isPrivateHost: async () => false,
      maxResponseBytes: 1024,
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(512).fill(65));
              if (pulled > 100) controller.close();
            },
          }),
          { status: 207 },
        ),
    });
    await expect(
      client.request("PROPFIND", "https://dav.example.com/"),
    ).rejects.toThrow(/大きすぎ/);
    expect(pulled).toBeLessThan(10);
  });
});
