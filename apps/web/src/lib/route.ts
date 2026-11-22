import type { SearchParams } from "@/lib/api";
import { emptyFilters, isSearchActive } from "@/lib/search";

/**
 * 画面の状態のうち、URL に残すもの。再読み込みやブックマーク、ブラウザーの「戻る」で
 * 同じ表示に戻れるようにする。
 *
 * 表示はパスで表す (/accounts/<ID>/folders/<ID>/messages/<ID> など)。検索の内容だけは
 * ? 以降に置く。
 *
 * Web は静的ファイルとして出力し、Tauri / Capacitor にも同梱するので、Next.js のページは
 * "/" の 1 つだけで、パスはこのファイルが読み取る。知らないパスを開いたときに同じ画面を
 * 返すのは、配信する側の役目 (Caddy の設定、サービスワーカー、not-found.tsx)。
 */
export type MailRoute = {
  /** 表示するアカウント。null なら全アカウント。 */
  accountId: string | null;
  /** 表示するフォルダ。null なら受信トレイ。 */
  mailboxId: string | null;
  /** 表示する統合フォルダ。null なら通常のフォルダ。 */
  unifiedId: string | null;
  /** 下書きの一覧を表示している。 */
  drafts: boolean;
  /** フォルダ以外の表示 (スター付き、送信待ち、設定)。null ならフォルダの一覧。 */
  special: SpecialView | null;
  /** 開いているメール。 */
  messageId: string | null;
  /** 設定画面で開いているページ。null なら設定の最初の画面 (狭い画面ではカテゴリの一覧)。 */
  settings: SettingsCategory | null;
  /** 会話の全体ではなく、会話の中のその 1 通だけを開いている (一覧で会話を広げて選んだとき)。 */
  single: boolean;
  /** 作成画面で開いている下書きの ID。まだ何も書いていない新規のメールは "new"。 */
  composeId: string | null;
  /** 実行中の検索。null なら通常の一覧。 */
  search: SearchParams | null;
};

/** フォルダに結び付かない表示。 */
export type SpecialView = "starred" | "outgoing" | "settings";
const SPECIAL_VIEWS: readonly string[] = ["starred", "outgoing", "settings"];

/** 設定画面のページ (カテゴリ)。並びは画面に出す順。 */
export const SETTINGS_CATEGORIES = [
  "accounts",
  "appearance",
  "fonts",
  "list",
  "reading",
  "actions",
  "sidebar",
  "notifications",
  "signatures",
  "system",
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

function settingsCategoryOf(
  value: string | undefined,
): SettingsCategory | null {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value ?? "")
    ? (value as SettingsCategory)
    : null;
}

export const emptyRoute: MailRoute = {
  accountId: null,
  mailboxId: null,
  unifiedId: null,
  drafts: false,
  special: null,
  messageId: null,
  settings: null,
  single: false,
  composeId: null,
  search: null,
};

/** 作成画面で、まだ何も書いていない新規のメールを指す値。 */
export const NEW_COMPOSE = "new";

const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function idOf(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value && ID.test(value) ? value.toLowerCase() : null;
}

function dateOf(params: URLSearchParams, name: string): string {
  const value = params.get(name) ?? "";
  return DATE.test(value) ? value : "";
}

/** 一覧を表す URL に付ける、検索の内容を読み取る。 */
function searchOf(params: URLSearchParams): SearchParams | null {
  const search: SearchParams = {
    text: params.get("q") ?? "",
    filters: {
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      subject: params.get("subject") ?? "",
      since: dateOf(params, "since"),
      until: dateOf(params, "until"),
      hasAttachment: params.get("attachment") === "1",
      unread: params.get("unread") === "1",
      flagged: params.get("starred") === "1",
    },
    scope: params.get("in") === "folder" ? "folder" : "all",
  };
  return isSearchActive(search) ? search : null;
}

