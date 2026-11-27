// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsoCallback } from "@/components/sso-callback";
import { ApiError, type SsoLoginResult } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  assign: vi.fn(),
  completeSso: vi.fn(),
  completeSsoLink: vi.fn(),
  mode: null as "login" | "link" | null,
  status: "signed-out" as string,
  appReturn: false,
}));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  completeSsoLink: mocks.completeSsoLink,
  pendingSsoMode: () => mocks.mode,
}));

vi.mock("@/components/mail/toasts", () => ({ showNotice: () => {} }));

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
  useAuth: () => ({ status: mocks.status, completeSso: mocks.completeSso }),
}));

vi.mock("@/components/mail/add-account-dialog", () => ({
  AddAccountDialog: () => null,
}));

vi.mock("@/lib/native/oauth", () => ({
  appOAuthUrl: (provider: string, search: string) =>
    `jp.lunaproject.orbit.mail://oauth/${provider}${search}`,
  isAppOAuthReturn: () => mocks.appReturn,
  usesAppOAuth: () => false,
}));

const result = (overrides: Partial<SsoLoginResult>): SsoLoginResult => ({
  twoFactor: false,
  created: false,
  suggestMailAccount: false,
  email: "me@example.com",
  ...overrides,
});

describe("SsoCallback", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(url = "/oauth/sso?code=c&state=s") {
    window.history.replaceState(null, "", url);
    await act(async () => {
      root.render(<SsoCallback />);
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.replace.mockClear();
    mocks.completeSso.mockReset();
    mocks.appReturn = false;
    mocks.mode = null;
    mocks.status = "signed-out";
    mocks.completeSsoLink.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("code と state でログインし、受信トレイへ移る (URL から code を消す)", async () => {
    mocks.completeSso.mockResolvedValue(result({}));
    await render();
    expect(mocks.completeSso).toHaveBeenCalledTimes(1);
    expect(mocks.completeSso).toHaveBeenCalledWith("c", "s");
    expect(window.location.search).toBe("");
    expect(mocks.replace).toHaveBeenCalledWith("/");
  });

  it("2 段階認証が要れば、ログイン画面のコードの入力へ移る", async () => {
    mocks.completeSso.mockResolvedValue(result({ twoFactor: true }));
    await render();
    expect(mocks.replace).toHaveBeenCalledWith("/login?step=two-factor");
  });

  it("作ったばかりの利用者には、メールアカウントの追加を案内する", async () => {
    mocks.completeSso.mockResolvedValue(
      result({ created: true, suggestMailAccount: true }),
    );
    await render();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("メールアカウントを追加");
  });

  it("サーバーが断った理由を知らせる", async () => {
    mocks.completeSso.mockRejectedValue(
      new ApiError(403, "sign_up_disabled", null),
    );
    await render();
    expect(document.body.textContent).toContain(
      "Orbit のアカウントを新しく作れません",
    );
  });

  it("IdP のログインが取り消されたら、サーバーには送らない", async () => {
    await render("/oauth/sso?error=access_denied&state=s");
    expect(mocks.completeSso).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("ログインが取り消されました");
  });

  it("アプリから始めたログインは、ブラウザーではログインせずアプリへ引き渡す", async () => {
    mocks.appReturn = true;
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    await render("/oauth/sso?code=c&state=app~s");
    expect(mocks.completeSso).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(
      "jp.lunaproject.orbit.mail://oauth/sso?code=c&state=app~s",
    );
    assign.mockRestore();
  });

  it("設定画面から始めた結び付けは、ログイン中の利用者に結び付けて設定へ戻る", async () => {
    mocks.mode = "link";
    mocks.status = "signed-in";
    mocks.completeSsoLink.mockResolvedValue({ name: "Mailcow" });
    await render();
    expect(mocks.completeSso).not.toHaveBeenCalled();
    expect(mocks.completeSsoLink).toHaveBeenCalledWith("c", "s");
    expect(mocks.replace).toHaveBeenCalledWith("/settings/security");
  });

  it("結び付けの途中でログインが切れていたら、送らずに知らせる", async () => {
    mocks.mode = "link";
    mocks.status = "signed-out";
    await render();
    expect(mocks.completeSsoLink).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("結び付けられませんでした");
  });
});
