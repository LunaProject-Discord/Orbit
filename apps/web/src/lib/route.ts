import type { SearchParams } from "@/lib/api";
import { emptyFilters, isSearchActive } from "@/lib/search";

/**
 * 画面の状態のうち、URL に残すもの。再読み込みやブックマーク、ブラウザーの「戻る」で
 * 同じ表示に戻れるようにする。
 *
 * Web は静的ファイルとして出力し、Tauri / Capacitor にも同梱するので、
 * ID を含むパス (/mail/[accountId] など) は使えない。状態はすべて ? 以降に置く。
 */
export type MailRoute = {
  /** 表示するアカウント。null なら全アカウント。 */
  accountId: string | null;
  /** 表示するフォルダ。null なら受信トレイ。 */
  mailboxId: string | null;
  /** 下書きの一覧を表示している。 */
  drafts: boolean;
  /** フォルダ以外の表示 (スター付き、送信待ち、設定)。null ならフォルダの一覧。 */
  special: SpecialView | null;
  /** 開いているメール。 */
  messageId: string | null;
  /** 作成画面で開いている下書きの ID。まだ何も書いていない新規のメールは "new"。 */
  composeId: string | null;
  /** 実行中の検索。null なら通常の一覧。 */
  search: SearchParams | null;
};

/** フォルダに結び付かない表示。 */
export type SpecialView = "starred" | "outgoing" | "settings";
const SPECIAL_VIEWS: readonly string[] = ["starred", "outgoing", "settings"];

export const emptyRoute: MailRoute = {
  accountId: null,
  mailboxId: null,
  drafts: false,
  special: null,
  messageId: null,
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

/** URL の ? 以降から、画面の状態を読み取る。形の合わない値は無いものとして扱う。 */
export function parseRoute(query: string): MailRoute {
  const params = new URLSearchParams(query);
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
      // スター付きの一覧では、メールを開ける。
      messageId: view === "starred" ? idOf(params, "message") : null,
      composeId,
    };
  }
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
  return {
    accountId: idOf(params, "account"),
    mailboxId: idOf(params, "folder"),
    drafts: false,
    special: null,
    messageId: idOf(params, "message"),
    composeId,
    search: isSearchActive(search) ? search : null,
  };
}

/**
 * 画面の状態を URL の ? 以降にする (何も無ければ空文字)。
 * 同じ状態は必ず同じ文字列になるので、文字列どうしを比べて変化を判定できる。
 */
export function buildRoute(route: MailRoute): string {
  const params = new URLSearchParams();
  if (route.drafts) {
    params.set("view", "drafts");
  } else if (route.special) {
    params.set("view", route.special);
    if (route.special === "starred" && route.messageId) {
      params.set("message", route.messageId);
    }
  } else {
    if (route.accountId) params.set("account", route.accountId);
    if (route.mailboxId) params.set("folder", route.mailboxId);
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
    if (route.messageId) params.set("message", route.messageId);
  }
  if (route.composeId) params.set("compose", route.composeId);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
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
    current.drafts !== next.drafts ||
    current.special !== next.special
  ) {
    return "push";
  }
  const opened =
    (!current.messageId && next.messageId) ||
    (!current.composeId && next.composeId);
  if (opened) return "push";
  const closed =
    (current.messageId && !next.messageId) ||
    (current.composeId && !next.composeId);
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
