// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  isScroller,
  SCROLLBAR_HIDDEN_ATTRIBUTE,
} from "@/lib/overlay-scrollbars";

function scroller(style: string): HTMLDivElement {
  const element = document.createElement("div");
  element.setAttribute("style", style);
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("isScroller", () => {
  it("ブラウザーのバーを隠すために scrollbar-width: none になっていても、重ねるバーの対象にする", () => {
    // 重ねるバーが有効な間は、globals.css がすべてのスクロール領域をこの状態にする。
    expect(
      isScroller(scroller("overflow-y: auto; scrollbar-width: none")),
    ).toBe(true);
  });

  it("バーをわざと隠す属性が付いた領域は対象にしない", () => {
    const element = scroller("overflow-x: auto");
    element.setAttribute(SCROLLBAR_HIDDEN_ATTRIBUTE, "");
    expect(isScroller(element)).toBe(false);
  });

  it("スクロールしない要素と、ダイアログの中は対象にしない", () => {
    expect(isScroller(scroller("overflow: hidden"))).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("div");
    inner.setAttribute("style", "overflow-y: auto");
    dialog.append(inner);
    document.body.append(dialog);
    expect(isScroller(inner)).toBe(false);
  });
});
