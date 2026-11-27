import { GraphError } from "../../graph-client.js";
import {
  CalendarAuthError,
  CalendarTransientError,
  type ProviderContext,
  type WriteResult,
} from "../provider.js";

/**
 * カレンダー用の Microsoft Graph の呼び出し (graph-client.ts の薄い代わり)。
 * 既存の GraphClient は If-Match などのヘッダーを足せず、429 を中で待ってしまうので、
 * カレンダーではこちらを使う。エラーの型 (GraphError) は既存のものをそのまま使う。
 * - 401 は 1 回だけトークンを取り直し、それでも 401 なら CalendarAuthError (再ログイン)。
 * - 429 / 503 / 504 で Retry-After があれば CalendarTransientError (土台が待ってやり直す)。
 * - そのほかの失敗は GraphError を投げる (呼び出し側で gone / conflict などに直す)。
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * 不変 ID (予定を別のカレンダーへ動かしても変わらない ID)、本文は書式無しのテキスト、
 * 1 ページ 100 件。
 */
const PREFER = [
  'IdType="ImmutableId"',
  'outlook.body-content-type="text"',
  "odata.maxpagesize=100",
].join(", ");

export type GraphResponse<T> = { status: number; body: T | undefined };

export type GraphPage<T> = {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

export class CalendarGraph {
  constructor(private readonly ctx: ProviderContext) {}

  private async token(force: boolean): Promise<string> {
    const { auth } = this.ctx;
    if (auth.type !== "oauth2") {
      throw new CalendarAuthError(
        "Microsoft のカレンダーには OAuth2 の認証情報が必要です。",
        { needsReauth: true },
      );
    }
    return auth.getAccessToken(force);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path).then((response) => response.body as T);
  }

  /** path は "/me/..." の形か、nextLink / deltaLink の完全な URL。 */
  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; ifMatch?: string | null } = {},
  ): Promise<GraphResponse<T>> {
    const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
    if (!url.startsWith(`${GRAPH_BASE}/`)) {
      // 保存しておいた続きの URL が書き換えられていても、トークンを外へ送らない。
      throw new Error("Microsoft Graph 以外の URL は呼び出せません。");
    }
    let refreshed = false;
    for (;;) {
      const token = await this.token(refreshed);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: PREFER,
      };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (options.ifMatch) headers["If-Match"] = options.ifMatch;
      const response = await this.ctx.fetchFn(url, {
        method,
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.any([
          this.ctx.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      if (response.ok) {
        if (response.status === 204 || response.status === 202) {
          await response.body?.cancel().catch(() => {});
          return { status: response.status, body: undefined };
        }
        const text = await response.text();
        return {
          status: response.status,
          body: (text ? JSON.parse(text) : undefined) as T | undefined,
        };
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        if (!refreshed) {
          refreshed = true;
          continue;
        }
        throw new CalendarAuthError(
          "Microsoft のカレンダーにアクセスできません。ログインし直してください。",
          { needsReauth: true },
        );
      }
      const failure = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      const error = new GraphError(
        response.status,
        failure.error?.code ?? "",
        failure.error?.message ?? "",
      );
      if ([429, 503, 504].includes(response.status)) {
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds >= 0) {
          throw new CalendarTransientError(
            `Microsoft Graph が混み合っています (HTTP ${response.status})。`,
            { retryAfterMs: seconds * 1000, cause: error },
          );
        }
      }
      throw error;
    }
  }

  /** nextLink をたどって全ページの value を集める (maxPages を超えたら打ち切る)。 */
  async getAll<T>(path: string, maxPages = 50): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const body: GraphPage<T> = await this.get<GraphPage<T>>(next);
      items.push(...(body?.value ?? []));
      next = body?.["@odata.nextLink"];
    }
    return items;
  }
}

/**
 * 書き込みの失敗を WriteResult に直す。直せない (一時的な失敗など) ものは投げ直す。
 * - 404 / 410 → gone
 * - 412 (If-Match の不一致)、409 の競合 → conflict
 * - そのほかの 4xx → rejected
 */
export function writeFailure(error: unknown): WriteResult {
  if (!(error instanceof GraphError)) throw error;
  if (error.status === 404 || error.status === 410) return { status: "gone" };
  if (
    error.status === 412 ||
    (error.status === 409 && /conflict/i.test(error.code))
  ) {
    return { status: "conflict" };
  }
  if (error.status >= 400 && error.status < 500 && error.status !== 429) {
    return {
      status: "rejected",
      reason: `Microsoft のカレンダーが書き込みを受け付けませんでした (${error.code || `HTTP ${error.status}`}): ${error.message}`,
    };
  }
  throw error;
}

export { GraphError };
