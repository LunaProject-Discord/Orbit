import { describe, expect, it } from "vitest";
import {
  normalizeCategories,
  normalizeFilters,
  normalizeScope,
  sidebarCategories,
  sidebarLayout,
  unifiedFilters,
  unifiedScope,
} from "./unified.js";

const ID = "01a20204-fedc-7eb2-a37f-deedef89d227";

describe("統合フォルダの内容", () => {
  it("役割は決まった順に揃え、フォルダの重複を除く", () => {
    expect(
      normalizeScope({
        all: false,
        roles: ["sent", "inbox", "sent"],
        mailboxIds: [ID, ID.toUpperCase()],
      }),
    ).toEqual({ all: false, roles: ["inbox", "sent"], mailboxIds: [ID] });
  });

  it("条件の文字は前後の空白を落とす", () => {
    const filters = normalizeFilters({
      version: 2,
      root: {
        type: "group",
        match: "all",
        children: [
          { type: "text", field: "from", value: " github ", negate: false },
        ],
      },
    });
    expect(filters.root.children[0]).toMatchObject({ value: "github" });
    expect(unifiedFilters.safeParse(filters).success).toBe(true);
  });

  it("知らない役割や、形の違う ID は受け付けない", () => {
    expect(
      unifiedScope.safeParse({ all: false, roles: ["all"], mailboxIds: [] })
        .success,
    ).toBe(false);
    expect(
      unifiedScope.safeParse({ all: false, roles: [], mailboxIds: ["x"] })
        .success,
    ).toBe(false);
  });

  it("並び順は、初めからある項目の名前か統合フォルダの ID だけを、重複なしで受け付ける", () => {
    expect(
      sidebarLayout.safeParse({ order: ["starred", ID, "inbox"], hidden: [] })
        .success,
    ).toBe(true);
    expect(
      sidebarLayout.safeParse({ order: ["settings"], hidden: [] }).success,
    ).toBe(false);
    expect(
      sidebarLayout.safeParse({ order: ["inbox", "inbox"], hidden: [] })
        .success,
    ).toBe(false);
  });
});

describe("サイドバーのカテゴリ", () => {
  const CATEGORY = "01a20204-fedc-7eb2-a37f-000000000001";
  const OTHER = "01a20204-fedc-7eb2-a37f-000000000002";

  it("名前・項目を受け付け、ID を小文字に揃える", () => {
    const parsed = sidebarCategories.parse([
      { id: CATEGORY.toUpperCase(), name: " 仕事 ", items: ["inbox", ID] },
    ]);
    expect(normalizeCategories(parsed)).toEqual([
      { id: CATEGORY, name: "仕事", items: ["inbox", ID] },
    ]);
  });

  it("空の名前と、決まっていない名前の項目は受け付けない", () => {
    expect(
      sidebarCategories.safeParse([{ id: CATEGORY, name: " ", items: [] }])
        .success,
    ).toBe(false);
    expect(
      sidebarCategories.safeParse([
        { id: CATEGORY, name: "仕事", items: ["spam"] },
      ]).success,
    ).toBe(false);
  });

  it("同じ項目を 2 つのカテゴリに入れられない", () => {
    expect(
      sidebarCategories.safeParse([
        { id: CATEGORY, name: "仕事", items: [ID] },
        { id: OTHER, name: "個人", items: [ID.toUpperCase()] },
      ]).success,
    ).toBe(false);
  });

  it("同じ ID のカテゴリは 2 つ作れない", () => {
    expect(
      sidebarCategories.safeParse([
        { id: CATEGORY, name: "仕事", items: [] },
        { id: CATEGORY, name: "個人", items: [] },
      ]).success,
    ).toBe(false);
  });
});
