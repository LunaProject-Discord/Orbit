import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGoogleAuthorizeUrl,
  exchangeGoogleCode,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_SCOPES,
  GoogleAccessTokenSource,
  GoogleOAuthError,
  hasGmailScope,
  hasGoogleCalendarScope,
  loadGoogleOAuthConfig,
  openGoogleState,
  refreshGoogleToken,
} from "./google-oauth.js";
import { providerOfImapHost } from "./mail-providers.js";

const key = randomBytes(32);
const config = { clientId: "client", clientSecret: "secret" };
const redirectUri = "http://localhost:3000/oauth/google";

function authorize(userId = "user-1", now?: number, calendar?: boolean) {
  return new URL(
    createGoogleAuthorizeUrl({
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("loadGoogleOAuthConfig", () => {
  it("クライアント ID とシークレットが揃っていなければ無効にする", () => {
    expect(loadGoogleOAuthConfig({})).toBeNull();
    expect(loadGoogleOAuthConfig({ GOOGLE_CLIENT_ID: "a" })).toBeNull();
    expect(
      loadGoogleOAuthConfig({
        GOOGLE_CLIENT_ID: " a ",
        GOOGLE_CLIENT_SECRET: "b",
      }),
    ).toEqual({ clientId: "a", clientSecret: "b" });
  });
});

describe("createGoogleAuthorizeUrl / openGoogleState", () => {
  it("PKCE を付け、リフレッシュトークンが返るログイン URL を作る", () => {
    const url = authorize();
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toContain(
      "https://mail.google.com/",
    );

    const opened = openGoogleState({
      state: url.searchParams.get("state") ?? "",
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

  it("別の利用者、期限切れ、改ざんされた state は受け付けない", () => {
    const state = authorize("user-1", 1_000).searchParams.get("state") ?? "";
    const open = (userId: string, now: number, value = state) =>
      openGoogleState({ state: value, userId, encryptionKey: key, now });
    expect(open("user-1", 2_000)).not.toBeNull();
    expect(open("user-2", 2_000)).toBeNull();
    expect(open("user-1", 1_000 + 11 * 60_000)).toBeNull();
    expect(open("user-1", 2_000, `${state.slice(0, -2)}AA`)).toBeNull();
    expect(open("user-1", 2_000, "x")).toBeNull();
  });
});

describe("カレンダーの権限", () => {
  it("calendar を指定しなければ、ログイン URL は今までと同じ", () => {
    const url = authorize();
    expect(url.searchParams.get("scope")).toBe(
      "openid email https://mail.google.com/",
    );
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect([...url.searchParams.keys()]).toEqual([
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "access_type",
      "prompt",
    ]);
    expect(stableParams(authorize("user-1", undefined, false))).toBe(
      stableParams(url),
    );
    const opened = openGoogleState({
      state: url.searchParams.get("state") ?? "",
      userId: "user-1",
      encryptionKey: key,
    });
    expect(opened?.calendar).toBe(false);
  });

  it("calendar: true なら、メールの権限にカレンダーの権限を足し、state に残す", () => {
    const url = authorize("user-1", undefined, true);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      ...GOOGLE_SCOPES,
      ...GOOGLE_CALENDAR_SCOPES,
    ]);
    const opened = openGoogleState({
      state: url.searchParams.get("state") ?? "",
      userId: "user-1",
      encryptionKey: key,
    });
    expect(opened?.calendar).toBe(true);
    expect(
      createHash("sha256")
        .update(opened?.verifier ?? "")
        .digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge"));
  });

  it("カレンダーの権限が揃っているかを見分ける", () => {
    expect(hasGoogleCalendarScope(GOOGLE_CALENDAR_SCOPES.join(" "))).toBe(true);
    expect(
      hasGoogleCalendarScope(
        `openid https://mail.google.com/ ${GOOGLE_CALENDAR_SCOPES.join(" ")}`,
      ),
    ).toBe(true);
    expect(
      hasGoogleCalendarScope("https://www.googleapis.com/auth/calendar email"),
    ).toBe(true);
    // 同意画面で一部だけ外された。
    expect(
      hasGoogleCalendarScope(
        "openid https://www.googleapis.com/auth/calendar.events",
      ),
    ).toBe(false);
    expect(
      hasGoogleCalendarScope("openid email https://mail.google.com/"),
    ).toBe(false);
    expect(hasGoogleCalendarScope("")).toBe(false);
  });
});

describe("トークンの取得", () => {
  it("認可コードを PKCE の検証値と一緒に送る", async () => {
    let sent = new URLSearchParams();
    const tokens = await exchangeGoogleCode(
      config,
      { code: "code-1", verifier: "verifier-1", redirectUri },
      async (_url, init) => {
        sent = new URLSearchParams(String(init?.body));
        return jsonResponse({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3599,
          scope: "openid https://mail.google.com/",
        });
      },
    );
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("verifier-1");
    expect(sent.get("client_secret")).toBe("secret");
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(hasGmailScope(tokens.scope)).toBe(true);
  });

  it("取り消されたリフレッシュトークンは再ログインが必要と判定する", async () => {
    const error = await refreshGoogleToken(config, "rt", async () =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
        400,
      ),
    ).catch((cause) => cause);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(error.needsReauth).toBe(true);
    expect(error.message).toBe("Token has been expired or revoked.");
  });

  it("一時的な失敗は再ログインを求めない", async () => {
    const error = await refreshGoogleToken(config, "rt", async () =>
      jsonResponse({ error: "internal_failure" }, 500),
    ).catch((cause) => cause);
    expect(error.needsReauth).toBe(false);
  });

  it("Gmail の権限が外されたかどうかを見分ける", () => {
    expect(hasGmailScope("openid email")).toBe(false);
    expect(
      hasGmailScope("https://www.googleapis.com/auth/userinfo.email openid"),
    ).toBe(false);
  });
});

describe("GoogleAccessTokenSource", () => {
  function source() {
    let calls = 0;
    const tokens = new GoogleAccessTokenSource(config, "rt", async () => {
      calls++;
      return jsonResponse({ access_token: `at-${calls}`, expires_in: 3600 });
    });
    return { tokens, calls: () => calls };
  }

  it("期限が近づくまで同じトークンを使い回す", async () => {
    const { tokens, calls } = source();
    const now = Date.now();
    expect(await tokens.get(now)).toBe("at-1");
    expect(await tokens.get(now + 50 * 60_000)).toBe("at-1");
    expect(await tokens.get(now + 56 * 60_000)).toBe("at-2");
    expect(calls()).toBe(2);
  });

  it("同時に求められても取得は 1 回にまとめる", async () => {
    const { tokens, calls } = source();
    expect(await Promise.all([tokens.get(), tokens.get()])).toEqual([
      "at-1",
      "at-1",
    ]);
    expect(calls()).toBe(1);
  });

  it("拒否されたトークンを捨て、取得した直後だったかを返す", async () => {
    const { tokens } = source();
    const now = Date.now();
    await tokens.get(now);
    expect(tokens.invalidate(now + 10_000)).toBe(false);
    await tokens.get(now);
    expect(tokens.invalidate(now + 30 * 60_000)).toBe(true);
    expect(await tokens.get(now + 30 * 60_000)).toBe("at-3");
  });
});

describe("providerOfImapHost", () => {
  it("ホスト名からサービスを判別する", () => {
    expect(providerOfImapHost("IMAP.gmail.com")).toBe("gmail");
    expect(providerOfImapHost("imap.mail.me.com.")).toBe("icloud");
    expect(providerOfImapHost("imap.example.com")).toBeNull();
  });
});
