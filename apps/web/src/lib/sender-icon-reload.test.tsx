// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: { address: string; refresh: boolean }[] = [];
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchSenderIcon: vi.fn(
    async (
      address: string,
      _sources: unknown,
      options?: { refresh?: boolean },
    ) => {
      calls.push({ address, refresh: options?.refresh === true });
      return { blob: new Blob(["x"]), source: "favicon" };
    },
  ),
}));

const { reloadSenderIcons, useSenderIcon } = await import("./sender-icon");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const clean = { verified: false, warnings: [], claimed: null };

function Icon({ address }: { address: string }) {
  const icon = useSenderIcon(address, clean, true);
  return <span>{icon ? "icon" : "none"}</span>;
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  calls.length = 0;
});

describe("差出人のアイコンの取り直し", () => {
  it("更新すると、取得済みのアイコンを控えを使わずに取り直す", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Icon address="a@shop.example.com" />);
    });
    await flush();
    expect(calls).toEqual([{ address: "a@shop.example.com", refresh: false }]);
    expect(container.textContent).toBe("icon");

    // 表示し直しただけでは取り直さない。
    await act(async () => {
      root.render(<Icon address="a@shop.example.com" />);
    });
    await flush();
    expect(calls).toHaveLength(1);

    await act(async () => {
      reloadSenderIcons();
    });
    await flush();
    expect(calls).toEqual([
      { address: "a@shop.example.com", refresh: false },
      { address: "a@shop.example.com", refresh: true },
    ]);
    // 取り直している間も、前の画像を出し続ける。
    expect(container.textContent).toBe("icon");

    // 更新のあとに初めて表示する差出人は、控えを使う。
    await act(async () => {
      root.render(<Icon address="b@other.example.com" />);
    });
    await flush();
    expect(calls.at(-1)).toEqual({
      address: "b@other.example.com",
      refresh: false,
    });
    act(() => root.unmount());
  });
});
