// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipientInput } from "@/components/mail/recipient-input";
import type { Contact } from "@/lib/api";
import type { RecipientField } from "@/lib/compose";

const contact = (address: string, name: string | null): Contact => ({
  address,
  name,
  sentCount: 1,
  receivedCount: 0,
  lastAt: null,
  score: 1,
});

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  getToken: () => "token",
  getContacts: () =>
    Promise.resolve([
      contact("taro@example.com", "山田 太郎"),
      contact("tanaka@example.com", "田中"),
      contact("other@example.com", null),
    ]),
}));

describe("RecipientInput の候補", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: RecipientField;

  function Harness({ exclude }: { exclude?: string[] }) {
    const [value, setValue] = useState<RecipientField>({ list: [], text: "" });
    latest = value;
    return (
      <RecipientInput
        id="to"
        value={value}
        onChange={setValue}
        exclude={exclude}
      />
    );
  }

  const input = () => container.querySelector("input") as HTMLInputElement;
  const options = () =>
    Array.from(container.querySelectorAll('[role="option"]')).map(
      (element) => element.lastElementChild?.textContent,
    );

  async function type(text: string) {
    await act(async () => {
      input().focus();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function press(key: string) {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  }

  async function render(exclude?: string[]) {
    await act(async () => {
      root.render(<Harness exclude={exclude} />);
    });
    // 候補の取得を待つ。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("入力に合う相手を出し、Enter で先頭の候補を宛先にする", async () => {
    await render();
    await type("ta");
    expect(options()).toEqual([
      "山田 太郎taro@example.com",
      "田中tanaka@example.com",
    ]);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    await press("Enter");
    expect(latest.list).toEqual([
      { name: "山田 太郎", address: "taro@example.com" },
    ]);
    expect(latest.text).toBe("");
    expect(options()).toEqual([]);
  });

  it("矢印キーで選ぶ候補を変えられる", async () => {
    await render();
    await type("ta");
    await press("ArrowDown");
    await press("Tab");
    expect(latest.list.map((entry) => entry.address)).toEqual([
      "tanaka@example.com",
    ]);
  });

  it("Esc で閉じると、Enter は入力した文字列をそのまま確定する", async () => {
    await render();
    await type("ta@example.org");
    await type("ta");
    await press("Escape");
    expect(options()).toEqual([]);
    await type("ta@example.org");
    expect(options()).toEqual([]);
  });

  it("ほかの欄で選び済みのアドレスは出さない", async () => {
    await render(["TARO@example.com"]);
    await type("ta");
    expect(options()).toEqual(["田中tanaka@example.com"]);
  });
});
