"use client";

import { useSyncExternalStore } from "react";
import type { Account, SidebarCategory, UnifiedState } from "@/lib/api";
import { type SidebarEntry, sidebarEntries } from "@/lib/unified";

/**
 * サイドバーのカテゴリ (利用者が作る、アカウントや統合フォルダのまとまり)。
 * カテゴリに入れた項目は、そのカテゴリの見出しの下に並ぶ。中での順番は、
 * 項目そのものの並び順 (サイドバー上部の並び順、アカウントの並び順) に従う。
 */

/** 1 人が作れるカテゴリの数 (サーバーと同じ)。 */
export const MAX_CATEGORIES = 50;
/** カテゴリの名前の長さの上限 (サーバーと同じ)。 */
export const MAX_CATEGORY_NAME = 50;

/** 1 つのカテゴリと、その中に見えている項目。 */
export type CategoryGroup = {
  category: SidebarCategory;
  views: SidebarEntry[];
  accounts: Account[];
};

/** サイドバーに並べる項目を、カテゴリごとに分けたもの。 */
export type SidebarGroups = {
  /** カテゴリに入れていない、サイドバー上部の項目。 */
  views: SidebarEntry[];
  /** カテゴリに入れていないアカウント。 */
  accounts: Account[];
  categories: CategoryGroup[];
};

/** サイドバーのアカウントの段に並ぶもの (カテゴリなしのアカウントか、カテゴリ)。 */
export type SidebarSection =
  | { kind: "account"; key: string; account: Account; group?: undefined }
  | {
      kind: "category";
      key: string;
      group: CategoryGroup;
      account?: undefined;
    };

/**
 * カテゴリなしのアカウントとカテゴリを、保存してある混ぜた並び (sectionOrder) のとおりに並べる。
 * sectionOrder はどの位置がアカウントでどの位置がカテゴリかだけに使い、アカウントどうしは
 * アカウントの並び順、カテゴリどうしはカテゴリの並び順に従う。載っていない分は、
 * アカウント、カテゴリの順で後ろに足す (以前の版と同じ、アカウントの下にカテゴリ)。
 */
export function orderSections(
  groups: Pick<SidebarGroups, "accounts" | "categories">,
  sectionOrder: readonly string[],
): SidebarSection[] {
  const accountIds = new Set(groups.accounts.map((account) => account.id));
  const categoryIds = new Set(
    groups.categories.map((group) => group.category.id),
  );
  const accounts = [...groups.accounts];
  const categories = [...groups.categories];
  const result: SidebarSection[] = [];
  const seen = new Set<string>();
  const pushAccount = () => {
    const account = accounts.shift();
    if (account) {
      result.push({ kind: "account", key: account.id, account });
    }
  };
  const pushCategory = () => {
    const group = categories.shift();
    if (group) {
      result.push({ kind: "category", key: group.category.id, group });
    }
  };
  for (const key of sectionOrder) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (accountIds.has(key)) pushAccount();
    else if (categoryIds.has(key)) pushCategory();
  }
  while (accounts.length > 0) pushAccount();
  while (categories.length > 0) pushCategory();
  return result;
}

/** 項目がどのカテゴリに入っているか (key → カテゴリの ID)。先に載っているカテゴリが優先。 */
export function categoryIndex(
  categories: readonly SidebarCategory[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const category of categories) {
    for (const key of category.items) {
      if (!index.has(key)) index.set(key, category.id);
    }
  }
  return index;
}

/** 項目が入っているカテゴリの ID。入っていなければ null。 */
export function categoryOf(
  categories: readonly SidebarCategory[],
  key: string,
): string | null {
  return categoryIndex(categories).get(key) ?? null;
}

/**
 * サイドバーの項目 (見えている上部の項目とアカウント) を、カテゴリごとに分ける。
 * 無くなったアカウントや統合フォルダの ID がカテゴリに残っていても無視する。
 */
