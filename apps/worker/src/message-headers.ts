import {
  type AuthResults,
  type AuthTrust,
  checkSender,
  SENDER_CHECK_VERSION,
  type SenderCheck,
  selectAuthResults,
} from "@orbit/core";
import { type Address, type accounts, messages } from "@orbit/db";
import { isNull, or, sql } from "drizzle-orm";
import { clean } from "./message-parse.js";

/**
 * 取り込み時に IMAP へ要求するヘッダー (References はスレッドのまとめに使う)。
 * Authentication-Results は送信元の認証結果 (SPF・DKIM・DMARC)。
 */
export const FETCH_HEADERS = [
  "references",
  "list-id",
  "list-unsubscribe",
  "authentication-results",
];

/** 後から補うときに IMAP へ要求するヘッダー。 */
export const LIST_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "authentication-results",
];

/** メーリングリストやメールマガジンの情報。 */
export type ListInfo = {
  /** List-Id ヘッダーの ID。無ければ null。 */
  listId: string | null;
  /** List-Unsubscribe ヘッダーにあった配信停止の宛先 (https / mailto の URL)。 */
  listUnsubscribe: string[];
};

const MAX_LIST_ID = 255;
const MAX_UNSUBSCRIBE_URLS = 4;
const MAX_URL_LENGTH = 2000;

/** 画面にリンクとして出してよい配信停止の URL か (https と mailto だけ)。 */
function isUnsubscribeUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * List-Id の値から ID を取り出す。「説明 <id>」の形なら山かっこの中、
 * 山かっこが無ければ値そのもの。
 */
function parseListId(value: string | undefined): string | null {
  if (!value) return null;
  const bracketed = /<([^<>]*)>\s*$/.exec(value);
  const id = clean(bracketed ? bracketed[1] : value).trim();
  // 山かっこが無いのに空白を含む値は、ID ではなく説明だけなので使わない。
  if (!id || (!bracketed && /\s/.test(id))) return null;
  return id.slice(0, MAX_LIST_ID);
}

/** List-Unsubscribe の値 (「<url>, <url>」) から、使える URL を取り出す。 */
function parseListUnsubscribe(value: string | undefined): string[] {
  const urls: string[] = [];
  for (const match of value?.matchAll(/<([^<>]*)>/g) ?? []) {
    // 長い URL は折り返されて、途中に空白が入っていることがある。
    const url = clean(match[1]).replace(/\s+/g, "");
    if (isUnsubscribeUrl(url) && !urls.includes(url)) urls.push(url);
    if (urls.length >= MAX_UNSUBSCRIBE_URLS) break;
  }
  return urls;
}

/**
 * ヘッダーの補完がまだのメール (項目を足す前に取り込んだもの)。裏で少しずつ補う。
 * 認証結果 (sender_check) を足す前に取り込んだメールは、ここには含めない。
 * 全件を書き換えると、そのたびに検索用の列と索引も作り直されて DB が重くなるため、
 * 利用者が開いたメールや一覧に見えている行だけを、本文の先読みと同じ仕組みで補う
 * (senderCheckPending、body-fetch.ts)。
 */
export const headersPending = isNull(messages.headersFetchedAt);

/**
 * 送信元の確認結果がまだ無いメール、または古い決まり (信頼する判定サーバーとの照合の前) で
 * 作った結果のメール。開いたときや一覧に見えたときに補う。
 */
export const senderCheckPending = or(
  isNull(messages.senderCheck),
  sql`(${messages.senderCheck}->>'version') is distinct from ${String(SENDER_CHECK_VERSION)}`,
);

/** 同期するアカウント (信頼する判定サーバーを決めるのに使う列)。 */
export type AuthTrustSource = Partial<
  Pick<typeof accounts.$inferSelect, "provider" | "imapHost">
>;

/**
 * アカウントの、信頼する判定サーバー (authserv-id) の決め方。種類が分からなければ null
 * (どのヘッダーも信頼しない = 認証の結果は無いものとして扱う)。
 */
export function authTrustOf(account: AuthTrustSource): AuthTrust | null {
  if (!account.provider) return null;
  return { provider: account.provider, host: account.imapHost ?? null };
}

/**
 * 取り込み済みのメールにヘッダーを補うとき、1 回分 (数百通の書き換え) ごとに空ける間。
 * 書き換えるたびに検索用の列と索引も作り直されるので、続けて流すと DB が重くなり、
 * 画面の一覧の読み込みが遅くなる。急がない作業なので、間を空けて少しずつ進める。
 */
export const HEADER_BACKFILL_PAUSE_MS = 2_000;

/** 補完 1 回分のあとに待つ。 */
export function headerBackfillPause(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, HEADER_BACKFILL_PAUSE_MS),
  );
}

/** メーリングリストの情報と、送信元の認証結果。 */
export type HeaderInfo = ListInfo & {
  /** つなぎ先のサーバーが付けた認証結果。ヘッダーが無ければ null。 */
  authResults: AuthResults | null;
  /** 認証結果と表示名から決めた、差出人の確認結果。 */
  senderCheck: SenderCheck;
};

/**
 * ヘッダーの名前 (小文字) と値の組から、メーリングリストの情報と認証結果を取り出す。
 * headers は、同じ名前のヘッダーを上 (最後に受け取ったサーバーが付けたもの) から順に返す。
 * 認証結果は、送り主も偽のヘッダーを書き込めるので、アカウントの信頼する判定サーバーが
 * いちばん上から付けたものだけを使う (selectAuthResults)。無ければ認証の結果は無いものとする。
 */
export function headerInfoOf(
  headers: (name: string) => string[],
  from: Address[],
  trust: AuthTrust | null,
): HeaderInfo {
  const authResults = selectAuthResults(
    headers("authentication-results"),
    trust,
  );
  return {
    listId: parseListId(headers("list-id")[0]),
    listUnsubscribe: parseListUnsubscribe(headers("list-unsubscribe")[0]),
    authResults,
    senderCheck: checkSender(from[0], authResults),
  };
}

/** IMAP で取得したヘッダー部分 (折り返しあり) から、メーリングリストの情報と認証結果を取り出す。 */
export function parseListHeaders(
  headers: Buffer | undefined,
  from: Address[],
  trust: AuthTrust | null,
): HeaderInfo {
  const unfolded = (headers?.toString("latin1") ?? "").replace(
    /\r?\n[ \t]+/g,
    " ",
  );
  return headerInfoOf(
    (name) =>
      [...unfolded.matchAll(new RegExp(`^${name}:(.*)$`, "gim"))].map(
        (line) => line[1]?.trim() ?? "",
      ),
    from,
    trust,
  );
}

/** Microsoft Graph の internetMessageHeaders から、メーリングリストの情報と認証結果を取り出す。 */
export function listInfoFromGraph(
  headers: { name?: string | null; value?: string | null }[] | null | undefined,
  from: Address[],
  trust: AuthTrust | null,
): HeaderInfo {
  return headerInfoOf(
    (name) =>
      (headers ?? [])
        .filter((item) => item.name?.toLowerCase() === name)
        .map((item) => item.value ?? ""),
    from,
    trust,
  );
}
