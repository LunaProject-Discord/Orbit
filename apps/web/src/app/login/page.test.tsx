// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/login/page";
import { ApiError, type AuthFeatures } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  features: null as AuthFeatures | null,
  signIn: vi.fn(),
}));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchAuthFeatures: async () => mocks.features,
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    signIn: mocks.signIn,
    verifyTwoFactor: vi.fn(),
    signInWithPasskey: vi.fn(),
  }),
}));

vi.mock("@/components/auth-shell", () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => (
    <a href={href as string} {...rest}>
      {children as React.ReactNode}
    </a>
  ),
}));

vi.mock("@/lib/passkey", () => ({
  PasskeyCancelled: class extends Error {},
  passkeySupported: () => false,
}));

vi.mock("@/lib/server-url", () => ({
  apiUrl: () => "http://localhost:8787",
  isBundledApp: () => false,
}));

vi.mock("@/lib/native/oauth", () => ({ usesAppOAuth: () => false }));

describe("ログイン画面", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render() {
    await act(async () => {
      root.render(<LoginPage />);
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.signIn.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("パスワードでのログインが使えれば、入力欄と再設定の案内を出す", async () => {
    mocks.features = { mail: true, sso: [], passwordLogin: true };
    await render();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).toContain("パスワードを忘れた場合");
  });

  it("管理者が止めていれば、入力欄と再設定の案内を出さず、IdP のボタンだけを出す", async () => {
    mocks.features = {
      mail: true,
      sso: [{ id: "p1", name: "Mailcow" }],
      passwordLogin: false,
    };
    await render();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).not.toContain("パスワードを忘れた場合");
    expect(container.textContent).not.toContain("または");
    expect(container.textContent).toContain("Mailcow でログイン");
  });

  it("ほかの方法もなければ、管理者に問い合わせるよう案内する", async () => {
    mocks.features = { mail: false, sso: [], passwordLogin: false };
    await render();
    expect(container.textContent).toContain("管理者にお問い合わせください");
  });

  it("無効にされたアカウントは、その旨を知らせる", async () => {
    mocks.features = { mail: false, sso: [], passwordLogin: true };
    mocks.signIn.mockRejectedValue(new ApiError(403, "USER_DISABLED", null));
    await render();
    const email = container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    const password = container.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    const setValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(email, "me@example.com");
      setValue(password, "password-password");
    });
    await act(async () => {
      (container.querySelector("form") as HTMLFormElement).requestSubmit();
    });
    expect(container.textContent).toContain("管理者によって無効にされています");
  });
});
