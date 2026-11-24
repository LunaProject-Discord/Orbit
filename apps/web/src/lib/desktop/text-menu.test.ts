// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTextMenu,
  describeTextMenuTarget,
  setTextMenuOpener,
  textMenuItems,
} from "@/lib/desktop/text-menu";

const noLink = () => null;

afterEach(() => {
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
  setTextMenuOpener(null);
});

function selectText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("describeTextMenuTarget / textMenuItems", () => {
  it("何も選んでいない文字の上では、何も出さない", () => {
    document.body.innerHTML = "<p>本文</p>";
    const target = describeTextMenuTarget(
      document.querySelector("p"),
      document,
      noLink,
    );
    expect(textMenuItems(target)).toEqual([]);
  });

  it("文字を選んでいれば、コピーを出す (文字そのものを右クリックしても同じ)", () => {
    document.body.innerHTML = "<p>選んだ文字</p>";
    const p = document.querySelector("p") as HTMLElement;
    selectText(p);
    const target = describeTextMenuTarget(
      p.firstChild as Text,
      document,
      noLink,
    );
    expect(target.selectedText).toBe("選んだ文字");
    expect(textMenuItems(target)).toEqual(["copy"]);
  });

  it("入力欄では、編集の項目を出し、選んでいた範囲を覚える", () => {
    document.body.innerHTML = '<input type="text" value="abcdef" />';
    const input = document.querySelector("input") as HTMLInputElement;
    input.setSelectionRange(1, 4);
    const target = describeTextMenuTarget(input, document, noLink);
    expect(target.selectedText).toBe("bcd");
    expect(target.editable?.range).toEqual({ start: 1, end: 4 });
    expect(textMenuItems(target)).toEqual([
      "undo",
      "redo",
      null,
      "cut",
      "copy",
      "paste",
      null,
      "selectAll",
      null,
      "emoji",
    ]);
  });

  it("読み取り専用の欄では、コピーとすべて選択だけ", () => {
    document.body.innerHTML = "<textarea readonly>abc</textarea>";
    const target = describeTextMenuTarget(
      document.querySelector("textarea"),
      document,
      noLink,
    );
    expect(textMenuItems(target)).toEqual(["copy", null, "selectAll"]);
  });

  it("パスワードの欄の文字はコピーさせない", () => {
    document.body.innerHTML = '<input type="password" value="secret" />';
    const input = document.querySelector("input") as HTMLInputElement;
    input.setSelectionRange(0, 6);
    const target = describeTextMenuTarget(input, document, noLink);
    expect(target.selectedText).toBe("");
  });

  it("チェックボックスなどは入力欄として扱わない", () => {
    document.body.innerHTML = '<input type="checkbox" />';
    const target = describeTextMenuTarget(
      document.querySelector("input"),
      document,
      noLink,
    );
    expect(target.editable).toBeNull();
    expect(textMenuItems(target)).toEqual([]);
  });

  it("contenteditable の中は入力欄として扱う", () => {
    document.body.innerHTML =
      '<div contenteditable="true"><p><b>太字</b></p></div>';
    const target = describeTextMenuTarget(
      document.querySelector("b"),
      document,
      noLink,
    );
    expect(target.editable?.element).toBe(
      document.querySelector("[contenteditable]"),
    );
  });

  it("リンクの上では、開く・アドレスをコピーを出す", () => {
    document.body.innerHTML = '<a href="https://example.com/">リンク</a>';
    const target = describeTextMenuTarget(
      document.querySelector("a"),
      document,
      () => "https://example.com/",
    );
    expect(textMenuItems(target)).toEqual(["openLink", "copyLink"]);
  });
});

describe("attachTextMenu", () => {
  function rightClick(target: Element) {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
    });
    target.dispatchEvent(event);
    return event;
  }

  it("標準のメニューを止め、出す項目があればメニューを開く", () => {
    document.body.innerHTML = "<p>文字</p><input type='text' />";
    const open = vi.fn();
    setTextMenuOpener(open);
    const detach = attachTextMenu(document, noLink);

    const plain = rightClick(document.querySelector("p") as Element);
    expect(plain.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();

    rightClick(document.querySelector("input") as Element);
    expect(open).toHaveBeenCalledWith(expect.anything(), 10, 20);
    detach();
  });

  it("ほかのメニューが受け取った右クリックには何もしない", () => {
    document.body.innerHTML = "<input type='text' />";
    const input = document.querySelector("input") as HTMLInputElement;
    input.addEventListener("contextmenu", (event) => event.preventDefault());
    const open = vi.fn();
    setTextMenuOpener(open);
    const detach = attachTextMenu(document, noLink);
    rightClick(input);
    expect(open).not.toHaveBeenCalled();
    detach();
  });
});
