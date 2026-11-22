// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import type { Account, CreateAccountInput } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  calls: [] as CreateAccountInput[],
  /** true の間、許可の無い接続は「古い TLS のサーバー」として断る。 */
  legacyServer: true,
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    createAccount: async (input: CreateAccountInput) => {
      mocks.calls.push(input);
      if (mocks.legacyServer && !input.allowLegacyTls) {
        throw new actual.ApiError(422, "legacy_tls_required", {
          error: "legacy_tls_required",
        });
      }
      return { id: "account-1", email: input.email } as unknown as Account;
    },
  };
});

describe("AddAccountDialog の古い TLS のサーバー", () => {
  let container: HTMLDivElement;
  let root: Root;
  const created = vi.fn();

  const query = <T extends Element>(selector: string) =>
    document.body.querySelector<T>(selector);
  const button = (text: string) =>
    [...document.body.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(text),
    );
  const legacySwitch = () => query<HTMLElement>('[role="switch"]');

  async function type(selector: string, value: string) {
    const input = query<HTMLInputElement>(selector);
    if (!input) throw new Error(`入力欄が見つかりません: ${selector}`);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submit() {
    await act(async () => {
      query<HTMLFormElement>("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  }

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.calls.length = 0;
    mocks.legacyServer = true;
    created.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AddAccountDialog open onOpenChange={() => {}} onCreated={created} />,
      );
    });
    await act(async () => {
      button("その他のメール")?.click();
    });
    await type('input[type="email"]', "me@example.test");
    await type('input[type="password"]', "secret");
    await type('input[placeholder="imap.example.com"]', "imap.example.test");
    await type('input[placeholder="smtp.example.com"]', "smtp.example.test");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("はじめは許可のスイッチを出さず、許可も送らない", async () => {
    expect(legacySwitch()).toBeNull();
    mocks.legacyServer = false;
    await submit();
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]).not.toHaveProperty("allowLegacyTls");
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("古い TLS のサーバーだと分かったら、許可してから追加できる", async () => {
    await submit();
    expect(created).not.toHaveBeenCalled();
    expect(query('[role="alert"]')?.textContent).toContain("古い方式の TLS");
    const toggle = legacySwitch();
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    // 許可しないまま送り直しても、許可は送らない。
    await submit();
    expect(mocks.calls[1]).not.toHaveProperty("allowLegacyTls");

    await act(async () => {
      legacySwitch()?.click();
    });
    await submit();
    expect(mocks.calls[2]).toMatchObject({
      allowLegacyTls: true,
      imap: { host: "imap.example.test" },
    });
    expect(created).toHaveBeenCalledTimes(1);
  });
});
