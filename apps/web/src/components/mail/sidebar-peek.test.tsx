// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarPeek } from "@/components/mail/sidebar-rail";
import { PEEK_CLOSE_DELAY, PEEK_OPEN_DELAY } from "@/lib/sidebar-fold";

/** mail-app と同じく、aside の中に帯の項目を置き、広げているかを属性で出す。 */
function Harness() {
  const asideRef = useRef<HTMLElement>(null);
  const peek = useSidebarPeek(asideRef, true);
  return (
    <>
      <aside ref={asideRef} data-peek={peek ? "on" : "off"}>
        <button type="button">受信トレイ</button>
      </aside>
      <main>一覧</main>
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

function aside(): HTMLElement {
  const element = container.querySelector("aside");
  if (!element) throw new Error("aside is not shown");
  return element;
}

function peeking(): boolean {
  return aside().dataset.peek === "on";
}

function pointer(
  target: Element,
  type: "pointerenter" | "pointermove" | "pointerleave",
  x: number,
  pointerType = "mouse",
) {
  const event = new MouseEvent(type, {
    bubbles: type === "pointermove",
    clientX: x,
    clientY: 100,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    target.dispatchEvent(event);
  });
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("useSidebarPeek", () => {
  it("帯の項目に乗せただけでは広げない", () => {
    pointer(aside(), "pointerenter", 24);
    pointer(aside(), "pointermove", 20);
    wait(PEEK_OPEN_DELAY * 5);
    expect(peeking()).toBe(false);
  });

  it("ウィンドウの左端に寄せると広げ、離れると戻す", () => {
    pointer(aside(), "pointerenter", 30);
    pointer(aside(), "pointermove", 3);
    wait(PEEK_OPEN_DELAY);
    expect(peeking()).toBe(true);
    // 広げたサイドバーの中で動かしている間はそのまま。
    pointer(aside(), "pointermove", 200);
    wait(PEEK_CLOSE_DELAY * 2);
    expect(peeking()).toBe(true);
    pointer(aside(), "pointerleave", 300);
    wait(PEEK_CLOSE_DELAY);
    expect(peeking()).toBe(false);
  });

  it("左端から外の項目へすぐ戻したら広げない", () => {
    pointer(aside(), "pointerenter", 0);
    pointer(aside(), "pointermove", 20);
    wait(PEEK_OPEN_DELAY * 2);
    expect(peeking()).toBe(false);
  });

  it("左端から入ってきたときも広げる", () => {
    pointer(aside(), "pointerenter", 0);
    wait(PEEK_OPEN_DELAY);
    expect(peeking()).toBe(true);
  });

  it("タッチでは項目を押しても広げず、空いている所を押すと広げる", () => {
    const button = aside().querySelector("button");
    if (!button) throw new Error("button is not shown");
    act(() => {
      button.click();
    });
    expect(peeking()).toBe(false);
    act(() => {
      aside().click();
    });
    expect(peeking()).toBe(true);
  });
});
