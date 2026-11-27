import { notifyNavigation } from "@/lib/app-navigation";

/**
 * 設定のダイアログの URL。/settings/<分類>/<ページ> (例 /settings/mail/list)。
 * /settings だけなら、ページを選んでいない状態 (広い画面では共通の最初のページ、
 * 狭い画面では分類とページの一覧)。
 *
 * 設定はどのアプリ (メール・カレンダー) から開いても同じダイアログで、背後には開いた元の
 * アプリの画面を残す。開いた元の URL は履歴の state (orbitSettings.from) に覚えておき、
 * 閉じるとそこへ戻る。直接 /settings を開いたとき (覚えていないとき) はメールへ戻る。
 */

/** 設定の分類。並びは画面に出す順。連絡先はアプリが無いので、いまはページが無い。 */
export const SETTINGS_GROUPS = [
  "common",
  "mail",
  "calendar",
  "contacts",
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** 分類ごとのページ。並びは画面に出す順。ページを足すときは settings-view.tsx にも足す。 */
export const SETTINGS_PAGES = {
  common: [
    "accounts",
    "appearance",
    "fonts",
    "datetime",
    "notifications",
    "security",
    "system",
    "about",
  ],
  mail: [
    "list",
    "reading",
    "actions",
    "sidebar",
    "signatures",
    "notifications",
  ],
  calendar: ["notifications"],
  contacts: [],
} as const satisfies Record<SettingsGroup, readonly string[]>;

/** 設定のページ。 */
export type SettingsPageRef = {
  [G in SettingsGroup]: {
    group: G;
    page: (typeof SETTINGS_PAGES)[G][number];
  };
}[SettingsGroup];

/** 設定のダイアログの状態。page が null なら、ページを選んでいない。 */
export type SettingsRoute = { page: SettingsPageRef | null };

/** 広い画面で、ページを選んでいないときに出すページ (共通の最初のページ)。 */
export const DEFAULT_SETTINGS_PAGE: SettingsPageRef = {
  group: "common",
  page: "accounts",
};

export const SETTINGS_PATH = "/settings";
/** 設定を閉じたときに、開いた元が分からなければ戻る先。 */
export const SETTINGS_FALLBACK_PATH = "/mail";

/**
 * 以前の設定のページ (/settings/<カテゴリ>、メールの画面の中にあった頃) と、いまのページの対応。
 * ブックマークや、古い版が覚えている戻り先 (Google のログインの returnTo など) から開けるように残す。
 */
export const LEGACY_SETTINGS_CATEGORIES: Record<string, SettingsPageRef> = {
  accounts: { group: "common", page: "accounts" },
  appearance: { group: "common", page: "appearance" },
  fonts: { group: "common", page: "fonts" },
  list: { group: "mail", page: "list" },
  datetime: { group: "common", page: "datetime" },
  reading: { group: "mail", page: "reading" },
  actions: { group: "mail", page: "actions" },
  sidebar: { group: "mail", page: "sidebar" },
  // 以前の「通知」の先頭はこの端末の通知 (オン・オフ) だったので、共通の通知へ移す。
  notifications: { group: "common", page: "notifications" },
  signatures: { group: "mail", page: "signatures" },
  security: { group: "common", page: "security" },
  system: { group: "common", page: "system" },
  about: { group: "common", page: "about" },
};

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`);
}

/** group と page が、いまある設定のページか。 */
export function settingsPageOf(
  group: string | undefined,
  page: string | undefined,
): SettingsPageRef | null {
  if (!group || !page) return null;
  if (!(SETTINGS_GROUPS as readonly string[]).includes(group)) return null;
  const pages: readonly string[] = SETTINGS_PAGES[group as SettingsGroup];
  return pages.includes(page) ? ({ group, page } as SettingsPageRef) : null;
}

function pathOf(url: string): string {
  const mark = url.search(/[?#]/);
  return mark === -1 ? url : url.slice(0, mark);
}

/**
 * URL (パス、? 以降があってもよい) が設定のダイアログなら、その状態を読む。設定でなければ null。
 * 以前の形 (/settings/<カテゴリ>) も読む。知らないページは、ページを選んでいない状態にする。
 */
export function parseSettingsRoute(url: string): SettingsRoute | null {
  const path = pathOf(url);
  if (!isSettingsPath(path)) return null;
  const segments = path.split("/").filter(Boolean).slice(1);
  const page =
    settingsPageOf(segments[0], segments[1]) ??
    (segments[0] ? (LEGACY_SETTINGS_CATEGORIES[segments[0]] ?? null) : null);
  return { page };
}

export function buildSettingsRoute(page: SettingsPageRef | null): string {
  return page ? `${SETTINGS_PATH}/${page.group}/${page.page}` : SETTINGS_PATH;
}

export function sameSettingsPage(
  a: SettingsPageRef | null,
  b: SettingsPageRef | null,
): boolean {
  return a?.group === b?.group && a?.page === b?.page;
}

// ---------------------------------------------------------------------------
// 開く・ページを移る・閉じる (履歴の扱い)
// ---------------------------------------------------------------------------

/**
 * 設定の履歴に覚えておくこと。from は開いた元のアプリの URL (直接開いたときは null)、
 * depth は開いた元から数えて何番目の履歴か (設定を開いた履歴が 1。一覧からページへ入ると 2)。
 */
type SettingsHistory = { from: string | null; depth: number };
const STATE_KEY = "orbitSettings";

/** history.state から、設定の履歴を読む。 */
export function readSettingsHistory(state: unknown): SettingsHistory | null {
  const value = (state as Record<string, unknown> | null)?.[STATE_KEY] as
    | { from?: unknown; depth?: unknown }
    | undefined;
  if (!value || typeof value !== "object") return null;
  const from =
    typeof value.from === "string" &&
    value.from.startsWith("/") &&
    !value.from.startsWith("//") &&
    !isSettingsPath(pathOf(value.from))
      ? value.from
      : null;
  const depth =
    typeof value.depth === "number" && Number.isInteger(value.depth)
      ? Math.max(1, Math.min(value.depth, 50))
      : 1;
  return { from, depth };
}

function stateOf(history: SettingsHistory) {
  return { [STATE_KEY]: history };
}

/** 背後に出すアプリの URL (開いた元)。分からなければメール。 */
export function settingsBackground(state: unknown = currentState()): string {
  return readSettingsHistory(state)?.from ?? SETTINGS_FALLBACK_PATH;
}

function currentState(): unknown {
  return typeof window === "undefined" ? null : window.history.state;
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** 履歴を戻ったあと、戻り終えた知らせ (popstate) を待つ長さ (ミリ秒)。 */
const BACK_TIMEOUT_MS = 600;

/**
 * steps だけ履歴を戻る。戻れなかったら (Android の WebView などで history.go が何も起こさないとき)、
 * いまの履歴を fallback に書き換える。
 */
function goBack(steps: number, fallback: () => void) {
  const before = window.location.href;
  let done = false;
  const onPop = () => {
    done = true;
    window.removeEventListener("popstate", onPop);
  };
  window.addEventListener("popstate", onPop);
  window.history.go(-steps);
  window.setTimeout(() => {
    window.removeEventListener("popstate", onPop);
    if (!done && window.location.href === before) fallback();
  }, BACK_TIMEOUT_MS);
}

/**
 * 設定を開く。page を省くと、ページを選んでいない状態 (広い画面では共通の最初のページ)。
 * すでに開いていれば、そのページへ移る。
 */
export function openSettings(page: SettingsPageRef | null = null): void {
  if (isSettingsPath(window.location.pathname)) {
    changeSettingsPage(page);
    return;
  }
  window.history.pushState(
    stateOf({ from: currentUrl(), depth: 1 }),
    "",
    buildSettingsRoute(page),
  );
  notifyNavigation();
}

/**
 * 設定のページを移る。一覧 (ページを選んでいない状態) からページへ入るときは履歴に積み、
 * ページどうしの移動は書き換える。ページから一覧へ戻るときは、一覧の履歴があればそこへ戻る。
 */
export function changeSettingsPage(page: SettingsPageRef | null): void {
  const current = parseSettingsRoute(window.location.pathname);
  if (!current) {
    openSettings(page);
    return;
  }
  if (sameSettingsPage(current.page, page)) return;
  const history = readSettingsHistory(window.history.state) ?? {
    from: null,
    depth: 1,
  };
  const path = buildSettingsRoute(page);
  if (current.page === null) {
    window.history.pushState(
      stateOf({ from: history.from, depth: history.depth + 1 }),
      "",
      path,
    );
  } else if (page === null && history.depth > 1) {
    goBack(1, () => {
      window.history.replaceState(
        stateOf({ ...history, depth: history.depth - 1 }),
        "",
        path,
      );
      notifyNavigation();
    });
    return;
  } else {
    window.history.replaceState(stateOf(history), "", path);
  }
  notifyNavigation();
}

/**
 * 設定を閉じて、開く前のアプリの画面へ戻る。開いた元の履歴があれば戻り、無ければ (直接
 * /settings を開いたとき) いまの履歴をメールの画面に書き換える。
 */
export function closeSettings(): void {
  if (!isSettingsPath(window.location.pathname)) return;
  const history = readSettingsHistory(window.history.state);
  const replace = () => {
    window.history.replaceState(
      null,
      "",
      history?.from ?? SETTINGS_FALLBACK_PATH,
    );
    notifyNavigation();
  };
  if (history?.from) goBack(history.depth, replace);
  else replace();
}

/**
 * 設定を閉じて、すぐに別の画面へ移る (通知からメールを開くときなど)。履歴は戻らずに書き換える。
 */
export function leaveSettings(path: string): void {
  window.history.replaceState(null, "", path);
  notifyNavigation();
}
