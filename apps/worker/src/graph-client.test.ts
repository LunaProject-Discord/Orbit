import { describe, expect, it } from "vitest";
import { GraphClient, GraphError } from "./graph-client.js";

type Call = { url: string; headers: Record<string, string> };

function setup(responses: Response[]) {
  const calls: Call[] = [];
  const tokens: boolean[] = [];
  const waits: number[] = [];
  let issued = 0;
  const client = new GraphClient({
    getToken: async (force) => {
      tokens.push(force);
      if (force || issued === 0) issued++;
      return `token-${issued}`;
    },
    fetchFn: (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
      });
      const response = responses.shift();
      if (!response) throw new Error("応答が足りません");
      return response;
    }) as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { client, calls, tokens, waits };
}

describe("GraphClient", () => {
  it("トークンと不変 ID の指定を付けて呼び出す", async () => {
    const { client, calls } = setup([Response.json({ value: [1] })]);
    expect(await client.get("/me/mailFolders")).toEqual({ value: [1] });
    expect(calls[0]?.url).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders",
    );
    expect(calls[0]?.headers.Authorization).toBe("Bearer token-1");
    expect(calls[0]?.headers.Prefer).toContain('IdType="ImmutableId"');
  });

  it("401 ならトークンを取り直して 1 回だけやり直す", async () => {
    const { client, calls, tokens } = setup([
      new Response(null, { status: 401 }),
      Response.json({ ok: true }),
    ]);
    expect(await client.get("/me")).toEqual({ ok: true });
    expect(tokens).toEqual([false, true, false]);
    expect(calls[1]?.headers.Authorization).toBe("Bearer token-2");

    const again = setup([
      new Response(null, { status: 401 }),
      Response.json(
        { error: { code: "InvalidAuthenticationToken", message: "x" } },
        { status: 401 },
      ),
    ]);
    await expect(again.client.get("/me")).rejects.toMatchObject({
      status: 401,
      code: "InvalidAuthenticationToken",
    });
  });

  it("制限 (429) は Retry-After の時間だけ待ってやり直す", async () => {
    const { client, waits } = setup([
      new Response(null, { status: 429, headers: { "Retry-After": "7" } }),
      new Response(null, { status: 503 }),
      Response.json({ ok: true }),
    ]);
    expect(await client.get("/me")).toEqual({ ok: true });
    expect(waits).toEqual([7_000, 4_000]);
  });

  it("再試行しても直らなければエラーにする", async () => {
    const { client, calls } = setup(
      Array.from({ length: 4 }, () => new Response(null, { status: 429 })),
    );
    await expect(client.get("/me")).rejects.toBeInstanceOf(GraphError);
    expect(calls).toHaveLength(4);
  });

  it("差分取得の続きが無効になったことを判別できる", async () => {
    const { client } = setup([
      Response.json(
        { error: { code: "SyncStateNotFound", message: "gone" } },
        { status: 410 },
      ),
    ]);
    const error = await client.get("/me").catch((cause) => cause);
    expect((error as GraphError).syncStateInvalid).toBe(true);
    expect((error as GraphError).notFound).toBe(false);
  });

  it("Graph 以外の URL にはトークンを送らない", async () => {
    const { client, calls } = setup([]);
    await expect(
      client.get("https://graph.microsoft.com.example.com/v1.0/me"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
