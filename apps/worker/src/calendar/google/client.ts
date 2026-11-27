import {
  CalendarAuthError,
  CalendarTransientError,
  type ProviderContext,
} from "../provider.js";

/**
 * Google Calendar API v3 を呼ぶ薄い道具。
 * https://developers.google.com/workspace/calendar/api/guides/errors
 * - 401 は一度だけトークンを取り直してやり直し、それでも 401 なら再ログインが要る。
 * - 403 のスコープ不足は同意が要る (CalendarAuthError consentRequired)。
 * - 403 / 429 の rate limit と 5xx は一時的な失敗として投げる。
 * - それ以外 (400、403 の権限不足、404、409、410、412) は呼び出し側が status で判断する。
 * トークンはエラーメッセージやログに出さない。
 */

export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** 一時的な失敗の reason (403 か 429 で返る)。 */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

/** スコープ不足の reason。 */
const SCOPE_REASONS = new Set([
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
]);

export type GoogleResponse<T> =
  | { ok: true; status: number; body: T; etag: string | null }
  | { ok: false; status: number; reason: string | null; message: string };

type Query = Record<string, string | number | boolean | string[] | undefined>;

export type GoogleRequest = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  ifMatch?: string | null;
};

/** パスの 1 区切り分を URL に入れる形にする (カレンダー ID には @ や # が入る)。 */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

function buildUrl(path: string, query: Query | undefined): string {
  const url = new URL(`${GOOGLE_CALENDAR_API}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Retry-After (秒か HTTP の日付) をミリ秒にする。無ければ null。 */
export function retryAfterMs(header: string | null, now = Date.now()) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

async function errorOf(response: Response) {
  let reason: string | null = null;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: {
        message?: string;
        status?: string;
        errors?: { reason?: string }[];
        details?: { reason?: string }[];
      };
    };
    const error = body.error;
    reason =
      error?.errors?.find((item) => item.reason)?.reason ??
      error?.details?.find((item) => item.reason)?.reason ??
      null;
    if (typeof error?.message === "string") message = error.message;
  } catch {
    // 本文が JSON でなければ status だけで判断する。
  }
  return { reason, message };
}

async function accessToken(ctx: ProviderContext, force: boolean) {
  if (ctx.auth.type !== "oauth2") {
    throw new CalendarAuthError(
      "Google カレンダーには Google でのログインが必要です。",
      { needsReauth: true },
    );
  }
  return ctx.auth.getAccessToken(force);
}

/** Google Calendar API を 1 回呼ぶ。 */
export async function googleRequest<T>(
  ctx: ProviderContext,
  path: string,
  request: GoogleRequest = {},
): Promise<GoogleResponse<T>> {
  const method = request.method ?? "GET";
  const url = buildUrl(path, request.query);
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(ctx, attempt > 0);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (request.body !== undefined)
      headers["content-type"] = "application/json";
    if (request.ifMatch) headers["if-match"] = request.ifMatch;
    response = await ctx.fetchFn(url, {
      method,
      headers,
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      signal: ctx.signal,
    });
    if (response.status !== 401) break;
    await response.body?.cancel();
  }
  if (!response) throw new Error("Google Calendar API を呼べませんでした。");

  if (response.status === 401) {
    throw new CalendarAuthError(
      "Google の認証に失敗しました。再ログインが必要です。",
      { needsReauth: true },
    );
  }
  if (response.ok) {
    const text = response.status === 204 ? "" : await response.text();
    return {
      ok: true,
      status: response.status,
      body: (text ? JSON.parse(text) : null) as T,
      etag: response.headers.get("etag"),
    };
  }
  const { reason, message } = await errorOf(response);
  const label = `Google Calendar API (${method} ${response.status}${reason ? ` ${reason}` : ""}): ${message}`;
  const waitMs = retryAfterMs(response.headers.get("retry-after"));
  if (
    response.status === 429 ||
    (response.status === 403 &&
      reason !== null &&
      RATE_LIMIT_REASONS.has(reason))
  ) {
    throw new CalendarTransientError(label, { retryAfterMs: waitMs });
  }
  if (response.status === 403 && reason !== null && SCOPE_REASONS.has(reason)) {
    throw new CalendarAuthError(
      "Google カレンダーへのアクセスが許可されていません。カレンダーの権限を許可し直してください。",
      { consentRequired: true },
    );
  }
  if (response.status >= 500) {
    if (waitMs !== null) {
      throw new CalendarTransientError(label, { retryAfterMs: waitMs });
    }
    throw new Error(label);
  }
  return { ok: false, status: response.status, reason, message: label };
}

/** 失敗の応答を、例外にする (読み取りで想定外の status のとき)。 */
export function failure(response: { status: number; message: string }): Error {
  return new Error(response.message);
}
