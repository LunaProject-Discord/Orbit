import { describe, expect, it } from "vitest";
import {
  type CaptionArea,
  isWindowDragTarget,
  type RowBox,
  rowInsets,
} from "./title-bar-rows";

function el(tagName: string, attributes: Record<string, string> = {}) {
  return {
    nodeType: 1,
    tagName,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

describe("isWindowDragTarget", () => {
  const row = el("HEADER", { "data-titlebar": "" });

  it("上部の行の空き部分や見出しの文字はドラッグできる", () => {
    expect(isWindowDragTarget([row, el("MAIN")])).toBe(true);
    expect(isWindowDragTarget([el("H1"), row, el("MAIN")])).toBe(true);
    // document や window などの要素でないものは飛ばす。
    expect(isWindowDragTarget([{}, el("SPAN"), row, { nodeType: 9 }])).toBe(
      true,
    );
  });

  it("ボタン・入力欄・メニューなどの上ではドラッグしない", () => {
    expect(isWindowDragTarget([el("svg"), el("BUTTON"), row])).toBe(false);
    expect(isWindowDragTarget([el("INPUT"), row])).toBe(false);
    expect(isWindowDragTarget([el("A"), row])).toBe(false);
    expect(isWindowDragTarget([el("DIV"), el("SEARCH"), row])).toBe(false);
    expect(isWindowDragTarget([el("DIV", { role: "tab" }), row])).toBe(false);
    expect(isWindowDragTarget([el("DIV", { tabindex: "0" }), row])).toBe(false);
    expect(
      isWindowDragTarget([el("DIV", { contenteditable: "true" }), row]),
    ).toBe(false);
    expect(
      isWindowDragTarget([el("DIV", { "data-titlebar-nodrag": "" }), row]),
    ).toBe(false);
  });

  it("tabindex=-1 や contenteditable=false はドラッグを妨げない", () => {
    expect(isWindowDragTarget([el("DIV", { tabindex: "-1" }), row])).toBe(true);
    expect(
      isWindowDragTarget([el("DIV", { contenteditable: "false" }), row]),
    ).toBe(true);
  });

  it("上部の行の外や、行を止めたところではドラッグしない", () => {
    expect(isWindowDragTarget([el("DIV"), el("MAIN")])).toBe(false);
    expect(
      isWindowDragTarget([el("DIV", { "data-titlebar": "false" }), row]),
    ).toBe(false);
    expect(isWindowDragTarget([])).toBe(false);
  });
});

describe("rowInsets", () => {
  const box = (patch: Partial<RowBox>): RowBox => ({
    left: 0,
    right: 1280,
    top: 0,
    width: 1280,
    height: 56,
    paddingLeft: 16,
    paddingRight: 16,
    gap: 8,
    ...patch,
  });
  const windows: CaptionArea = {
    viewportWidth: 1280,
    reserveLeft: 0,
    reserveRight: 146,
    maxTop: 0,
  };
  const mac: CaptionArea = {
    viewportWidth: 1280,
    reserveLeft: 84,
    reserveRight: 0,
    maxTop: 0,
  };

  it("右端の行は、キャプションボタンにかかる分だけ末尾を空ける", () => {
    // 中身の右端 1264、ボタンの左端 1134 → 130 かかる。gap 8 の分を引いて 122。
    expect(rowInsets(box({}), windows)).toEqual({ start: null, end: 122 });
  });

  it("右端に届かない行 (3 列の左の列など) は空けない", () => {
    expect(
      rowInsets(box({ left: 256, right: 640, width: 384 }), windows),
    ).toEqual({ start: null, end: null });
  });

  it("macOS は左端の行の先頭に、信号機の分を空ける", () => {
    expect(rowInsets(box({}), mac)).toEqual({ start: 60, end: null });
    // 帯 (幅 48px) の右から始まる行は、はみ出した分だけ。
    expect(rowInsets(box({ left: 48, width: 1232 }), mac)).toEqual({
      start: 12,
      end: null,
    });
    // 少しだけかかるときは、gap だけで避けられるので幅 0 の余白を入れる。
    expect(rowInsets(box({ left: 64, width: 1216 }), mac)).toEqual({
      start: 0,
      end: null,
    });
    expect(rowInsets(box({ left: 256, width: 1024 }), mac)).toEqual({
      start: null,
      end: null,
    });
  });

  it("上端にない行や、見えていない行は空けない", () => {
    expect(rowInsets(box({ top: 300 }), windows)).toEqual({
      start: null,
      end: null,
    });
    expect(rowInsets(box({ width: 0, height: 0 }), windows)).toEqual({
      start: null,
      end: null,
    });
    // 引き出しが画面の外へ隠れているとき。
    expect(rowInsets(box({ left: -288, right: 0, width: 288 }), mac)).toEqual({
      start: null,
      end: null,
    });
  });

  it("細いタイトルバーの下にある行も、上端の行として扱う", () => {
    expect(rowInsets(box({ top: 32 }), { ...windows, maxTop: 32 })).toEqual({
      start: null,
      end: 122,
    });
  });
});