/** 以前の URL (すべて ? 以降に置いていた形) にだけ現れる名前。 */
const LEGACY_KEYS = ["account", "folder", "message", "view", "compose"];

/**
 * 以前の形の URL (/?account=…&folder=…&message=… など) を読み取る。
 * ブックマークや、古い版が出した通知から開けるように残している。
 * 読み取ったあと、画面がいまの形の URL に書き換える。
 */
function parseLegacyRoute(params: URLSearchParams): MailRoute {
  const compose = params.get("compose");
  const composeId = compose === NEW_COMPOSE ? compose : idOf(params, "compose");
  const view = params.get("view");
  if (view === "drafts") {
    return { ...emptyRoute, drafts: true, composeId };
  }
  if (view && SPECIAL_VIEWS.includes(view)) {
    return {
      ...emptyRoute,
      special: view as SpecialView,
      messageId: view === "starred" ? idOf(params, "message") : null,
      single: false,
      composeId,
    };
  }
  return {
    accountId: idOf(params, "account"),
    mailboxId: idOf(params, "folder"),
    unifiedId: null,
    drafts: false,
    special: null,
    messageId: idOf(params, "message"),
    settings: null,
    single: false,
    composeId,
    search: searchOf(params),
  };
}

/**
 * URL (パスと ? 以降) から、画面の状態を読み取る。形の合わない部分は無いものとして扱う。
 *
 *   /                                             すべての受信トレイ
 *   /accounts/<ID>                                アカウントの受信トレイ
 *   /accounts/<ID>/folders/<ID>                   フォルダ
 *   /unified/<ID>                                 統合フォルダ
 *   …/messages/<ID>                               メール (会話) を開いた状態
 *   …/messages/<ID>/single                        会話の中の 1 通だけを開いた状態
 *   /drafts  /starred  /outgoing  /settings       フォルダ以外の表示
 *   /settings/<カテゴリ>                          設定画面のページ (fonts、notifications など)
 *   …/compose/<下書きの ID>  …/compose/new        作成画面を開いた状態
 *   …?q=<語>&from=…                               検索 (一覧の URL に付ける)
 */
export function parseRoute(url: string): MailRoute {
  const mark = url.indexOf("?");
  const path = mark === -1 ? url : url.slice(0, mark);
  const params = new URLSearchParams(mark === -1 ? "" : url.slice(mark + 1));
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return LEGACY_KEYS.some((key) => params.has(key))
      ? parseLegacyRoute(params)
      : { ...emptyRoute, search: searchOf(params) };
  }

  let index = 0;
  /** 次が「名前/ID」の並びなら、その ID を取り出して先へ進む。 */
  const take = (name: string): string | null => {
    const value = segments[index + 1];
    if (segments[index] !== name || !value || !ID.test(value)) return null;
    index += 2;
    return value.toLowerCase();
  };

  const route: MailRoute = { ...emptyRoute };
  const head = segments[0] as string;
  if (head === "drafts") {
    route.drafts = true;
    index = 1;
  } else if (SPECIAL_VIEWS.includes(head)) {
    route.special = head as SpecialView;
    index = 1;
    // スター付きの一覧では、メールを開ける。
    if (head === "starred") route.messageId = take("messages");
    if (head === "settings") {
      route.settings = settingsCategoryOf(segments[1]);
      if (route.settings) index = 2;
    }
  } else {
    route.unifiedId = take("unified");
    if (!route.unifiedId) {
      route.accountId = take("accounts");
      route.mailboxId = take("folders");
    }
    route.messageId = take("messages");
    route.search = searchOf(params);
  }
  if (route.messageId && segments[index] === "single") {
    route.single = true;
    index += 1;
  }
  if (segments[index] === "compose") {
    const value = segments[index + 1] ?? "";
    route.composeId =
      value === NEW_COMPOSE
        ? value
        : ID.test(value)
          ? value.toLowerCase()
          : null;
  }
  return route;
}

