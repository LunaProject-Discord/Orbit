import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import data from "./data.json";
import {
  buildEmojiCatalog,
  type EmojiData,
  isEmojiIcon,
  searchEmojis,
  withSkinTone,
} from "./emoji";

const catalog = buildEmojiCatalog(data as unknown as EmojiData);

describe("生成した絵文字のデータ", () => {
  it("入っている emojibase-data と同じ版から作られている", () => {
    // 失敗したら `pnpm --filter @mail/web emoji:generate` で作り直す。
    const { version } = JSON.parse(
      readFileSync(
        createRequire(import.meta.url).resolve("emojibase-data/package.json"),
        "utf8",
      ),
    );
    expect(data.version).toBe(version);
  });

  it("9 つの分類に、すべての絵文字が入っている", () => {
    expect(catalog.groups.map((group) => group.key)).toEqual([
      "smileys-emotion",
      "people-body",
      "animals-nature",
      "food-drink",
      "travel-places",
      "activities",
      "objects",
      "symbols",
      "flags",
    ]);
    const total = catalog.groups.reduce(
      (sum, group) => sum + group.emojis.length,
      0,
    );
    expect(total).toBe(catalog.entries.size);
    expect(total).toBeGreaterThan(1800);
    for (const group of catalog.groups) {
      expect(group.emojis.length, group.key).toBeGreaterThan(0);
    }
  });

  it("肌の色を変えられる絵文字は、5 色を持つ", () => {
    for (const entry of catalog.entries.values()) {
      expect([0, 5], entry.emoji).toContain(entry.skins.length);
    }
    expect(catalog.entries.get("👋")?.skins).toHaveLength(5);
  });
});

describe("searchEmojis", () => {
  it("日本語の名前や語で探せる", () => {
    expect(searchEmojis(catalog, "手を振る")[0]).toBe("👋");
    // ひらがなでもカタカナでも探せる。
    expect(searchEmojis(catalog, "ねこ")).toContain("🐈");
    expect(searchEmojis(catalog, "ネコ")).toContain("🐈");
    expect(searchEmojis(catalog, "家")).toContain("🏠");
    expect(searchEmojis(catalog, "メール")).toContain("📧");
  });

  it("英語でも探せる (語の先頭から合うものだけ)", () => {
    expect(searchEmojis(catalog, "rocket")[0]).toBe("🚀");
    expect(searchEmojis(catalog, "Smile")).toContain("😀");
    // location などの途中の cat には合わせない。
    expect(searchEmojis(catalog, "cat")).toContain("🐈");
    expect(searchEmojis(catalog, "cat")).not.toContain("📍");
  });

  it("絵文字そのものでも探せる", () => {
    expect(searchEmojis(catalog, "🚀")[0]).toBe("🚀");
  });

  it("空の言葉や、合うものが無い言葉では何も返さない", () => {
    expect(searchEmojis(catalog, " ")).toEqual([]);
    expect(searchEmojis(catalog, "zzzzqqqq")).toEqual([]);
  });
});

describe("buildEmojiCatalog", () => {
  it("指定した版より新しい絵文字を除く", () => {
    const old = buildEmojiCatalog(data as unknown as EmojiData, 12);
    expect(old.entries.size).toBeGreaterThan(1000);
    expect(old.entries.size).toBeLessThan(catalog.entries.size);
    expect(old.entries.has("😀")).toBe(true);
    // 🫠 は 14.0 で加わった。
    expect(catalog.entries.has("🫠")).toBe(true);
    expect(old.entries.has("🫠")).toBe(false);
    expect(
      old.groups.reduce((sum, group) => sum + group.emojis.length, 0),
    ).toBe(old.entries.size);
  });
});

describe("withSkinTone", () => {
  it("色を変えられる絵文字だけ、指定の色にする", () => {
    expect(withSkinTone(catalog, "👋", 0)).toBe("👋");
    expect(withSkinTone(catalog, "👋", 1)).toBe("👋🏻");
    expect(withSkinTone(catalog, "👋", 5)).toBe("👋🏿");
    expect(withSkinTone(catalog, "🚀", 3)).toBe("🚀");
    expect(catalog.bases.get("👋🏿")).toBe("👋");
  });
});

describe("isEmojiIcon", () => {
  it("アイコンの名前と絵文字を見分ける", () => {
    expect(isEmojiIcon("house")).toBe(false);
    expect(isEmojiIcon("gamepad-2")).toBe(false);
    expect(isEmojiIcon("🏠")).toBe(true);
    expect(isEmojiIcon("1️⃣")).toBe(true);
    expect(isEmojiIcon("🇯🇵")).toBe(true);
  });
});
