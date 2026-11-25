import { describe, expect, it } from "vitest";
import type { Account, SidebarCategory, UnifiedFolder } from "@/lib/api";
import {
  addCategory,
  assignCategory,
  categoryOf,
  groupSidebar,
  mergeSubsetOrder,
  orderSections,
  pruneCategories,
  removeCategory,
  renameCategory,
  reorderCategories,
} from "@/lib/sidebar-categories";
import { emptyUnifiedFilters, emptyUnifiedScope } from "@/lib/unified";

const account = (id: string) => ({ id }) as Account;
const folder = (id: string): UnifiedFolder => ({
  id,
  name: id,
  icon: null,
  color: null,
  scope: emptyUnifiedScope,
  filters: emptyUnifiedFilters,
  createdAt: "2026-11-24T00:00:00Z",
  unreadCount: 0,
});

const work: SidebarCategory = { id: "c1", name: "仕事", items: ["a2", "f1"] };
const home: SidebarCategory = { id: "c2", name: "個人", items: ["starred"] };

describe("groupSidebar", () => {
  it("カテゴリに入れた項目を、それぞれの見出しの下へ分ける", () => {
    const groups = groupSidebar(
      {
        folders: [folder("f1"), folder("f2")],
        layout: { order: [], hidden: [] },
        categories: [work, home],
      },
      [account("a1"), account("a2"), account("a3")],
    );
    expect(groups.views.map((entry) => entry.key)).toEqual([
      "inbox",
      "drafts",
      "outgoing",
      "f2",
    ]);
    expect(groups.accounts.map((item) => item.id)).toEqual(["a1", "a3"]);
    expect(
      groups.categories.map((group) => ({
        id: group.category.id,
        views: group.views.map((entry) => entry.key),
        accounts: group.accounts.map((item) => item.id),
      })),
    ).toEqual([
      { id: "c1", views: ["f1"], accounts: ["a2"] },
      { id: "c2", views: ["starred"], accounts: [] },
    ]);
  });

  it("隠した項目と、無くなった項目は出さない", () => {
    const groups = groupSidebar(
      {
        folders: [],
        layout: { order: [], hidden: ["starred"] },
        categories: [{ id: "c1", name: "仕事", items: ["starred", "gone"] }],
      },
      [],
    );
    expect(groups.categories[0]?.views).toEqual([]);
    expect(groups.categories[0]?.accounts).toEqual([]);
  });
});

describe("カテゴリの変更", () => {
  it("項目を別のカテゴリへ移し、元のカテゴリから外す", () => {
    const next = assignCategory([work, home], "a2", "c2");
    expect(next[0]?.items).toEqual(["f1"]);
    expect(next[1]?.items).toEqual(["starred", "a2"]);
    expect(categoryOf(next, "a2")).toBe("c2");
  });

  it("null ならカテゴリから外す", () => {
    const next = assignCategory([work, home], "f1", null);
    expect(categoryOf(next, "f1")).toBeNull();
    expect(next[0]?.items).toEqual(["a2"]);
  });

  it("作ったカテゴリへ項目を移せる", () => {
    const next = addCategory([work], { id: "c3", name: " 趣味 " }, "a2");
    expect(next).toEqual([
      { ...work, items: ["f1"] },
      { id: "c3", name: "趣味", items: ["a2"] },
    ]);
  });

  it("名前の変更・削除・並べ替え", () => {
    expect(renameCategory([work], "c1", " 会社 ")[0]?.name).toBe("会社");
    expect(removeCategory([work, home], "c1")).toEqual([home]);
    expect(
      reorderCategories([work, home], ["c2", "c1"]).map((item) => item.id),
    ).toEqual(["c2", "c1"]);
  });

  it("無くなった項目を取り除く (変わらなければ同じ配列)", () => {
    const list = [work, home];
    expect(pruneCategories(list, new Set(["a2", "f1", "starred"]))).toBe(list);
    expect(pruneCategories(list, new Set(["a2", "starred"]))[0]?.items).toEqual(
      ["a2"],
    );
  });
});

describe("mergeSubsetOrder", () => {
  it("一部を並び替えた結果を、全体の並びに戻す", () => {
    expect(mergeSubsetOrder(["a", "b", "c", "d", "e"], ["d", "b"])).toEqual([
      "a",
      "d",
      "c",
      "b",
      "e",
    ]);
  });
});

describe("orderSections", () => {
  const groups = groupSidebar(
    {
      folders: [],
      layout: { order: [], hidden: [] },
      categories: [work, home],
    },
    [account("a1"), account("a2"), account("a3")],
  );
  const keys = (order: string[]) =>
    orderSections(groups, order).map((section) => section.key);

  it("並びが無ければ、アカウントの下にカテゴリ", () => {
    expect(keys([])).toEqual(["a1", "a3", "c1", "c2"]);
  });

  it("カテゴリをアカウントより上に置ける", () => {
    expect(keys(["c1", "a1", "c2", "a3"])).toEqual(["c1", "a1", "c2", "a3"]);
  });

  it("アカウントどうし・カテゴリどうしの順番は、それぞれの並び順に従う", () => {
    expect(keys(["c2", "a3", "c1", "a1"])).toEqual(["c1", "a1", "c2", "a3"]);
  });

  it("載っていない分は後ろに足し、無くなった ID は無視する", () => {
    expect(keys(["c1", "gone"])).toEqual(["c1", "a1", "a3", "c2"]);
  });
});