/**
 * 画面の状態を URL (パスと ? 以降) にする。何も選んでいなければ "/"。
 * 同じ状態は必ず同じ文字列になるので、文字列どうしを比べて変化を判定できる。
 */
export function buildRoute(route: MailRoute): string {
  const segments: string[] = [];
  const params = new URLSearchParams();
  if (route.drafts) {
    segments.push("drafts");
  } else if (route.special) {
    segments.push(route.special);
    if (route.special === "starred" && route.messageId) {
      segments.push("messages", route.messageId);
      if (route.single) segments.push("single");
    }
    if (route.special === "settings" && route.settings) {
      segments.push(route.settings);
    }
  } else {
    if (route.unifiedId) segments.push("unified", route.unifiedId);
    else {
      if (route.accountId) segments.push("accounts", route.accountId);
      if (route.mailboxId) segments.push("folders", route.mailboxId);
    }
    if (route.messageId) {
      segments.push("messages", route.messageId);
      if (route.single) segments.push("single");
    }
    const search = route.search;
    if (search && isSearchActive(search)) {
      const { filters } = search;
      if (search.text !== "") params.set("q", search.text);
      if (filters.from !== "") params.set("from", filters.from);
      if (filters.to !== "") params.set("to", filters.to);
      if (filters.subject !== "") params.set("subject", filters.subject);
      if (DATE.test(filters.since)) params.set("since", filters.since);
      if (DATE.test(filters.until)) params.set("until", filters.until);
      if (filters.hasAttachment) params.set("attachment", "1");
      if (filters.unread) params.set("unread", "1");
      if (filters.flagged) params.set("starred", "1");
      if (search.scope === "folder") params.set("in", "folder");
    }
  }
  if (route.composeId) segments.push("compose", route.composeId);
  const query = params.toString();
  return `/${segments.join("/")}${query === "" ? "" : `?${query}`}`;
}

/** 検索の内容が同じか。同じなら、一覧を読み込み直さずに済む。 */
export function sameSearch(
  a: SearchParams | null,
  b: SearchParams | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.text === b.text &&
    a.scope === b.scope &&
    (Object.keys(emptyFilters) as (keyof typeof emptyFilters)[]).every(
      (key) => a.filters[key] === b.filters[key],
    )
  );
}

/**
 * 状態が変わったときの、ブラウザーの履歴の扱い。
 * - push: 履歴に積む。「戻る」で前の表示に戻れる。
 * - replace: いまの履歴を書き換える (検索欄の入力や、メールからメールへの移動)。
 * - close: メールや作成画面を閉じた。開く前の表示が 1 つ前の履歴にあればそこへ戻り、
 *   無ければ書き換える (閉じたあとの「戻る」で、閉じたものがまた開かないように)。
 */
export type HistoryMode = "push" | "replace" | "close";

export function historyMode(current: MailRoute, next: MailRoute): HistoryMode {
  if (
    current.accountId !== next.accountId ||
    current.mailboxId !== next.mailboxId ||
    current.unifiedId !== next.unifiedId ||
    current.drafts !== next.drafts ||
    current.special !== next.special
  ) {
    return "push";
  }
  // 設定画面は、カテゴリの一覧からページへ入るときに積み、ページどうしの移動は書き換える。
  const opened =
    (!current.messageId && next.messageId) ||
    (!current.composeId && next.composeId) ||
    (!current.settings && next.settings);
  if (opened) return "push";
  const closed =
    (current.messageId && !next.messageId) ||
    (current.composeId && !next.composeId) ||
    (current.settings && !next.settings);
  return closed ? "close" : "replace";
}

/**
 * ログイン後に戻る先として使える URL か。このアプリの中のパスだけを通す
 * (//example.com のような、ほかのサイトへ移る値は通さない)。
 */
export function safeReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.includes("\\")) return null;
  if (value === "/" || value.startsWith("/login")) return null;
  return value;
}
