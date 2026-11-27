import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(
  () => [] as { path: string; method?: string; body?: unknown }[],
);
const responder = vi.hoisted(() => ({
  next: null as null | ((body: unknown) => unknown),
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: async (
      path: string,
      options: { method?: string; body?: unknown } = {},
    ) => {
      calls.push({ path, method: options.method, body: options.body });
      const result = responder.next?.(options.body) ?? { event: { id: "e" } };
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result));
    },
  };
});

const { ApiError } = await import("@/lib/api");
const api = await import("@/lib/calendar/api");

const input = {
  id: "00000000-0000-4000-8000-000000000e01",
  calendarId: "00000000-0000-4000-8000-0000000000c1",
  time: {
    allDay: true as const,
    startDate: "2026-03-01",
    endDate: "2026-03-02",
  },
};

describe("calendar api (オフライン用の時刻)", () => {
  beforeEach(() => {
    calls.length = 0;
    responder.next = null;
  });

  it("PATCH には項目ごとの時刻と clientNow を添える", async () => {
    const now = new Date("2026-01-01T01:00:00Z");
    await api.updateEvent(
      "e1",
      { summary: "A" },
      { summary: "2026-01-01T00:00:00.000Z" },
      now,
    );
    expect(calls[0]?.body).toEqual({
      changes: { summary: "A" },
      changedAt: { summary: "2026-01-01T00:00:00.000Z" },
      clientNow: "2026-01-01T01:00:00.000Z",
    });
  });

  it("DELETE に deletedAt と clientNow を本文で渡す。渡さなければ本文なし", async () => {
    await api.deleteEvent("e1", {
      deletedAt: "2026-01-01T00:00:00.000Z",
      clientNow: new Date("2026-01-01T01:00:00Z"),
    });
    await api.deleteEvent("e2");
    expect(calls.map((c) => c.body)).toEqual([
      {
        deletedAt: "2026-01-01T00:00:00.000Z",
        clientNow: "2026-01-01T01:00:00.000Z",
      },
      undefined,
    ]);
  });

  it("作成の時刻を断る古いサーバー (コード無しの 400) には、時刻を外して送り直す", async () => {
    responder.next = (body) =>
      (body as Record<string, unknown>).changedAt
        ? new ApiError(400, null, { success: false })
        : { event: { id: "e" } };
    await api.createEvent(input, {
      changedAt: "2026-01-01T00:00:00.000Z",
      clientNow: new Date("2026-01-01T01:00:00Z"),
    });
    expect(calls.map((c) => Object.keys(c.body as object).sort())).toEqual([
      ["calendarId", "changedAt", "clientNow", "id", "time"],
      ["calendarId", "id", "time"],
    ]);
    // 以後は最初から付けない。
    calls.length = 0;
    await api.createEvent(input, { changedAt: "2026-01-01T00:00:00.000Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).not.toHaveProperty("changedAt");
  });
});
