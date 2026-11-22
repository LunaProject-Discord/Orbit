import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIconCatalog,
  type IconMeta,
  JAPANESE_WORDS,
  searchIcons,
} from "./catalog";
import meta from "./meta.json";
import nodes from "./nodes.json";

const catalog = buildIconCatalog(meta as unknown as IconMeta);
const nodeNames = Object.keys(nodes);

describe("生成したアイコンのデータ", () => {
  const packageDir = dirname(
    createRequire(import.meta.url).resolve("lucide-react/package.json"),
  );

  it("入っている lucide-react と同じ版から作られている", () => {
    // 失敗したら `pnpm --filter @mail/web icons:generate` で作り直す。
    const { version } = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    expect(meta.version).toBe(version);
  });

  it("lucide-react のすべてのアイコンを含む (別名は除く)", () => {
    const iconsDir = join(packageDir, "dist/esm/icons");
    const names = readdirSync(iconsDir)
      .filter((file) => file.endsWith(".mjs"))
      .filter((file) =>
        readFileSync(join(iconsDir, file), "utf8").includes("__iconData = "),
      )
      .map((file) => file.slice(0, -".mjs".length))
      .sort();
    expect(names.length).toBeGreaterThan(2000);
    expect([...nodeNames].sort()).toEqual(names);
    expect([...catalog.names].sort()).toEqual(names);
  });

  it("どのアイコンも、どれかの分類に入っている", () => {
    const categorized = new Set(
      catalog.categories.flatMap((category) => category.icons),
    );
    expect(nodeNames.filter((name) => !categorized.has(name))).toEqual([]);
  });

  it("分類には日本語の名前と、実在するアイコンが付いている", () => {
    for (const category of catalog.categories) {
      expect(category.label, category.name).toMatch(/[^\x20-\x7e]|^AI$/);
      expect(nodeNames, category.name).toContain(category.icon);
    }
    expect(catalog.categories[0].name).toBe("mail");
  });

  it("以前から選べた 20 種類は、移行後の名前で残っている", () => {
    for (const name of [
      "mail",
      "user",
      "users",
      "briefcase",
      "building-complex",
      "house",
      "graduation-cap",
      "heart",
      "star",
      "shopping-cart",
      "wallet",
      "code",
      "gamepad-2",
      "globe",
      "book",
      "eighth-notes",
      "camera",
      "plane",
      "wrench",
      "bell",
    ]) {
      expect(nodeNames, name).toContain(name);
    }
  });
});

describe("searchIcons", () => {
  it("名前そのものに合うものを先頭にする", () => {
    expect(searchIcons(catalog, "mail")[0]).toBe("mail");
    expect(searchIcons(catalog, "house")[0]).toBe("house");
    expect(searchIcons(catalog, "Mail Check")[0]).toBe("mail-check");
  });

  it("名前に無くても、検索用の語や以前の名前で見つかる", () => {
    expect(searchIcons(catalog, "home")).toContain("house");
    expect(searchIcons(catalog, "email")).toContain("mail");
    expect(searchIcons(catalog, "building-2")).toContain("building-complex");
  });

  it("検索用の語は、語の先頭から合うものだけを拾う", () => {
    const found = searchIcons(catalog, "cat");
    expect(found[0]).toBe("cat");
    // location や communication の途中の cat には合わせない。
    expect(found).not.toContain("map-pin");
    expect(found).not.toContain("phone");
  });

  it("空白で区切った言葉のすべてに合うものだけを返す", () => {
    const found = searchIcons(catalog, "arrow left");
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("arrow-left");
    expect(found).not.toContain("arrow-right");
  });

  it("日本語の言葉でも探せる", () => {
    expect(searchIcons(catalog, "家")[0]).toBe("house");
    expect(searchIcons(catalog, "メール")[0]).toBe("mail");
    expect(searchIcons(catalog, "仕事")).toContain("briefcase");
    // 分類の日本語の名前でも探せる。
    expect(searchIcons(catalog, "動物")).toContain("dog");
  });

  it("日本語の言い換えは、どれも何かのアイコンに当たる", () => {
    const missing = Object.keys(JAPANESE_WORDS).filter(
      (word) => searchIcons(catalog, word).length === 0,
    );
    expect(missing).toEqual([]);
  });

  it("空の言葉や、合うものが無い言葉では何も返さない", () => {
    expect(searchIcons(catalog, "  ")).toEqual([]);
    expect(searchIcons(catalog, "zzzzqqqq")).toEqual([]);
  });
});
