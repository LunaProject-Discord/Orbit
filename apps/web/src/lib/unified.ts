import type {
  BuiltinStyle,
  MailboxSummary,
  SidebarLayout,
  UnifiedFilters,
  UnifiedFolder,
  UnifiedRole,
  UnifiedScope,
  UnifiedState,
} from "@/lib/api";

/**
 * 統合フォルダ (利用者が作る、複数のフォルダをまとめた一覧) と、
 * サイドバー上部の項目の並び順・表示 / 非表示の扱い。
 */

/** サイドバー上部に初めからある項目。 */
export const BUILTIN_VIEWS = [
  "inbox",
  "starred",
  "drafts",
  "outgoing",
] as const;
export type BuiltinView = (typeof BUILTIN_VIEWS)[number];

export const BUILTIN_LABELS: Record<BuiltinView, string> = {
  inbox: "すべての受信トレイ",
  starred: "スター付き",
  drafts: "下書き",
  outgoing: "送信待ち",
};

/** 「全アカウントの…」として選べる役割と、その呼び名。 */
export const UNIFIED_ROLES: readonly { role: UnifiedRole; label: string }[] = [
  { role: "inbox", label: "受信トレイ" },
  { role: "sent", label: "送信済み" },
  { role: "drafts", label: "下書き" },
  { role: "archive", label: "アーカイブ" },
  { role: "junk", label: "迷惑メール" },
  { role: "trash", label: "ごみ箱" },
];

/** 期間の選択肢 (受信してからの日数)。 */
export const WITHIN_DAYS: readonly { days: number; label: string }[] = [
  { days: 1, label: "24 時間以内" },
  { days: 7, label: "7 日以内" },
  { days: 30, label: "30 日以内" },
  { days: 90, label: "90 日以内" },
  { days: 365, label: "1 年以内" },
];

export const emptyUnifiedScope: UnifiedScope = {
  all: false,
  roles: ["inbox"],
  mailboxIds: [],
};

export const emptyUnifiedFilters: UnifiedFilters = {
  unread: false,
  flagged: false,
  hasAttachment: false,
  from: "",
  to: "",
  subject: "",
  text: "",
  withinDays: null,
};

export const emptyUnifiedState: UnifiedState = {
  folders: [],
  layout: { order: [], hidden: [] },
  builtins: {},
};

const NO_STYLE: BuiltinStyle = { name: null, icon: null, color: null };

/** 初めからある項目に付けた見た目 (変えていなければ、すべて null)。 */
export function builtinStyle(
  state: Pick<UnifiedState, "builtins">,
  view: BuiltinView,
): BuiltinStyle {
  return state.builtins[view] ?? NO_STYLE;
}

/** 初めからある項目の表示名 (名前を付けていなければ、初期の名前)。 */
export function builtinLabel(
  state: Pick<UnifiedState, "builtins">,
  view: BuiltinView,
): string {
  return state.builtins[view]?.name || BUILTIN_LABELS[view];
}

/** 並び順の計算に使う部分 (統合フォルダと、保存してある並び順)。 */
type LayoutState = Pick<UnifiedState, "folders" | "layout">;

/** サイドバー上部の 1 項目。key は、初めからある項目の名前か統合フォルダの ID。 */
export type SidebarEntry =
  | { key: string; builtin: BuiltinView; folder?: undefined }
  | { key: string; folder: UnifiedFolder; builtin?: undefined };

const isBuiltin = (key: string): key is BuiltinView =>
  (BUILTIN_VIEWS as readonly string[]).includes(key);

/**
 * サイドバー上部の項目を、保存してある順に並べる。順番に載っていない項目
 * (後から作った統合フォルダなど) は、初めからある項目、統合フォルダ (作った順) の順で後ろに足す。
 * 無くなった統合フォルダの ID は無視する。
 */
export function sidebarEntries(state: LayoutState): {
  /** 隠している項目も含めた、すべての項目。 */
  all: SidebarEntry[];
  visible: SidebarEntry[];
} {
  const byId = new Map(state.folders.map((folder) => [folder.id, folder]));
  const keys = [
    ...state.layout.order,
    ...BUILTIN_VIEWS,
    ...state.folders.map((folder) => folder.id),
  ];
  const seen = new Set<string>();
  const all: SidebarEntry[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const folder = byId.get(key);
    if (isBuiltin(key)) all.push({ key, builtin: key });
    else if (folder) all.push({ key, folder });
  }
  const hidden = new Set(state.layout.hidden);
  return { all, visible: all.filter((entry) => !hidden.has(entry.key)) };
}

/**
 * 見えている項目を並び替えた結果を、保存する順番にする。
 * 隠している項目は、もとの位置 (直前にあった項目の後ろ) に残す。
 */
