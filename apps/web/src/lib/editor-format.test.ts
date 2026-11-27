// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeLineMarker,
  exitQuoteFromEmptyLine,
  indentLines,
  markerOf,
  normalizeColor,
  stripSentinel,
  toggleQuote,
} from "@/lib/editor-format";

function editorWith(html: string): HTMLDivElement {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.innerHTML = html;
  document.body.appendChild(editor);
  return editor;
}

/** text を含むテキストの、offset の位置にカーソルを置く (end があれば選ぶ)。 */
function select(
  editor: HTMLElement,
  text: string,
  offset = 0,
  end?: { text: string; offset: number },
) {
  const find = (value: string) => {
    const walker = document.createTreeWalker(editor, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue?.includes(value)) return node;
    }
    throw new Error(`見つかりません: ${value}`);
  };
  const range = document.createRange();
  range.setStart(find(text), offset);
  if (end) range.setEnd(find(end.text), end.offset);
  else range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("toggleQuote", () => {
  it("選んだ行をまとめて 1 つの引用にする", () => {
    const editor = editorWith("<div>一</div><div>二</div><div>三</div>");
    select(editor, "一", 0, { text: "二", offset: 1 });
    expect(toggleQuote(editor)).toBe(true);
    expect(editor.innerHTML).toBe(
      "<blockquote><div>一</div><div>二</div></blockquote><div>三</div>",
    );
  });

  it("引用の中で押すと、その引用を外す", () => {
    const editor = editorWith(
      "<div>前</div><blockquote><div>一</div><div>二</div></blockquote>",
    );
    select(editor, "二", 1);
    expect(toggleQuote(editor)).toBe(false);
    expect(editor.innerHTML).toBe("<div>前</div><div>一</div><div>二</div>");
  });

  it("返信の引用 (行のかたまりに入っていない文字) も外せる", () => {
    const editor = editorWith(
      "<div data-quote=''><div>日時</div><blockquote>本文<br>二行目</blockquote></div>",
    );
    select(editor, "本文", 1);
    toggleQuote(editor);
    expect(editor.querySelector("blockquote")).toBeNull();
    expect(editor.textContent).toBe("日時本文二行目");
    expect(editor.querySelectorAll("[data-quote] > div").length).toBe(3);
  });

  it("本文の直下の文字は、行に包んでから引用にする", () => {
    const editor = editorWith("一行目<br>二行目");
    select(editor, "一行目", 1);
    toggleQuote(editor);
    expect(editor.innerHTML).toBe(
      "<blockquote><div>一行目<br></div></blockquote><div>二行目</div>",
    );
  });

  it("箇条書きの中では、リスト全体を引用にする", () => {
    const editor = editorWith("<ul><li>a</li><li>b</li></ul><div>c</div>");
    select(editor, "b", 0);
    toggleQuote(editor);
    expect(editor.innerHTML).toBe(
      "<blockquote><ul><li>a</li><li>b</li></ul></blockquote><div>c</div>",
    );
  });
});

describe("indentLines", () => {
  it("1 段ずつ増やし、0 まで減らす", () => {
    const editor = editorWith("<div>一</div><div>二</div>");
    select(editor, "一", 0, { text: "二", offset: 1 });
    expect(indentLines(editor, 1)).toBe(true);
    indentLines(editor, 1);
    expect(editor.innerHTML).toBe(
      '<div style="margin-left: 80px;">一</div><div style="margin-left: 80px;">二</div>',
    );
    indentLines(editor, -1);
    indentLines(editor, -1);
    expect(editor.innerHTML).toBe("<div>一</div><div>二</div>");
    expect(indentLines(editor, -1)).toBe(false);
  });

  it("箇条書きの項目は扱わない (ブラウザーのリストの入れ子に任せる)", () => {
    const editor = editorWith("<ul><li>a</li></ul>");
    select(editor, "a", 0);
    expect(indentLines(editor, 1)).toBe(false);
  });
});

