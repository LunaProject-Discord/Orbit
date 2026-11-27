// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountCalendarSetting } from "@/components/mail/account-calendar-setting";
import type { Account } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  patches: [] as { id: string; patch: unknown }[],
  /** true の間、カレンダーをオンにする変更を 409 consent_required で断る。 */
  consentRequired: true,
  oauth: [] as { provider: string; accountId?: string; options: unknown }[],
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    updateAccountFeatures: async (
      id: string,
      patch: { calendarEnabled?: boolean },
    ) => {
      mocks.patches.push({ id, patch });
      if (mocks.consentRequired && patch.calendarEnabled) {
        throw new actual.ApiError(409, "consent_required", {
          error: "consent_required",
        });
      }
      return { ...base, ...patch } as Account;
    },
    startOAuthLogin: async (
      provider: string,
      accountId: string | undefined,
      options: unknown,
    ) => {
      mocks.oauth.push({ provider, accountId, options });
      return "#oauth";
    },
  };
});

const base = {
  id: "account-1",
  email: "me@gmail.com",
  provider: "gmail",
  authType: "oauth2",
  protocol: "imap",
  calendarEnabled: false,
  calendarError: null,
  calendarConsent: "required",
} as unknown as Account;

describe("AccountCalendarSetting", () => {
  let container: HTMLDivElement;
  let root: Root;
  const updated = vi.fn();

  const calendarSwitch = () =>
    document.body.querySelector<HTMLElement>(
      '[role="switch"][aria-labelledby$="-calendar"]',
    );
  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );

  async function render(account: Account) {
    await act(async () => {
      root.render(
        <AccountCalendarSetting account={account} onUpdated={updated} />,
      );
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.patches.length = 0;
    mocks.oauth.length = 0;
    mocks.consentRequired = true;
    updated.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("権限が無ければ、確かめてからカレンダーの権限を足すログインへ進む", async () => {
    await render(base);
    await act(async () => {
      calendarSwitch()?.click();
    });
    expect(mocks.patches).toEqual([
      { id: "account-1", patch: { calendarEnabled: true } },
    ]);
    // 断られたら、画面の表示を元に戻す。
    expect(updated).toHaveBeenLastCalledWith(base);
    expect(document.body.textContent).toContain(
      "カレンダーの権限を追加するため、もう一度ログインします。",
    );
    await act(async () => {
      button("ログインする")?.click();
    });
    expect(mocks.oauth).toEqual([
      {
        provider: "google",
        accountId: "account-1",
        options: { calendar: true, returnTo: "/settings/common/accounts" },
      },
    ]);
  });

  it("権限があれば、そのままオンにする", async () => {
    mocks.consentRequired = false;
    await render({ ...base, calendarConsent: "granted" });
    await act(async () => {
      calendarSwitch()?.click();
    });
    expect(mocks.oauth).toEqual([]);
    expect(updated).toHaveBeenLastCalledWith(
      expect.objectContaining({ calendarEnabled: true }),
    );
  });

  it("カレンダーの仕組みが無いアカウントでは、切り替えを止めて理由を出す", async () => {
    await render({
      ...base,
      provider: "generic",
      authType: "password",
      calendarConsent: "not_applicable",
    });
    expect(calendarSwitch()?.hasAttribute("data-disabled")).toBe(true);
    expect(document.body.textContent).toContain(
      "Orbit から使えるカレンダーがありません",
    );
  });

  it("CalDAV の出どころがあれば、オフになっていてもオンに戻せる", async () => {
    mocks.consentRequired = false;
    await render({
      ...base,
      provider: "generic",
      authType: "password",
      calendarConsent: "not_applicable",
      hasCalendarSource: true,
    });
    expect(calendarSwitch()?.hasAttribute("data-disabled")).toBe(false);
    expect(document.body.textContent).not.toContain(
      "Orbit から使えるカレンダーがありません",
    );
    await act(async () => {
      calendarSwitch()?.click();
    });
    expect(updated).toHaveBeenLastCalledWith(
      expect.objectContaining({ calendarEnabled: true }),
    );
  });

  it("古いサーバー (hasCalendarSource なし) では、カレンダーを使っているかで推し量る", async () => {
    await render({
      ...base,
      provider: "generic",
      authType: "password",
      calendarConsent: "not_applicable",
      calendarEnabled: true,
    });
    expect(calendarSwitch()?.hasAttribute("data-disabled")).toBe(false);
  });

  it("同期に失敗していれば、その理由を出す", async () => {
    await render({
      ...base,
      calendarEnabled: true,
      calendarConsent: "granted",
      calendarError: "トークンが無効です",
    });
    expect(document.body.textContent).toContain(
      "カレンダーを同期できません: トークンが無効です",
    );
  });

  it("古いサーバー (項目なし) では出さない", async () => {
    await render({ ...base, calendarConsent: undefined });
    expect(calendarSwitch()).toBeNull();
  });
});
