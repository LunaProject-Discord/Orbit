import { describe, expect, it } from "vitest";
import { findFolded, foldForSearch, foldWithMap } from "./search-fold.js";

describe("foldForSearch", () => {
  it("全角英数・半角カナをそろえ、小文字にし、空白を除く", () => {
    expect(foldForSearch("ＡＢＣ　ｱﾏｿﾞﾝ\r\nHello World")).toBe(
      "abcアマゾンhelloworld",
    );
  });

  it("ゼロ幅の文字や制御文字も除く", () => {
    const zeroWidth = String.fromCodePoint(0x200b, 0xfeff, 0xad);
    expect(foldForSearch(`請${zeroWidth}求\u0001書`)).toBe("請求書");
  });
});

describe("findFolded", () => {
  it("そろえた文字で探し、元の文字列での範囲を返す", () => {
    const text = "今月分のご請求\r\n書をお送りします。";
    const found = findFolded(text, "請求書");
    expect(found).not.toBeNull();
    expect(text.slice(found?.start, found?.end)).toBe("請求\r\n書");
  });

  it("半角の濁点は前の文字とまとめて扱う", () => {
    const text = "ｱﾏｿﾞﾝで購入";
    const found = findFolded(text, "アマゾン");
    expect(text.slice(found?.start, found?.end)).toBe("ｱﾏｿﾞﾝ");
    expect(findFolded(text, "ソ")).toBeNull();
  });

  it("見つからなければ null", () => {
    expect(findFolded("件名", "本文")).toBeNull();
    expect(findFolded("件名", "  ")).toBeNull();
  });
});

describe("foldWithMap", () => {
  it("そろえた文字ごとに元の位置を持つ", () => {
    const mapped = foldWithMap("Ａ b");
    expect(mapped.folded).toBe("ab");
    expect(mapped.start).toEqual([0, 2]);
    expect(mapped.end).toEqual([1, 3]);
  });
});
