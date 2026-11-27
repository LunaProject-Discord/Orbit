// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SearchField,
  type SearchFieldVariant,
} from "@/components/search-field";

describe("SearchField (Mail と同じ枠の検索欄)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSubmit = vi.fn();
  const onClose = vi.fn();

  function Harness({ variant }: { variant: SearchFieldVariant }) {
    const [value, setValue] = useState("");
    return (
      <SearchField
        variant={variant}
        label="予定を検索"
        placeholder="検索"
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    );
  }

  const input = () =>
    container.querySelector(
      'input[aria-label="予定を検索"]',
    ) as HTMLInputElement;
  const type = async (text: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = async (name: string) => {
    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true }),
      );
    });
  };
  const render = async (variant: SearchFieldVariant) => {
    await act(async () => root.render(<Harness variant={variant} />));
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    onSubmit.mockClear();
    onClose.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("ブラウザーの消すボタンではなく、自前の「入力をクリア」を出す", async () => {
    await render("popup");
    expect(input().type).toBe("text");
    expect(container.querySelector('[aria-label="入力をクリア"]')).toBeNull();
    await type("会議");
    const clear = container.querySelector(
      '[aria-label="入力をクリア"]',
    ) as HTMLButtonElement;
    expect(clear).not.toBeNull();
    await act(async () => clear.click());
    expect(input().value).toBe("");
  });

  it("Enter で探す", async () => {
    await render("popup");
    await type("会議");
    await act(async () => {
      input().form?.requestSubmit();
    });
    expect(onSubmit).toHaveBeenCalledWith("会議");
  });

  it("Esc は入力を消し、空なら検索画面を閉じる (screen)", async () => {
    await render("screen");
    await type("会議");
    await key("Escape");
    expect(input().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    await key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("screen は左端に「←」を出し、押すと閉じる", async () => {
    await render("screen");
    const back = container.querySelector(
      '[aria-label="検索を閉じる"]',
    ) as HTMLButtonElement;
    await act(async () => back.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
