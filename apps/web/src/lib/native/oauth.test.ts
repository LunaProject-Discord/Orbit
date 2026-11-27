import { describe, expect, it } from "vitest";
import { appOAuthUrl, isAppOAuthReturn, routeForAppUrl } from "./oauth";

describe("isAppOAuthReturn", () => {
  it("state の目印で、アプリから始めたログインを見分ける", () => {
    expect(isAppOAuthReturn("?code=abc&state=app~xyz")).toBe(true);
    expect(isAppOAuthReturn("?code=abc&state=xyz")).toBe(false);
    expect(isAppOAuthReturn("?error=access_denied&state=app~xyz")).toBe(true);
    expect(isAppOAuthReturn("")).toBe(false);
  });
});

describe("appOAuthUrl", () => {
  it("Web 版へ戻ってきた内容を、そのままアプリ専用の URL に載せる", () => {
    expect(appOAuthUrl("google", "?code=a%2Fb&state=app~xyz")).toBe(
      "jp.lunaproject.orbit.mail://oauth/google?code=a%2Fb&state=app~xyz",
    );
    expect(appOAuthUrl("microsoft", "")).toBe(
      "jp.lunaproject.orbit.mail://oauth/microsoft",
    );
  });
});

describe("routeForAppUrl", () => {
  it("OAuth の戻りを、アプリの中の画面のパスに変える", () => {
    expect(
      routeForAppUrl(
        "jp.lunaproject.orbit.mail://oauth/google?code=a%2Fb&state=app~xyz",
      ),
    ).toBe("/oauth/google?code=a%2Fb&state=app~xyz");
    expect(
      routeForAppUrl("jp.lunaproject.orbit.mail://oauth/microsoft/?error=x"),
    ).toBe("/oauth/microsoft?error=x");
    expect(
      routeForAppUrl(
        "jp.lunaproject.orbit.mail://oauth/sso?code=c&state=app~s",
      ),
    ).toBe("/oauth/sso?code=c&state=app~s");
  });

  it("ほかの URL は無視する", () => {
    expect(
      routeForAppUrl("https://example.com/oauth/google?code=a"),
    ).toBeNull();
    expect(
      routeForAppUrl("jp.lunaproject.orbit.mail://oauth/evil?code=a"),
    ).toBeNull();
    expect(
      routeForAppUrl("jp.lunaproject.orbit.mail://settings/google"),
    ).toBeNull();
    expect(routeForAppUrl("not a url")).toBeNull();
  });
});
