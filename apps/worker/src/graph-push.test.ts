import { describe, expect, it } from "vitest";
import { GraphClient } from "./graph-client.js";
import {
  ensureSubscription,
  pollInterval,
  SUBSCRIPTION_LIFETIME_MS,
} from "./graph-push.js";

const BASE = "https://graph.microsoft.com/v1.0";
const now = Date.parse("2026-11-21T00:00:00Z");
const expiration = new Date(now + SUBSCRIPTION_LIFETIME_MS).toISOString();
const options = {
  notificationUrl: "https://api.example.com/v1/webhooks/microsoft?account=a1",
  clientState: "secret",
  now,
};

type Call = { method: string; url: string; body: unknown };

function fakeGraph(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = new GraphClient({
    getToken: async () => "token",
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  });
  return { client, calls };
}

describe("ensureSubscription", () => {
  it("購読が無ければ、全メッセージを対象に作る", async () => {
    const { client, calls } = fakeGraph(() =>
      Response.json({ id: "sub1", expirationDateTime: expiration }),
    );
    const state = await ensureSubscription(client, {
      ...options,
      state: { subscriptionId: null, expiresAt: null },
    });
    expect(state).toEqual({
      subscriptionId: "sub1",
      expiresAt: new Date(expiration),
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: `${BASE}/subscriptions`,
        body: {
          changeType: "created,updated,deleted",
          notificationUrl: options.notificationUrl,
          lifecycleNotificationUrl: options.notificationUrl,
          resource: "me/messages",
          expirationDateTime: expiration,
          clientState: "secret",
        },
      },
    ]);
  });

  it("有効な購読があれば、期限を延ばす", async () => {
    const { client, calls } = fakeGraph(() =>
      Response.json({ id: "sub1", expirationDateTime: expiration }),
    );
    const state = await ensureSubscription(client, {
      ...options,
      state: { subscriptionId: "sub1", expiresAt: new Date(now + 60_000) },
    });
    expect(state.expiresAt).toEqual(new Date(expiration));
    expect(calls).toEqual([
      {
        method: "PATCH",
        url: `${BASE}/subscriptions/sub1`,
        body: { expirationDateTime: expiration },
      },
    ]);
  });

  it("延長しようとした購読が消されていたら、作り直す", async () => {
    const { client, calls } = fakeGraph((call) =>
      call.method === "PATCH"
        ? Response.json(
            { error: { code: "ResourceNotFound" } },
            { status: 404 },
          )
        : Response.json({ id: "sub2", expirationDateTime: expiration }),
    );
    const state = await ensureSubscription(client, {
      ...options,
      state: { subscriptionId: "sub1", expiresAt: new Date(now + 60_000) },
    });
    expect(state.subscriptionId).toBe("sub2");
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "POST"]);
  });

  it("期限が切れた購読は延長せず、作り直す", async () => {
    const { client, calls } = fakeGraph(() =>
      Response.json({ id: "sub2", expirationDateTime: expiration }),
    );
    await ensureSubscription(client, {
      ...options,
      state: { subscriptionId: "sub1", expiresAt: new Date(now - 1) },
    });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("受け口の確認に失敗した場合などは、エラーをそのまま伝える", async () => {
    const { client } = fakeGraph(() =>
      Response.json(
        { error: { code: "ValidationError", message: "validation failed" } },
        { status: 400 },
      ),
    );
    await expect(
      ensureSubscription(client, {
        ...options,
        state: { subscriptionId: null, expiresAt: null },
      }),
    ).rejects.toThrow("validation failed");
  });
});

describe("pollInterval", () => {
  it("画面を開いている間は短く、変更通知が届いている間は長くする", () => {
    const at = (present: boolean, pushTrusted: boolean, slowdown = 1) =>
      pollInterval({ present, pushTrusted, slowdown });
    expect(at(true, false)).toBe(5_000);
    expect(at(false, false)).toBe(15_000);
    expect(at(true, true)).toBe(60_000);
    expect(at(false, true)).toBe(300_000);
  });

  it("制限を受けたあとは、倍率の分だけ延ばす (上限あり)", () => {
    expect(
      pollInterval({ present: true, pushTrusted: false, slowdown: 4 }),
    ).toBe(20_000);
    expect(
      pollInterval({ present: true, pushTrusted: false, slowdown: 100 }),
    ).toBe(40_000);
  });
});
