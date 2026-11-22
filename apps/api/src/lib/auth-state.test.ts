import { describe, expect, it } from "vitest";
import {
  AUTH_STATE_HEADER,
  authStateFromSetCookies,
  authStateToCookie,
  withAuthStateCookie,
  withAuthStateHeader,
} from "./auth-state.js";

describe("authStateToCookie", () => {
  it("名前と値の組を Cookie の形にする", () => {
    expect(
      authStateToCookie(
        "better-auth.two_factor=2fa-abc.sig%3D; __Secure-better-auth.trust_device=t!id.sig",
      ),
    ).toBe(
      "better-auth.two_factor=2fa-abc.sig%3D; __Secure-better-auth.trust_device=t!id.sig",
    );
  });

  it("セッションの Cookie は通さない", () => {
    expect(
      authStateToCookie(
        "better-auth.session_token=abc.def; better-auth.two_factor=x",
      ),
    ).toBe("better-auth.two_factor=x");
    expect(authStateToCookie("__Secure-better-auth.session_data=abc")).toBe(
      null,
    );
  });

  it("形のおかしいものは捨てる", () => {
    expect(authStateToCookie(null)).toBe(null);
    expect(authStateToCookie("")).toBe(null);
    expect(authStateToCookie("novalue; =x; a b=c; ok=1")).toBe("ok=1");
    expect(authStateToCookie('a="quoted, value"')).toBe(null);
    expect(authStateToCookie(`a=${"x".repeat(5000)}`)).toBe(null);
  });
});

describe("authStateFromSetCookies", () => {
  it("値と期限を取り出し、セッションの Cookie は除く", () => {
    expect(
      authStateFromSetCookies([
        "better-auth.two_factor=2fa-abc.sig%3D; Max-Age=600; Path=/; HttpOnly; SameSite=Lax",
        "better-auth.session_token=secret.sig; Max-Age=604800; Path=/; HttpOnly",
        "better-auth.better-auth-passkey=token.sig; Path=/",
      ]),
    ).toEqual({
      "better-auth.two_factor": { value: "2fa-abc.sig%3D", maxAge: 600 },
      "better-auth.better-auth-passkey": { value: "token.sig", maxAge: null },
    });
  });

  it("消す指示 (Max-Age=0 や過去の Expires) は、空の値と 0 以下の期限にする", () => {
    const state = authStateFromSetCookies([
      "better-auth.two_factor=; Max-Age=0; Path=/",
      "better-auth.trust_device=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
    ]);
    expect(state["better-auth.two_factor"]).toEqual({ value: "", maxAge: 0 });
    expect(state["better-auth.trust_device"]?.value).toBe("");
    expect(state["better-auth.trust_device"]?.maxAge).toBeLessThan(0);
  });
});

describe("withAuthStateCookie", () => {
  it("ヘッダーを Cookie に写し、ブラウザーが付けた Cookie は使わない", () => {
    const request = withAuthStateCookie(
      new Request("http://localhost/v1/auth/x", {
        headers: {
          Cookie: "better-auth.session_token=from-browser",
          [AUTH_STATE_HEADER]: "better-auth.two_factor=abc",
        },
      }),
    );
    expect(request.headers.get("Cookie")).toBe("better-auth.two_factor=abc");
    expect(request.headers.get(AUTH_STATE_HEADER)).toBe(null);
  });

  it("ヘッダーが無ければ Cookie も無い", () => {
    const request = withAuthStateCookie(
      new Request("http://localhost/v1/auth/x", {
        headers: { Cookie: "better-auth.session_token=from-browser" },
      }),
    );
    expect(request.headers.get("Cookie")).toBe(null);
  });
});

describe("withAuthStateHeader", () => {
  it("Set-Cookie をヘッダーに写して、Set-Cookie は返さない", async () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", "better-auth.two_factor=abc; Max-Age=600");
    headers.append("Set-Cookie", "better-auth.session_token=s; Max-Age=10");
    const response = withAuthStateHeader(
      new Response('{"ok":true}', { status: 200, headers }),
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(JSON.parse(response.headers.get(AUTH_STATE_HEADER) ?? "")).toEqual({
      "better-auth.two_factor": { value: "abc", maxAge: 600 },
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("Set-Cookie が無ければ、そのまま返す", () => {
    const response = new Response("x");
    expect(withAuthStateHeader(response)).toBe(response);
  });
});
