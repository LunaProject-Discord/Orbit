import {
  type AuthResults,
  checkSender,
  parseAuthenticationResults,
  type SenderCheck,
} from "@orbit/core";
import { type Address, messages } from "@orbit/db";
import { isNull } from "drizzle-orm";
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

/** 送信元の確認結果がまだ無いメール。開いたときや一覧に見えたときに補う。 */
export const senderCheckPending = isNull(messages.senderCheck);

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
 * header は、同じ名前のヘッダーが複数あれば、いちばん上 (最後に受け取ったサーバーが付けたもの) を返す。
 * 認証結果は、送り主が偽のヘッダーを書き込むこともできるので、いちばん上だけを使う。
 */
export function headerInfoOf(
  header: (name: string) => string | undefined,
  from: Address[],
): HeaderInfo {
  const authResults = parseAuthenticationResults(
    header("authentication-results"),
  );
  return {
    listId: parseListId(header("list-id")),
    listUnsubscribe: parseListUnsubscribe(header("list-unsubscribe")),
    authResults,
    senderCheck: checkSender(from[0], authResults),
  };
}

/** IMAP で取得したヘッダー部分 (折り返しあり) から、メーリングリストの情報と認証結果を取り出す。 */
export function parseListHeaders(
  headers: Buffer | undefined,
  from: Address[],
): HeaderInfo {
  const unfolded = (headers?.toString("latin1") ?? "").replace(
    /\r?\n[ \t]+/g,
    " ",
  );
  return headerInfoOf((name) => {
    const line = new RegExp(`^${name}:(.*)$`, "im").exec(unfolded);
    return line?.[1]?.trim();
  }, from);
}

/** Microsoft Graph の internetMessageHeaders から、メーリングリストの情報と認証結果を取り出す。 */
export function listInfoFromGraph(
  headers: { name?: string | null; value?: string | null }[] | null | undefined,
  from: Address[],
): HeaderInfo {
  return headerInfoOf(
    (name) =>
      headers?.find((item) => item.name?.toLowerCase() === name)?.value ??
      undefined,
    from,
  );
}
