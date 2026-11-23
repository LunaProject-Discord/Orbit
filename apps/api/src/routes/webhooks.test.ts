import { type GraphPushNotification, graphClientState } from "@orbit/core";
import { describe, expect, it } from "vitest";
import { webhookRoutes } from "./webhooks.js";

const key = Buffer.alloc(32, 1);
const accountId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8724";
const clientState = graphClientState(key, accountId);

function setup() {
  const sent: GraphPushNotification[] = [];
  const app = webhookRoutes({
    encryptionKey: key,
    notify: async (payload) => {
      sent.push(payload);
    },
  });
  const post = (query: string, body?: unknown) =>
    app.request(`/webhooks/microsoft${query}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
    });
  return { sent, post };
}

describe("Microsoft Graph の変更通知の受け口", () => {
  it("受け口の確認では、受け取った値をそのままテキストで返す", async () => {
    const { sent, post } = setup();
    const response = await post("?validationToken=abc%20123%3D");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("abc 123=");
    expect(sent).toEqual([]);
  });

  it("合言葉が一致する通知を、同期ワーカーへ 1 回にまとめて伝える", async () => {
    const { sent, post } = setup();
    const response = await post(`?account=${accountId}`, {
      value: [
        { clientState, changeType: "created", resource: "users/x/messages/1" },
        { clientState, changeType: "updated", resource: "users/x/messages/2" },
      ],
    });
    expect(response.status).toBe(202);
    expect(sent).toEqual([{ accountId, lifecycle: null }]);
  });

  it("購読の状態の通知は、種類を付けて伝える", async () => {
    const { sent, post } = setup();
    await post(`?account=${accountId}`, {
      value: [
        { clientState, lifecycleEvent: "reauthorizationRequired" },
        { clientState, lifecycleEvent: "missed" },
      ],
    });
    expect(sent).toEqual([
      { accountId, lifecycle: "reauthorizationRequired" },
      { accountId, lifecycle: "missed" },
    ]);
  });

  it("合言葉が違う通知は、受け取ったふりをして捨てる", async () => {
    const { sent, post } = setup();
    const response = await post(`?account=${accountId}`, {
      value: [{ clientState: "wrong", changeType: "created" }, {}],
    });
    expect(response.status).toBe(202);
    expect(sent).toEqual([]);
  });

  it("形式が正しくない要求は拒否する", async () => {
    const { sent, post } = setup();
    expect((await post("?account=not-a-uuid", { value: [] })).status).toBe(400);
    expect((await post(`?account=${accountId}`, "{")).status).toBe(400);
    expect((await post(`?account=${accountId}`, { value: 1 })).status).toBe(
      400,
    );
    expect(sent).toEqual([]);
  });
});