export function reorderLayout(
  state: LayoutState,
  visibleKeys: string[],
): SidebarLayout {
  const { all } = sidebarEntries(state);
  const hidden = new Set(state.layout.hidden);
  const order: string[] = [];
  const queue = [...visibleKeys];
  for (const entry of all) {
    if (hidden.has(entry.key)) order.push(entry.key);
    else {
      const next = queue.shift();
      if (next !== undefined) order.push(next);
    }
  }
  return { order, hidden: state.layout.hidden };
}

/** 項目を隠す / また表示する。並び順も、いまの表示のとおりに保存する。 */
export function setEntryHidden(
  state: LayoutState,
  key: string,
  hidden: boolean,
): SidebarLayout {
  const { all } = sidebarEntries(state);
  const keys = new Set(all.map((entry) => entry.key));
  const next = new Set(state.layout.hidden.filter((item) => keys.has(item)));
  if (hidden) next.add(key);
  else next.delete(key);
  return { order: all.map((entry) => entry.key), hidden: [...next] };
}

/** 統合フォルダが集めるフォルダ (いまあるフォルダのうち、場所に当てはまるもの)。 */
export function scopeMailboxes(
  scope: UnifiedScope,
  mailboxes: readonly MailboxSummary[],
): MailboxSummary[] {
  if (scope.all) {
    return mailboxes.filter(
      (mailbox) =>
        mailbox.specialUse !== "trash" && mailbox.specialUse !== "junk",
    );
  }
  const ids = new Set(scope.mailboxIds);
  const roles = new Set<string>(scope.roles);
  return mailboxes.filter(
    (mailbox) =>
      ids.has(mailbox.id) ||
      (mailbox.specialUse !== null && roles.has(mailbox.specialUse)),
  );
}

/** 集める場所を 1 つも選んでいない (保存できない)。 */
export function isScopeEmpty(scope: UnifiedScope): boolean {
  return (
    !scope.all && scope.roles.length === 0 && scope.mailboxIds.length === 0
  );
}

/** 条件を 1 つでも指定しているか。 */
export function hasFilters(filters: UnifiedFilters): boolean {
  return (
    filters.unread ||
    filters.flagged ||
    filters.hasAttachment ||
    filters.from.trim() !== "" ||
    filters.to.trim() !== "" ||
    filters.subject.trim() !== "" ||
    filters.text.trim() !== "" ||
    filters.withinDays !== null
  );
}

/** 統合フォルダの内容を短い文にする (設定画面や、一覧の見出しの下に出す)。 */
export function describeUnified(
  folder: Pick<UnifiedFolder, "scope" | "filters">,
  mailboxes: readonly MailboxSummary[],
): string {
  const { scope, filters } = folder;
  const places: string[] = [];
  if (scope.all) places.push("すべてのフォルダ");
  else {
    for (const { role, label } of UNIFIED_ROLES) {
      if (scope.roles.includes(role)) places.push(`全アカウントの${label}`);
    }
    const roles = new Set<string>(scope.roles);
    const picked = mailboxes.filter(
      (mailbox) =>
        scope.mailboxIds.includes(mailbox.id) &&
        !(mailbox.specialUse !== null && roles.has(mailbox.specialUse)),
    );
    if (picked.length > 0) places.push(`選んだフォルダ ${picked.length} 個`);
  }
  const conditions: string[] = [];
  if (filters.unread) conditions.push("未読");
  if (filters.flagged) conditions.push("スター付き");
  if (filters.hasAttachment) conditions.push("添付あり");
  if (filters.from.trim()) conditions.push(`差出人「${filters.from.trim()}」`);
  if (filters.to.trim()) conditions.push(`宛先「${filters.to.trim()}」`);
  if (filters.subject.trim()) {
    conditions.push(`件名「${filters.subject.trim()}」`);
  }
  if (filters.text.trim()) conditions.push(`「${filters.text.trim()}」を含む`);
  if (filters.withinDays !== null) {
    conditions.push(
      WITHIN_DAYS.find((item) => item.days === filters.withinDays)?.label ??
        `${filters.withinDays} 日以内`,
    );
  }
  const place = places.length > 0 ? places.join("、") : "フォルダ未選択";
  return conditions.length > 0 ? `${place} / ${conditions.join("、")}` : place;
}

const CACHE_KEY = "mail.unified.v1";

/** 前回取得した内容。サーバーの応答を待つ間や、オフラインで開いたときにサイドバーへ出す。 */
export function loadCachedUnified(): UnifiedState | null {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(CACHE_KEY) ?? "null",
    );
    const state = saved as Partial<UnifiedState> | null;
    if (
      state &&
      Array.isArray(state.folders) &&
      Array.isArray(state.layout?.order) &&
      Array.isArray(state.layout?.hidden)
    ) {
      // 以前の版が保存した内容には、初めからある項目の見た目が無い。
      return { ...(state as UnifiedState), builtins: state.builtins ?? {} };
    }
  } catch {
    // 読めなければ、サーバーから取得するまで初めからある項目だけを出す。
  }
  return null;
}

export function storeCachedUnified(state: LayoutState): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // 保存できなくても、このページを開いている間は使える。
  }
}
