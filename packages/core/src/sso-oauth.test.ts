import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildSsoAuthorizeUrl,
  createPkce,
  discoverSsoEndpoints,
  exchangeSsoCode,
  fetchSsoProfile,
  isUsableSsoUrl,
  openSsoState,
  parseSsoProfile,
  readSsoClaim,
  type SsoClient,
  SsoError,
  sealSsoState,
  ssoBindingHash,
  ssoEmailDomainAllowed,
} from "./sso-oauth.js";

const key = randomBytes(32);

const client: SsoClient = {
  clientId: "orbit",
  clientSecret: "s3cret:&",
  scopes: ["profile"],
  tokenAuthMethod: "client_secret_basic",
  usePkce: true,
  subjectClaim: "sub",
  emailClaim: "email",
  nameClaim: "name",
  endpoints: {
    authorizationUrl: "https://mail.example.com/oauth/authorize?lang=ja",
    tokenUrl: "https://mail.example.com/oauth/token",
    userInfoUrl: "https://mail.example.com/oauth/profile",
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("isUsableSsoUrl", () => {
  it("https だけを受け付ける", () => {
    expect(
      isUsableSsoUrl("https://idp.example.com/x", { allowHttp: false }),
    ).toBe(true);
    expect(
      isUsableSsoUrl("http://idp.example.com/x", { allowHttp: false }),
    ).toBe(false);
    expect(isUsableSsoUrl("http://localhost:8080/x", { allowHttp: true })).toBe(
      true,
    );
    expect(isUsableSsoUrl("javascript:alert(1)", { allowHttp: true })).toBe(
      false,
    );
    expect(isUsableSsoUrl("not a url", { allowHttp: true })).toBe(false);
    expect(
      isUsableSsoUrl("https://user:pass@idp.example.com/", {
        allowHttp: false,
      }),
    ).toBe(false);
  });
});

describe("state", () => {
  const base = {
    provider: "p1",
    verifier: "v",
    binding: ssoBindingHash("device-secret"),
    mode: "login" as const,
    expiresAt: 2_000,
  };

  it("同じ端末の合言葉なら開ける", () => {
    const sealed = sealSsoState(base, key);
    expect(openSsoState(sealed, "device-secret", key, 1_000)).toEqual(base);
  });

  it("別の端末・期限切れ・改ざん・別の鍵は null", () => {
    const sealed = sealSsoState(base, key);
    expect(openSsoState(sealed, "other", key, 1_000)).toBeNull();
    expect(openSsoState(sealed, "device-secret", key, 3_000)).toBeNull();
    const parts = sealed.split(":");
    const body = Buffer.from(parts[3] ?? "", "base64");
    body[0] = (body[0] ?? 0) ^ 1;
    parts[3] = body.toString("base64");
    expect(
      openSsoState(parts.join(":"), "device-secret", key, 1_000),
    ).toBeNull();
    expect(
      openSsoState(sealed, "device-secret", randomBytes(32), 1_000),
    ).toBeNull();
    expect(openSsoState("garbage", "device-secret", key, 1_000)).toBeNull();
  });
});

describe("buildSsoAuthorizeUrl", () => {
  it("必要な値を付け、元のクエリは残す", () => {
    const { challenge } = createPkce();
    const url = new URL(
      buildSsoAuthorizeUrl({
        client,
        redirectUri: "https://orbit.example.com/oauth/sso",
        state: "st",
        challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://mail.example.com/oauth/authorize",
    );
    expect(url.searchParams.get("lang")).toBe("ja");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("orbit");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://orbit.example.com/oauth/sso",
    );
    expect(url.searchParams.get("scope")).toBe("profile");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("PKCE を使わないときは challenge を付けない", () => {
    const url = new URL(
      buildSsoAuthorizeUrl({
        client,
        redirectUri: "https://orbit.example.com/oauth/sso",
        state: "st",
        challenge: null,
      }),
    );
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });
});

describe("exchangeSsoCode", () => {
  it("client_secret_basic ではヘッダーで送る", async () => {
    const fetchFn = vi.fn(async () => json({ access_token: "at" }));
    const result = await exchangeSsoCode({
      client,
      code: "c",
      redirectUri: "https://orbit.example.com/oauth/sso",
      verifier: "ver",
      fetchFn,
    });
    expect(result).toEqual({ accessToken: "at" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://mail.example.com/oauth/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("orbit:s3cret%3A%26").toString("base64")}`,
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get("code")).toBe("c");
    expect(body.get("code_verifier")).toBe("ver");
    expect(body.has("client_secret")).toBe(false);
    expect(init.redirect).toBe("error");
  });

  it("client_secret_post では本文で送る", async () => {
    const fetchFn = vi.fn(async () => json({ access_token: "at" }));
    await exchangeSsoCode({
      client: { ...client, tokenAuthMethod: "client_secret_post" },
      code: "c",
      redirectUri: "r",
      verifier: null,
      fetchFn,
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get("client_id")).toBe("orbit");
    expect(body.get("client_secret")).toBe("s3cret:&");
    expect(body.has("code_verifier")).toBe(false);
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("失敗は token_failed", async () => {
    const fetchFn = vi.fn(async () =>
      json({ error: "invalid_grant", error_description: "expired" }, 400),
    );
    await expect(
      exchangeSsoCode({
        client,
        code: "c",
        redirectUri: "r",
        verifier: null,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "token_failed" });
  });
});

describe("profile", () => {
  it("入れ子の項目と数値の ID を読む", () => {
    expect(readSsoClaim({ a: { b: "x" } }, "a.b")).toBe("x");
    expect(readSsoClaim({ a: "x" }, "a.b")).toBeUndefined();
    expect(readSsoClaim({}, "__proto__")).toBeUndefined();
    expect(
      parseSsoProfile(
        { id: 42, email: " Taro@Example.COM ", full_name: "太郎" },
        { subjectClaim: "id", emailClaim: "email", nameClaim: "full_name" },
      ),
    ).toEqual({ subject: "42", email: "taro@example.com", name: "太郎" });
  });

  it("ID が無ければ no_subject、メールアドレスらしくない値は null", () => {
    expect(() => parseSsoProfile({ email: "a@b.c" }, client)).toThrowError(
      SsoError,
    );
    expect(
      parseSsoProfile(
        { sub: "x", email: "not-an-email", name: "\u0000" },
        client,
      ),
    ).toEqual({ subject: "x", email: null, name: null });
  });

  it("アクセストークンをヘッダーで送る", async () => {
    const fetchFn = vi.fn(async () => json({ sub: "u1", email: "a@b.jp" }));
    const profile = await fetchSsoProfile({
      client,
      accessToken: "at",
      fetchFn,
    });
    expect(profile).toEqual({ subject: "u1", email: "a@b.jp", name: null });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer at",
    );
  });

  it("エラー応答は profile_failed", async () => {
    const fetchFn = vi.fn(async () => json({ error: "nope" }, 401));
    await expect(
      fetchSsoProfile({ client, accessToken: "at", fetchFn }),
    ).rejects.toMatchObject({ code: "profile_failed" });
  });
});

describe("discoverSsoEndpoints", () => {
  it("3 つの URL を読む", async () => {
    const fetchFn = vi.fn(async () =>
      json({
        authorization_endpoint: "https://idp/a",
        token_endpoint: "https://idp/t",
        userinfo_endpoint: "https://idp/u",
      }),
    );
    await expect(
      discoverSsoEndpoints("https://idp/.well-known/openid-configuration", {
        allowHttp: false,
        fetchFn,
      }),
    ).resolves.toEqual({
      authorizationUrl: "https://idp/a",
      tokenUrl: "https://idp/t",
      userInfoUrl: "https://idp/u",
    });
  });

  it("足りないか http の URL は discovery_failed", async () => {
    const fetchFn = vi.fn(async () =>
      json({
        authorization_endpoint: "http://idp/a",
        token_endpoint: "https://idp/t",
        userinfo_endpoint: "https://idp/u",
      }),
    );
    await expect(
      discoverSsoEndpoints("https://idp/x", { allowHttp: false, fetchFn }),
    ).rejects.toMatchObject({ code: "discovery_failed" });
  });
});

describe("ssoEmailDomainAllowed", () => {
  it("空なら全部、指定があれば完全一致 (大文字小文字は無視)", () => {
    expect(ssoEmailDomainAllowed("a@x.jp", [])).toBe(true);
    expect(ssoEmailDomainAllowed("a@X.jp", ["x.jp"])).toBe(true);
    expect(ssoEmailDomainAllowed("a@sub.x.jp", ["x.jp"])).toBe(false);
    expect(ssoEmailDomainAllowed("a@x.jp.evil", ["x.jp"])).toBe(false);
  });
});
