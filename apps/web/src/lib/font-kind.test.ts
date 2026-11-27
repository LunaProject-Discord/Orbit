import { describe, expect, it } from "vitest";
import { fontKinds } from "./font-kind";

const kinds = (
  family: string,
  extra: {
    label?: string;
    monospace?: boolean | null;
    kind?: "sans" | "serif" | "script";
  } = {},
) =>
  [
    ...fontKinds({
      family,
      label: extra.label ?? family,
      monospace: extra.monospace ?? null,
      kind: extra.kind,
    }),
  ].sort();

describe("fontKinds", () => {
  it("名前からゴシック体を見分ける", () => {
    expect(kinds("Gen Interface JP")).toEqual(["sans"]);
    expect(kinds("Noto Sans JP")).toEqual(["sans"]);
    expect(kinds("Yu Gothic", { label: "游ゴシック" })).toEqual(["sans"]);
    expect(kinds("Meiryo")).toEqual(["sans"]);
    expect(kinds("FreeSans")).toEqual(["sans"]);
    expect(kinds("Hiragino Sans", { label: "ヒラギノ角ゴシック" })).toEqual([
      "sans",
    ]);
    expect(kinds("Microsoft Sans Serif")).toEqual(["sans"]);
    expect(kinds("Century Gothic")).toEqual(["sans"]);
  });

  it("名前から明朝体を見分ける", () => {
    expect(kinds("Noto Serif JP")).toEqual(["serif"]);
    expect(kinds("Yu Mincho", { label: "游明朝" })).toEqual(["serif"]);
    expect(kinds("BIZ UDMincho")).toEqual(["serif"]);
    expect(kinds("Times New Roman")).toEqual(["serif"]);
    expect(kinds("Georgia")).toEqual(["serif"]);
    expect(
      kinds("UD Digi Kyokasho N-R", { label: "UD デジタル 教科書体 N-R" }),
    ).toEqual(["serif"]);
  });

  it("等幅は、等幅の印か名前で見分ける", () => {
    expect(kinds("HackGen")).toEqual(["mono"]);
    expect(kinds("Consolas")).toEqual(["mono"]);
    expect(kinds("FreeMono")).toEqual(["mono"]);
    expect(kinds("Monotype Corsiva")).toEqual([]);
    expect(kinds("Noto Sans Mono CJK JP")).toEqual(["mono"]);
    expect(kinds("Something", { monospace: true })).toEqual(["mono"]);
    // MS ゴシックは等幅でもあり、ゴシック体でもある。
    expect(
      kinds("MS Gothic", { label: "ＭＳ ゴシック", monospace: true }),
    ).toEqual(["mono", "sans"]);
  });

  it("名前で分からなければ、フォントのファイルの分類を使う", () => {
    expect(kinds("Mystery", { kind: "serif" })).toEqual(["serif"]);
    expect(kinds("Mystery", { kind: "sans" })).toEqual(["sans"]);
    expect(kinds("Mystery", { kind: "script" })).toEqual([]);
    expect(kinds("Mystery")).toEqual([]);
  });

  it("絵文字や記号のフォントはどの種類にも入れない", () => {
    expect(kinds("Noto Color Emoji", { monospace: true })).toEqual([]);
    expect(kinds("Wingdings")).toEqual([]);
    expect(kinds("Mystery", { kind: "symbol" as "script" })).toEqual([]);
  });
});
