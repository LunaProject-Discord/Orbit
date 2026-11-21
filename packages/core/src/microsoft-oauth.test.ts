import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  loadMicrosoftOAuthConfig,
  MicrosoftOAuthError,
  openMicrosoftState,
  refreshMicrosoftToken,
} from "./microsoft-oauth.js";

const key = randomBytes(32);
const config = { clientId: "client", clientSecret: "secret", tenant: "common" };
const redirectUri = "http://localhost:3000/oauth/microsoft";

function authorize(userId = "user-1", now?: number) {
  return new URL(
    createMicrosoftAuthorizeUrl({
      config,
      redirectUri,
      userId,
      encryptionKey: key,
      ...(now === undefined ? {} : { now }),
    }),
  );
}

describe("loadMicrosoftOAuthConfig", () => {
  it("クライアント ID とシークレットが揃っていなければ無効にする", () => {
    expect(loadMicrosoftOAuthConfig({})).toBeNull();
    expect(loadMicrosoftOAuthConfig({ MICROSOFT_CLIENT_ID: "a" })).toBeNull();
    expect(
      loadMicrosoftOAuthConfig({
        MICROSOFT_CLIENT_ID: "a",
        MICROSOFT_CLIENT_SECRET: "b",
      }),
    ).toEqual({ clientId: "a", clientSecret: "b", tenant: "common" });
  });
});

describe("createMicrosoftAuthorizeUrl / openMicrosoftState", () => {
  it("PKCE と必要な権限を付けたログイン URL を作る", () => {
    const url = authorize();
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("offline_access");
    expect(scope).toContain("Mail.ReadWrite");

    const state = url.searchParams.get("state") ?? "";
    const opened = openMicrosoftState({
      state,
      userId: "user-1",
      encryptionKey: key,
    });
    expect(opened).not.toBeNull();
    expect(
      createHash("sha256")
        .update(opened?.verifier ?? "")
        .digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge"));
  });

  it("別の利用者が始めた state は受け付けない", () => {
    const state = authorize("user-1").searchParams.get("state") ?? "";
    expect(
      openMicrosoftState({ state, userId: "user-2", encryptionKey: key }),
    ).toBeNull();
  });

  it("期限切れ、改ざん、鍵違いの state は受け付けない", () => {
    const state = authorize("user-1", 1_000).searchParams.get("state") ?? "";
    expect(
      openMicrosoftState({
        state,
        userId: "user-1",
        encryptionKey: key,
        now: 1_000 + 11 * 60_000,
      }),
    ).toBeNull();
    expect(
      openMicrosoftState({
        state: state.replace(
          /[^:]+$/,
          Buffer.from("tampered").toString("base64"),
        ),
        userId: "user-1",
        encryptionKey: key,
        now: 1_000,
      }),
    ).toBeNull();
    expect(
      openMicrosoftState({
        state,
        userId: "user-1",
        encryptionKey: randomBytes(32),
        now: 1_000,
      }),
    ).toBeNull();
    expect(
      openMicrosoftState({ state: "", userId: "user-1", encryptionKey: key }),
    ).toBeNull();
  });
});

describe("トークンの取得", () => {
  it("認可コードを引き換える", async () => {
    let sent = new URLSearchParams();
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope: "Mail.ReadWrite",
      });
    }) as typeof fetch;
    const tokens = await exchangeMicrosoftCode(
      config,
      { code: "c", verifier: "v", redirectUri },
      fetchFn,
    );
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("v");
    expect(sent.get("client_secret")).toBe("secret");
  });

  it("リフレッシュトークンが失効していたら再ログインが必要と分かる", async () => {
    const fetchFn = (async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "AADSTS70008: expired.\r\nTrace ID: x",
        },
        { status: 400 },
      )) as typeof fetch;
    const error = await refreshMicrosoftToken(config, "rt", fetchFn).catch(
      (cause) => cause,
    );
    expect(error).toBeInstanceOf(MicrosoftOAuthError);
    expect((error as MicrosoftOAuthError).needsReauth).toBe(true);
    expect((error as MicrosoftOAuthError).message).toBe(
      "AADSTS70008: expired.",
    );
  });
});
