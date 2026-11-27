import { describe, expect, it } from "vitest";
import {
  fetchIcs,
  normalizeSubscriptionUrl,
  subscriptionUrlCandidates,
} from "./ics-fetch.js";

describe("normalizeSubscriptionUrl", () => {
  it("webcal を https にし、使えない URL は null", () => {
    expect(normalizeSubscriptionUrl(" webcal://example.com/a.ics#x ")).toBe(
      "https://example.com/a.ics",
    );
    expect(normalizeSubscriptionUrl("ftp://example.com/a.ics")).toBeNull();
    expect(
      normalizeSubscriptionUrl("https://u:p@example.com/a.ics"),
    ).toBeNull();
    expect(normalizeSubscriptionUrl("not a url")).toBeNull();
  });
});

describe("fetchIcs", () => {
  it("内部のアドレスへは取りに行かない", async () => {
    let called = false;
    const result = await fetchIcs("http://127.0.0.1/a.ics", {
      fetchImpl: async () => {
        called = true;
        return new Response("");
      },
    });
    expect(result).toEqual({ status: "error", reason: "private_address" });
    expect(called).toBe(false);
  });

  it("条件付きで取得し、304 なら変わっていないと返す", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return seen.length === 1
        ? new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", {
            headers: { etag: '"v1"' },
          })
        : new Response(null, { status: 304 });
    }) as typeof fetch;
    const first = await fetchIcs("https://203.0.113.5/a.ics", { fetchImpl });
    expect(first).toMatchObject({ status: "ok", validator: 'etag:"v1"' });
    const second = await fetchIcs("https://203.0.113.5/a.ics", {
      fetchImpl,
      validator: 'etag:"v1"',
    });
    expect(second).toEqual({ status: "not_modified" });
    expect(seen[1]?.["if-none-match"]).toBe('"v1"');
  });

  it("リダイレクト先も確かめる", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/secret" },
      })) as unknown as typeof fetch;
    expect(await fetchIcs("https://203.0.113.5/a.ics", { fetchImpl })).toEqual({
      status: "error",
      reason: "private_address",
    });
  });
});

describe("subscriptionUrlCandidates", () => {
  it("webcal は https、http の順に試す", () => {
    expect(subscriptionUrlCandidates("webcal://example.com/a.ics")).toEqual([
      "https://example.com/a.ics",
      "http://example.com/a.ics",
    ]);
    expect(subscriptionUrlCandidates("https://example.com/a.ics")).toEqual([
      "https://example.com/a.ics",
    ]);
  });
});
