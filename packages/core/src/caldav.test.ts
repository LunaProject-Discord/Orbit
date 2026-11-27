import { describe, expect, it } from "vitest";
import {
  CaldavClient,
  CaldavXmlError,
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
});