describe("行頭の記号", () => {
  it("見分ける", () => {
    expect(markerOf("> ")).toBe("quote");
    expect(markerOf("＞　")).toBe("quote");
    expect(markerOf("1. ")).toBe("orderedList");
    expect(markerOf("１． ")).toBe("orderedList");
    expect(markerOf("- ")).toBe("unorderedList");
    expect(markerOf("* ")).toBe("unorderedList");
    expect(markerOf("a> ")).toBeNull();
    expect(markerOf("2. ")).toBeNull();
  });

  it("「> 」を消して引用にする", () => {
    const editor = editorWith("<div>前</div><div>&gt; </div>");
    select(editor, "> ", 2);
    expect(consumeLineMarker(editor)).toBe("quote");
    expect(editor.innerHTML).toBe(
      "<div>前</div><blockquote><div><br></div></blockquote>",
    );
  });

  it("「- 」は記号だけ消し、リストにするのは呼び出し側に任せる", () => {
    const editor = editorWith("<div>- 続き</div>");
    select(editor, "- 続き", 2);
    expect(consumeLineMarker(editor)).toBe("unorderedList");
    expect(editor.innerHTML).toBe("<div>続き</div>");
  });

  it("行の途中の記号は変えない", () => {
    const editor = editorWith("<div>あ&gt; </div>");
    select(editor, "あ> ", 3);
    expect(consumeLineMarker(editor)).toBeNull();
    expect(editor.textContent).toBe("あ> ");
  });

  it("改行のあとの行頭も見る", () => {
    const editor = editorWith("<div>一<br>1. </div>");
    select(editor, "1. ", 3);
    expect(consumeLineMarker(editor)).toBe("orderedList");
    expect(editor.innerHTML).toBe("<div>一<br><br></div>");
  });
});

describe("stripSentinel", () => {
  it("目印の色だけを外し、空になった span は中身だけにする", () => {
    const editor = editorWith(
      '<div><span style="color: rgb(1, 2, 3);">a</span><span style="color: rgb(220, 38, 38); background-color: rgb(1, 2, 3);">b</span></div>',
    );
    stripSentinel(editor, "color", "#010203");
    expect(editor.innerHTML).toBe(
      '<div>a<span style="color: rgb(220, 38, 38); background-color: rgb(1, 2, 3);">b</span></div>',
    );
  });

  it("font 要素の大きさも外す", () => {
    const editor = editorWith('<div><font size="7">a</font></div>');
    stripSentinel(editor, "font-size", "xxx-large", {
      name: "size",
      value: "7",
    });
    expect(editor.innerHTML).toBe("<div>a</div>");
  });

  it("色の表記をそろえる", () => {
    expect(normalizeColor("#DC2626")).toBe("220,38,38");
    expect(normalizeColor("rgb(220, 38, 38)")).toBe("220,38,38");
  });
});

describe("exitQuoteFromEmptyLine", () => {
  it("引用の最後の空行を、引用の外へ出す", () => {
    const editor = editorWith(
      "<blockquote><div>一</div><div><br></div></blockquote>",
    );
    const empty = editor.querySelectorAll("blockquote > div")[1] as Node;
    const range = document.createRange();
    range.setStart(empty, 0);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(exitQuoteFromEmptyLine(editor)).toBe(true);
    expect(editor.innerHTML).toBe(
      "<blockquote><div>一</div></blockquote><div><br></div>",
    );
  });

  it("文字のある行や、途中の空行では何もしない", () => {
    const editor = editorWith(
      "<blockquote><div>一</div><div><br></div><div>三</div></blockquote>",
    );
    select(editor, "一", 1);
    expect(exitQuoteFromEmptyLine(editor)).toBe(false);
    const empty = editor.querySelectorAll("blockquote > div")[1] as Node;
    const range = document.createRange();
    range.setStart(empty, 0);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(exitQuoteFromEmptyLine(editor)).toBe(false);
  });
});
