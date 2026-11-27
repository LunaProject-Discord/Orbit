import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { conflictReason } from "@/lib/calendar/conflict-labels";
import {
  inviteFailureOf,
  OfflineCalendarClient,
} from "@/lib/calendar/offline/client";
import {
  CALENDAR_ID,
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";

/** 招待メールの送信の失敗 (invite_failed) の記録と「もう一度送る」(imip-design 6.5)。 */

const E1 = "00000000-0000-4000-8000-000000000e01";

async function open(server: FakeCalendarServer) {
  const client = await OfflineCalendarClient.open({
    userId: "u1",
    store: persistentStore(),
    api: server.api(),
    retryMs: 1000,
  });
  client.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await client.pull();
  await client.flush();
  return client;
}

const failure = (lost: unknown) => ({
  id: "k1",
  calendarId: CALENDAR_ID,
  eventId: E1,
  kind: "invite_failed" as const,
  fields: [],
  lost: lost as never,
  snapshot: null,
  title: "定例",
  reason: "招待メールを送れませんでした: 接続できません",
  createdAt: "2026-11-27T00:00:00.000Z",
  resolvedAt: null,
});

describe("invite_failed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lost は項目の値ではなく invite に移し、「もう一度送る」でサーバーに送り直しを頼む", async () => {
    const server = new FakeCalendarServer();
    server.conflicts = [
      failure({ outboxId: "o1", method: "CANCEL", to: ["a@example.com"] }),
    ];
    const client = await open(server);
    const [item] = client.conflicts();
    expect(item).toMatchObject({
      kind: "invite_failed",
      fields: [],
      lost: null,
      actions: ["resend", "dismiss"],
      invite: { outboxId: "o1", method: "CANCEL", to: ["a@example.com"] },
    });
    await client.resolveConflict("k1", "resend");
    expect(server.calls).toContain("resend k1");
    expect(server.calls).toContain("dismiss k1");
    expect(client.conflicts()).toEqual([]);
    expect(client.queue()).toEqual([]);
  });

  it("一部の宛先だけ送れなかった記録は「閉じる」だけ", async () => {
    const server = new FakeCalendarServer();
    server.conflicts = [
      failure({ method: "REQUEST", to: ["b@example.com"], partial: true }),
    ];
    const client = await open(server);
    expect(client.conflicts()[0]?.actions).toEqual(["dismiss"]);
  });

  it("サーバーが送り直せないとした記録 (resendable: false) も「閉じる」だけ", async () => {
    const server = new FakeCalendarServer();
    server.conflicts = [
      {
        ...failure({ method: "REQUEST", to: ["b@example.com"] }),
        resendable: false,
      },
    ];
    const client = await open(server);
    expect(client.conflicts()[0]?.actions).toEqual(["dismiss"]);
  });

  it("送信数の上限 (409 invite_limit) で断られた変更は、理由付きの反映されなかった変更になる", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const real = server.api();
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: {
        ...real,
        updateEvent: async () => {
          throw new ApiError(409, "invite_limit", null);
        },
      },
      retryMs: 1000,
    });
    client.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await client.pull();
    client.updateEvent(E1, { summary: "変更" });
    await client.flush();
    const [item] = client.conflicts();
    expect(item).toMatchObject({ kind: "failed", reason: "invite_limit" });
    expect(item?.actions).toEqual(["retry", "dismiss"]);
    expect(item && conflictReason(item)).toBe(
      "招待メールの送信数が上限に達しました。しばらくしてからもう一度保存してください",
    );
    expect(client.queue()[0]?.state).toBe("error");
  });

  it("形の違う lost は読める項目だけ拾う", () => {
    expect(inviteFailureOf(null)).toBeNull();
    expect(inviteFailureOf({ method: "PUBLISH", to: [1, "x@y"] })).toEqual({
      to: ["x@y"],
    });
  });
});
