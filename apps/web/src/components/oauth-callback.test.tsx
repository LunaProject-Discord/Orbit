// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthCallback } from "@/components/oauth-callback";
import type { OAuthLoginResult } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  result: null as unknown as OAuthLoginResult,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => (
    <a href={href as string} {...rest}>
      {children as React.ReactNode}
    </a>
  ),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ status: "signed-in" }),
}));

vi.mock("@/lib/native/oauth", () => ({
  appOAuthUrl: () => "",
  isAppOAuthReturn: () => false,
  usesAppOAuth: () => false,
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, completeOAuthLogin: async () => mocks.result };
});

const result = (overrides: Partial<OAuthLoginResult>): OAuthLoginResult => ({
  account: { id: "account-1" } as OAuthLoginResult["account"],
  calendarRequested: false,
  reauth: true,
  calendarGranted: true,
  calendarDisabled: false,
  returnTo: "/settings/accounts",
  ...overrides,
});

describe("OAuthCallback", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render() {
    await act(async () => {
      root.render(<OAuthCallback provider="google" />);
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.replace.mockClear();
    window.history.replaceState(null, "", "/oauth/google?code=c&state=s");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("再ログインでカレンダーの権限が外されたら、カレンダーをオフにしたことを知らせる", async () => {
    mocks.result = result({
      calendarRequested: true,
      calendarGranted: false,
      calendarDisabled: true,
    });
    await render();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "カレンダーの権限が外されたので、カレンダーをオフにしました",
    );
  });

  it("カレンダーを求めて許可されなかったら、使わないままであることを知らせる", async () => {
    mocks.result = result({ calendarRequested: true, calendarGranted: false });
    await render();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("カレンダーは使わないままです");
  });

  it("カレンダーを求めていなければ、そのまま戻り先へ進む", async () => {
    mocks.result = result({ calendarGranted: false });
    await render();
    expect(mocks.replace).toHaveBeenCalledWith("/settings/accounts");
  });
});
