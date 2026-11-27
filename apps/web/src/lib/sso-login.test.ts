// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  completeSsoLink,
  completeSsoLogin,
  getToken,
  pendingSsoMode,
  startSsoLink,
  startSsoLogin,
} from "./api";

vi.mock("@/lib/native/oauth", async (original) => ({
  ...(await original<typeof import("@/lib/native/oauth")>()),
  usesAppOAuth: () => false,
}));

type Call = { url: string; body: Record<string, unknown> };

describe("IdP (シングルサインオン) でのログイン", () => {
  let calls: Call[];
  let respond: () => Response;

  beforeEach(() => {
    calls = [];
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return respond();
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("始めた端末だけが合言葉を持ち、戻ってきたときに送って捨てる", async () => {
    respond = () => Response.json({ url: "https://idp.example.com/auth" });
    const url = await startSsoLogin("019aa0c2-7b3e-7c11-9d2f-0123456789ab");
    expect(url).toBe("https://idp.example.com/auth");
    const binding = calls[0]?.body.binding as string;
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls[0]?.body.app).toBeUndefined();

    respond = () =>
      new Response(
        JSON.stringify({
          twoFactorRedirect: false,
          created: true,
          suggestMailAccount: true,
          email: "me@example.com",
        }),
        { headers: { "set-auth-token": "token-1" } },
      );
    const result = await completeSsoLogin("code", "state");
    expect(calls[1]?.url).toMatch(/\/v1\/auth\/sso\/callback$/);
    expect(calls[1]?.body).toEqual({ code: "code", state: "state", binding });
    expect(result).toEqual({
      twoFactor: false,
      created: true,
      suggestMailAccount: true,
      email: "me@example.com",
    });
    expect(getToken()).toBe("token-1");

    // 合言葉は 1 回で捨てるので、同じ戻りをもう一度使えない。
    await expect(completeSsoLogin("code", "state")).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(calls).toHaveLength(2);
  });

  it("ほかの端末で始めたログイン (合言葉がない) は、サーバーへ送らずに断る", async () => {
    respond = () => Response.json({});
    await expect(completeSsoLogin("code", "state")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(calls).toHaveLength(0);
  });

  it("結び付けで始めた合言葉は、ログインには使えない (始めた方でだけ使う)", async () => {
    respond = () => Response.json({ url: "https://idp.example.com/auth" });
    await startSsoLink("019aa0c2-7b3e-7c11-9d2f-0123456789ab");
    expect(calls[0]?.url).toMatch(/\/v1\/security\/sso\/link$/);
    expect(pendingSsoMode()).toBe("link");
    await expect(completeSsoLogin("code", "state")).rejects.toMatchObject({
      code: "invalid_state",
    });
    // 一度取り出したら消える。
    expect(pendingSsoMode()).toBeNull();
    await expect(completeSsoLink("code", "state")).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(calls).toHaveLength(1);
  });
});
