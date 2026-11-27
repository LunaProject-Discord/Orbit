import {
  type CalendarSyncNotification,
  graphClientState,
  microsoftCalendarClientState,
} from "@orbit/core";
import type { Database } from "@orbit/db";
import { describe, expect, it } from "vitest";
import {
  MICROSOFT_CALENDAR_WEBHOOK_PATH,
  microsoftCalendarWebhookRoutes,
} from "./calendar-webhook-microsoft.js";

const key = Buffer.alloc(32, 1);
const accountId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8724";
const calendarId = "01a1fcb1-b4bb-71cc-9452-cd6f31df8725";
const clientState = microsoftCalendarClientState(key, accountId, calendarId);

function setup() {
  const sent: CalendarSyncNotification[] = [];
  const updates: Record<string, unknown>[] = [];
  // 購読の状態の通知で使う update だけの偽物。
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  } as unknown as Database;
  const app = microsoftCalendarWebhookRoutes({
    db,
    encryptionKey: key,
    notify: async (payload) => {
      sent.push(payload);
    },
  });
  const post = (query: string, body?: unknown) =>
    app.request(`/${query}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
    });
  return { sent, updates, post };
}

const query = `?account=${accountId}&calendar=${calendarId}`;

describe("Microsoft のカレンダーの変更通知の受け口", () => {
  it("パスはメールの受け口と分ける", () => {
    expect(MICROSOFT_CALENDAR_WEBHOOK_PATH).toBe(
      "/webhooks/microsoft-calendar",
    );
  });

  it("受け口の確認では、受け取った値をそのままテキストで返す", async () => {
    const { sent, post } = setup();
    const response = await post("?validationToken=abc%20123%3D");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("abc 123=");
    expect(sent).toEqual([]);
  });

  it("合言葉が一致する通知を、カレンダーの同期へ 1 回にまとめて伝える", async () => {
    const { sent, post } = setup();
    const response = await post(query, {
      value: [
        { clientState, changeType: "created", resource: "x" },
        { clientState, changeType: "updated", resource: "y" },
      ],
    });
    expect(response.status).toBe(202);
    expect(sent).toEqual([{ accountId, calendarId, reason: "push" }]);
  });

  it("合言葉が違う (メールの合言葉、別のカレンダー) 通知は黙って捨てる", async () => {
    const { sent, post } = setup();
    const response = await post(query, {
      value: [
        { clientState: graphClientState(key, accountId) },
        {
          clientState: microsoftCalendarClientState(key, accountId, accountId),
        },
        { clientState: "nope" },
      ],
    });
    expect(response.status).toBe(202);
    expect(sent).toEqual([]);
  });

  it("再認可と購読の削除の知らせでは、次の周回で延ばす・作り直すよう印を付ける", async () => {
    const { sent, updates, post } = setup();
    await post(query, {
      value: [{ clientState, lifecycleEvent: "reauthorizationRequired" }],
    });
    await post(query, {
      value: [{ clientState, lifecycleEvent: "subscriptionRemoved" }],
    });
    expect(updates).toEqual([
      { pushExpiresAt: null },
      { pushChannelId: null, pushExpiresAt: null },
    ]);
    expect(sent).toHaveLength(2);
  });

  it("ID の形が違う、本文が壊れている要求は 400", async () => {
    const { post } = setup();
    expect((await post("?account=x&calendar=y", { value: [] })).status).toBe(
      400,
    );
    expect((await post(query, "{")).status).toBe(400);
    expect((await post(query, { value: 1 })).status).toBe(400);
  });
});
