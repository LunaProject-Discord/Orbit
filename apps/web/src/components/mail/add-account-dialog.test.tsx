// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import type {
  Account,
  CreateAccountInput,
  DiscoveredSettings,
} from "@/lib/api";

const mocks = vi.hoisted(() => ({
  calls: [] as CreateAccountInput[],
  /** true の間、許可の無い接続は「古い TLS のサーバー」として断る。 */
  legacyServer: true,
  /** 自動で見つかる設定。null なら見つからない。 */
  discovered: null as DiscoveredSettings | null,
  discoverCalls: [] as string[],
  oauth: [] as { provider: string; options: unknown }[],
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    startOAuthLogin: async (
      provider: string,
      _accountId: string | undefined,
      options: unknown,
    ) => {
      mocks.oauth.push({ provider, options });
      return "#oauth";
    },
    discoverAccountSettings: async (email: string) => {
      mocks.discoverCalls.push(email);
      return mocks.discovered;
    },
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
    mocks.discovered = null;
    mocks.discoverCalls.length = 0;
    created.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AddAccountDialog open onOpenChange={() => {}} onCreated={created} />,
      );
    });
    await type('input[type="email"]', "me@example.test");
    await submit();
    await type('input[type="password"]', "secret");
    // 設定が見つからないので、推し量った値の入った入力欄になる。
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("見つからなければ、ドメインから推し量った値で入力欄を出す", async () => {
    expect(mocks.discoverCalls).toEqual(["me@example.test"]);
    expect(
      query<HTMLInputElement>('input[placeholder="imap.example.com"]')?.value,
    ).toBe("imap.example.test");
    expect(
      query<HTMLInputElement>('input[placeholder="smtp.example.com"]')?.value,
    ).toBe("smtp.example.test");
    expect(document.body.textContent).toContain(
      "自動では見つけられませんでした",
    );
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

describe("AddAccountDialog の設定の自動検出", () => {
  let container: HTMLDivElement;
  let root: Root;
  const created = vi.fn();

  const button = (text: string) =>
    [...document.body.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(text),
    );

  async function type(selector: string, value: string) {
    const input = document.body.querySelector<HTMLInputElement>(selector);
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
      document.body
        .querySelector<HTMLFormElement>("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  }

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.calls.length = 0;
    mocks.legacyServer = false;
    mocks.discoverCalls.length = 0;
    mocks.discovered = {
      source: "autoconfig",
      provider: "generic",
      imap: {
        host: "imap.shin.example",
        port: 993,
        security: "ssl",
        username: "comugi@work.example",
        auth: "password",
      },
      smtp: {
        host: "smtp.shin.example",
        port: 587,
        security: "starttls",
        username: "comugi@work.example",
        auth: "password",
      },
    };
    created.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AddAccountDialog open onOpenChange={() => {}} onCreated={created} />,
      );
    });
    await type('input[type="email"]', "comugi@work.example");
    await submit();
    await type('input[type="password"]', "secret");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("見つかった設定を一覧で見せ、そのまま追加できる", async () => {
    const text = document.body.textContent ?? "";
    expect(text).toContain("アカウント設定が自動的に見つかりました");
    expect(text).toContain("imap.shin.example");
    expect(text).toContain("SSL/TLS");
    expect(text).toContain("STARTTLS");
    expect(text).toContain("通常のパスワード認証");
    // 一覧の段階では入力欄を出さない。
    expect(
      document.body.querySelector('input[placeholder="imap.example.com"]'),
    ).toBeNull();

    await submit();
    expect(mocks.calls).toEqual([
      {
        email: "comugi@work.example",
        provider: "generic",
        imap: { host: "imap.shin.example", port: 993, secure: true },
        smtp: { host: "smtp.shin.example", port: 587, secure: false },
        username: "comugi@work.example",
        password: "secret",
      },
    ]);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("「設定を編集」で見つかった値を手直しできる", async () => {
    await act(async () => {
      button("設定を編集")?.click();
    });
    const host = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="smtp.example.com"]',
    );
    expect(host?.value).toBe("smtp.shin.example");
    await type('input[placeholder="smtp.example.com"]', "mail.shin.example");
    await submit();
    expect(mocks.calls[0]?.smtp).toEqual({
      host: "mail.shin.example",
      port: 587,
      secure: false,
    });
  });

  it("戻って同じアドレスで進んでも、探し直さず手直しを残す", async () => {
    await act(async () => {
      button("設定を編集")?.click();
    });
    await type('input[placeholder="imap.example.com"]', "imap2.shin.example");
    await act(async () => {
      button("変更")?.click();
    });
    await submit();
    expect(mocks.discoverCalls).toHaveLength(1);
    await act(async () => {
      button("設定を編集")?.click();
    });
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[placeholder="imap.example.com"]',
      )?.value,
    ).toBe("imap2.shin.example");
  });
});

describe("AddAccountDialog の Google / Microsoft への振り分け", () => {
  let container: HTMLDivElement;
  let root: Root;

  const button = (text: string) =>
    [...document.body.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(text),
    );

  async function type(selector: string, value: string) {
    const input = document.body.querySelector<HTMLInputElement>(selector);
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

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.calls.length = 0;
    mocks.oauth.length = 0;
    mocks.legacyServer = false;
    mocks.discovered = {
      source: "mx",
      provider: "gmail",
      imap: {
        host: "imap.gmail.com",
        port: 993,
        security: "ssl",
        username: "me@corp.example",
        auth: "oauth2",
      },
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        security: "ssl",
        username: "me@corp.example",
        auth: "oauth2",
      },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AddAccountDialog open onOpenChange={() => {}} onCreated={() => {}} />,
      );
    });
    await type('input[placeholder="仕事、個人 など"]', "会社");
    await type('input[type="email"]', "me@corp.example");
    await act(async () => {
      document.body
        .querySelector<HTMLFormElement>("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("Gmail と分かったら、パスワードを聞かずに Google のログインへ進める", async () => {
    expect(document.body.querySelector('input[type="password"]')).toBeNull();
    await act(async () => {
      button("Google でログイン")?.click();
    });
    expect(mocks.oauth).toEqual([
      {
        provider: "google",
        options: { email: "me@corp.example", displayName: "会社" },
      },
    ]);
  });

  it("アプリ パスワードで追加することもできる", async () => {
    await act(async () => {
      button("アプリ パスワードで追加する")?.click();
    });
    await type('input[type="password"]', "abcd efgh ijkl mnop");
    await act(async () => {
      document.body
        .querySelector<HTMLFormElement>("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(mocks.calls[0]).toMatchObject({
      email: "me@corp.example",
      displayName: "会社",
      imap: { host: "imap.gmail.com", port: 993, secure: true },
      password: "abcdefghijklmnop",
    });
  });
});
