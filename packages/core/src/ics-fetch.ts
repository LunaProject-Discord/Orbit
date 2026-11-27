import { resolvesToPrivateAddress } from "./host-check.js";
import {
  ICalendarError,
  type ParsedCalendar,
  parseICalendar,
} from "./icalendar.js";

/** ICS の購読の取得。サーバーが利用者の指定した URL へ取りに行くので、内部への接続を防ぐ。 */

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** 取得する大きさの上限。 */
export const ICS_MAX_BYTES = 10 * 1024 * 1024;

export type IcsFetchResult =
  | {
      status: "ok";
      body: string;
      /** 次の取得で If-None-Match / If-Modified-Since に使う値。 */
      validator: string | null;
      /** リダイレクトの後の URL。 */
      url: string;
    }
  | { status: "not_modified" }
  | {
      status: "error";
      reason:
        | "invalid_url"
        | "private_address"
        | "http_error"
        | "too_large"
        | "network";
      httpStatus?: number;
    };

/**
 * 購読の URL を http(s) にそろえる。webcal:// と webcals:// は https:// として扱う。
 * 使えない URL なら null。
 */
export function normalizeSubscriptionUrl(input: string): string | null {
  return subscriptionUrlCandidates(input)[0] ?? null;
}

/**
 * 購読の URL として試す順の候補。webcal:// は https:// を先に、つながらなければ http:// を試す
 * (webcal は本来 http の別名で、http でしか出していないサーバーもある)。
 */
export function subscriptionUrlCandidates(input: string): string[] {
  const https = normalizeUrl(input);
  if (!https) return [];
  if (!/^webcal:\/\//i.test(input.trim())) return [https];
  const http = normalizeUrl(input.trim().replace(/^webcal:\/\//i, "http://"));
  return http ? [https, http] : [https];
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim().replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return url.toString();
}

/**
 * 保存しておく条件付き取得の値。ETag があれば "etag:..."、無ければ Last-Modified を "date:..."。
 */
function validatorOf(headers: Headers): string | null {
  const etag = headers.get("etag");
  if (etag) return `etag:${etag}`;
  const modified = headers.get("last-modified");
  return modified ? `date:${modified}` : null;
}

export async function fetchIcs(
  url: string,
  {
    validator = null,
    allowPrivate = false,
    fetchImpl = fetch,
  }: {
    validator?: string | null;
    allowPrivate?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<IcsFetchResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let target = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { status: "error", reason: "invalid_url" };
      }
      if (!allowPrivate) {
        const isPrivate = await resolvesToPrivateAddress(
          parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
        ).catch(() => null);
        if (isPrivate === null) return { status: "error", reason: "network" };
        if (isPrivate) return { status: "error", reason: "private_address" };
      }
      const headers: Record<string, string> = {
        accept: "text/calendar, */*;q=0.5",
        "user-agent": "Orbit-Calendar/1.0",
      };
      if (validator?.startsWith("etag:")) {
        headers["if-none-match"] = validator.slice(5);
      } else if (validator?.startsWith("date:")) {
        headers["if-modified-since"] = validator.slice(5);
      }
      const response = await fetchImpl(target, {
        headers,
        redirect: "manual",
        signal,
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304
      ) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          return {
            status: "error",
            reason: "http_error",
            httpStatus: response.status,
          };
        target = new URL(location, target).toString();
        continue;
      }
      if (response.status === 304) {
        await response.body?.cancel();
        return { status: "not_modified" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: "error",
          reason: "http_error",
          httpStatus: response.status,
        };
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > ICS_MAX_BYTES) {
        await response.body?.cancel();
        return { status: "error", reason: "too_large" };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: "error", reason: "network" };
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > ICS_MAX_BYTES) {
          await reader.cancel();
          return { status: "error", reason: "too_large" };
        }
        chunks.push(value);
      }
      return {
        status: "ok",
        body: new TextDecoder().decode(Buffer.concat(chunks)),
        validator: validatorOf(response.headers),
        url: target,
      };
    }
    return { status: "error", reason: "http_error" };
  } catch {
    return { status: "error", reason: "network" };
  }
}

export type SubscriptionLoad =
  | { status: "ok"; calendar: ParsedCalendar; validator: string | null }
  | { status: "not_modified" }
  | { status: "error"; message: string };

/** 取得の失敗を、利用者に見せる文にする。 */
function failureMessage(
  result: Extract<IcsFetchResult, { status: "error" }>,
): string {
  switch (result.reason) {
    case "invalid_url":
      return "URL の形式が正しくありません。";
    case "private_address":
      return "この URL には接続できません (内部のネットワークを指しています)。";
    case "too_large":
      return "カレンダーが大きすぎます (10 MB まで)。";
    case "http_error":
      return result.httpStatus
        ? `取得できませんでした (HTTP ${result.httpStatus})。`
        : "取得できませんでした。";
    default:
      return "接続できませんでした。";
  }
}

/** 購読の URL から取得して読む。 */
export async function loadSubscription(
  url: string,
  options: {
    validator?: string | null;
    allowPrivate?: boolean;
    defaultTimeZone: string;
    fetchImpl?: typeof fetch;
  },
): Promise<SubscriptionLoad> {
  const result = await fetchIcs(url, options);
  if (result.status === "not_modified") return result;
  if (result.status === "error") {
    return { status: "error", message: failureMessage(result) };
  }
  try {
    return {
      status: "ok",
      calendar: parseICalendar(result.body, {
        defaultTimeZone: options.defaultTimeZone,
      }),
      validator: result.validator,
    };
  } catch (error) {
    if (error instanceof ICalendarError) {
      return {
        status: "error",
        message: "iCalendar (.ics) の形式ではありません。",
      };
    }
    throw error;
  }
}
