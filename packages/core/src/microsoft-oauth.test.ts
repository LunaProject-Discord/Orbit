import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  hasMicrosoftCalendarScope,
  loadMicrosoftOAuthConfig,
  MICROSOFT_CALENDAR_SCOPES,
  MICROSOFT_SCOPES,
  MicrosoftOAuthError,
  openMicrosoftState,
  refreshMicrosoftToken,
} from "./microsoft-oauth.js";

const key = randomBytes(32);
const config = { clientId: "client", clientSecret: "secret", tenant: "common" };
const redirectUri = "http://localhost:3000/oauth/microsoft";

function authorize(userId = "user-1", now?: number, calendar?: boolean) {
  return new URL(
    createMicrosoftAuthorizeUrl({
      config,
      redirectUri,
      userId,
      encryptionKey: key,
      ...(now === undefined ? {} : { now }),
      ...(calendar === undefined ? {} : { calendar }),
    }),
  );
}

/** 毎回変わる値 (state と PKCE) を除いた、ログイン URL の中身。 */
function stableParams(url: URL) {
  const params = new URLSearchParams(url.searchParams);
  params.delete("state");
  params.delete("code_challenge");
  return `${url.origin}${url.pathname}?${params.toString()}`;
}

/** 送った本文を記録し、トークンを返す fetch。 */
function recordingFetch() {
  const sent: URLSearchParams[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    sent.push(new URLSearchParams(String(init?.body)));
    return Response.json({
      access_token: "at",
      refresh_token: "rt2",
      expires_in: 3600,
      scope: "Mail.ReadWrite",
    });
  }) as typeof fetch;
  return { sent, fetchFn };
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

describe("カレンダーの権限", () => {
  it("calendar を指定しなければ、ログイン URL は今までと同じ", () => {
    const url = authorize();
    expect(url.searchParams.get("scope")).toBe(
      "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
    );
    expect(url.searchParams.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    expect([...url.searchParams.keys()]).toEqual([
      "client_id",
      "response_type",
      "response_mode",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "prompt",
    ]);
    expect(stableParams(authorize("user-1", undefined, false))).toBe(
      stableParams(url),
    );
    const opened = openMicrosoftState({
      state: url.searchParams.get("state") ?? "",
      userId: "user-1",
      encryptionKey: key,
    });
    expect(opened?.calendar).toBe(false);
  });

  it("calendar: true なら、メールの権限にカレンダーの権限を足し、state に残す", () => {
    const url = authorize("user-1", undefined, true);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      ...MICROSOFT_SCOPES,
      ...MICROSOFT_CALENDAR_SCOPES,
    ]);
    const opened = openMicrosoftState({
      state: url.searchParams.get("state") ?? "",
      userId: "user-1",
      encryptionKey: key,
    });
    expect(opened?.calendar).toBe(true);
  });

  it("カレンダーの権限があるかを、URL 付きでも名前だけでも見分ける", () => {
    expect(
      hasMicrosoftCalendarScope(
        "offline_access https://graph.microsoft.com/Calendars.ReadWrite",
      ),
    ).toBe(true);
    expect(
      hasMicrosoftCalendarScope("Mail.ReadWrite calendars.readwrite User.Read"),
    ).toBe(true);
    expect(hasMicrosoftCalendarScope("Calendars.Read Mail.ReadWrite")).toBe(
      false,
    );
    expect(hasMicrosoftCalendarScope(MICROSOFT_SCOPES.join(" "))).toBe(false);
    expect(hasMicrosoftCalendarScope("")).toBe(false);
  });

  it("トークンの更新は、既定ではメールの権限だけを求める (今までと同じ)", async () => {
    const { sent, fetchFn } = recordingFetch();
    const tokens = await refreshMicrosoftToken(config, "rt", fetchFn);
    expect(tokens.refreshToken).toBe("rt2");
    expect(sent[0]?.get("grant_type")).toBe("refresh_token");
    expect(sent[0]?.get("refresh_token")).toBe("rt");
    expect(sent[0]?.get("scope")).toBe(
      "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send",
    );
  });

  it("トークンの更新で求める権限を指定できる", async () => {
    const { sent, fetchFn } = recordingFetch();
    const scopes = [
      "offline_access",
      "https://graph.microsoft.com/User.Read",
      ...MICROSOFT_CALENDAR_SCOPES,
    ];
    await refreshMicrosoftToken(config, "rt", fetchFn, scopes);
    expect(sent[0]?.get("scope")).toBe(scopes.join(" "));
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