export function groupSidebar(
  state: Pick<UnifiedState, "folders" | "layout" | "categories">,
  accounts: readonly Account[],
): SidebarGroups {
  const index = categoryIndex(state.categories);
  const groups = new Map<string, CategoryGroup>(
    state.categories.map((category) => [
      category.id,
      { category, views: [], accounts: [] },
    ]),
  );
  const result: SidebarGroups = {
    views: [],
    accounts: [],
    categories: [...groups.values()],
  };
  for (const entry of sidebarEntries(state).visible) {
    const group = groups.get(index.get(entry.key) ?? "");
    (group ? group.views : result.views).push(entry);
  }
  for (const account of accounts) {
    const group = groups.get(index.get(account.id) ?? "");
    (group ? group.accounts : result.accounts).push(account);
  }
  return result;
}

/**
 * 項目を別のカテゴリへ移す。categoryId が null ならカテゴリから外す。
 * 同じカテゴリなら、そのままの内容を返す。
 */
export function assignCategory(
  categories: readonly SidebarCategory[],
  key: string,
  categoryId: string | null,
): SidebarCategory[] {
  return categories.map((category) => {
    const has = category.items.includes(key);
    if (category.id === categoryId) {
      return has ? category : { ...category, items: [...category.items, key] };
    }
    return has
      ? { ...category, items: category.items.filter((item) => item !== key) }
      : category;
  });
}

/** 新しいカテゴリを末尾に足す。key を渡すと、その項目を作ったカテゴリへ移す。 */
export function addCategory(
  categories: readonly SidebarCategory[],
  category: { id: string; name: string },
  key?: string,
): SidebarCategory[] {
  const next = [
    ...categories,
    { id: category.id, name: category.name.trim(), items: [] },
  ];
  return key === undefined ? next : assignCategory(next, key, category.id);
}

export function renameCategory(
  categories: readonly SidebarCategory[],
  id: string,
  name: string,
): SidebarCategory[] {
  return categories.map((category) =>
    category.id === id ? { ...category, name: name.trim() } : category,
  );
}

/** カテゴリを削除する。中の項目はカテゴリなしに戻る (項目そのものは消えない)。 */
export function removeCategory(
  categories: readonly SidebarCategory[],
  id: string,
): SidebarCategory[] {
  return categories.filter((category) => category.id !== id);
}

/** カテゴリを ids の順に並べ直す。ids に無いカテゴリは後ろに残す。 */
export function reorderCategories(
  categories: readonly SidebarCategory[],
  ids: readonly string[],
): SidebarCategory[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const ordered = ids.flatMap((id) => {
    const category = byId.get(id);
    return category ? [category] : [];
  });
  const rest = categories.filter((category) => !ids.includes(category.id));
  return [...ordered, ...rest];
}

/**
 * 全体の並び (all) のうち一部 (1 つのカテゴリの中など) を並び替えた結果を、全体の並びに戻す。
 * subset に含まれる項目が占めていた位置に、新しい順で入れ直す。
 */
export function mergeSubsetOrder(
  all: readonly string[],
  subset: readonly string[],
): string[] {
  const members = new Set(subset);
  const queue = [...subset];
  return all.map((key) => (members.has(key) ? (queue.shift() ?? key) : key));
}

/** 無くなった項目の ID を、カテゴリから取り除く。変わらなければ同じ配列を返す。 */
export function pruneCategories(
  categories: SidebarCategory[],
  existing: ReadonlySet<string>,
): SidebarCategory[] {
  let changed = false;
  const next = categories.map((category) => {
    const items = category.items.filter((key) => existing.has(key));
    if (items.length === category.items.length) return category;
    changed = true;
    return { ...category, items };
  });
  return changed ? next : categories;
}

const FOLDED_KEY = "mail.sidebar-categories-folded.v1";

/**
 * 折りたたんだカテゴリの ID。端末ごとに覚え、サイドバーと折りたたみ中の帯で共有する。
 */
let folded: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set();

function readFolded(): ReadonlySet<string> {
  if (folded) return folded;
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(FOLDED_KEY) ?? "[]",
    );
    folded = new Set(
      Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    // 読めなければ、すべて開いた状態で始める。
    folded = new Set();
  }
  return folded;
}

export function toggleCategoryFolded(id: string): void {
  const next = new Set(readFolded());
  if (!next.delete(id)) next.add(id);
  folded = next;
  try {
    window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
  } catch {
    // 保存できなくても、このページを開いている間は有効。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 折りたたんだカテゴリの ID。 */
export function useFoldedCategories(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readFolded, () => EMPTY);
}
