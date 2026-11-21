const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

export class GraphError extends Error {
  constructor(
    readonly status: number,
    /** ErrorItemNotFound など、Graph が返すエラーコード。取れなければ空文字。 */
    readonly code: string,
    message: string,
  ) {
    super(message || code || `HTTP ${status}`);
    this.name = "GraphError";
  }

  /** 対象が存在しない (消された、移動された)。 */
  get notFound() {
    return this.status === 404;
  }

  /**
   * 差分取得の続きが無効になった。最初から取り直す必要がある。
   * https://learn.microsoft.com/graph/delta-query-overview
   */
  get syncStateInvalid() {
    return (
      this.status === 410 ||
      /^(syncStateNotFound|resyncRequired)$/i.test(this.code)
    );
  }
}

/** JSON にせず、そのままの文字列で送る本文。 */
export type RawBody = { raw: string; contentType: string };

function isRawBody(body: unknown): body is RawBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as RawBody).raw === "string" &&
    typeof (body as RawBody).contentType === "string"
  );
}

export type GraphPage<T> = {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

type Options = {
  /** アクセストークンを返す。force が true なら必ず取り直す。 */
  getToken: (force: boolean) => Promise<string>;
  fetchFn?: typeof fetch;
  /** 待ち時間の実装 (テストで差し替える)。 */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Microsoft Graph の呼び出し。トークンの付与、期限切れ時の取り直し、
 * 制限 (429) や一時的な障害 (503 / 504) の再試行をまとめて扱う。
 */
export class GraphClient {
  private readonly getToken: Options["getToken"];
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: Options) {
    this.getToken = options.getToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** path は "/me/..." の形か、nextLink / deltaLink の完全な URL。 */
  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, undefined, signal);
  }

  /**
   * 書き込みを含む呼び出し。本文の無い応答 (202、204 など) では undefined を返す。
   * body に RawBody を渡すと、JSON にせずそのままの文字列で送る (MIME 形式の送信用)。
   */
  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const raw = isRawBody(body) ? body : null;
    const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
    if (!url.startsWith(`${GRAPH_BASE}/`)) {
      // 保存しておいた続きの URL が書き換えられていても、トークンを外へ送らない。
      throw new Error("Microsoft Graph 以外の URL は呼び出せません。");
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(false);
      const response = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          // 不変 ID: フォルダを移動しても変わらない ID を返してもらう。
          Prefer: 'IdType="ImmutableId", odata.maxpagesize=100',
          ...(body === undefined
            ? {}
            : { "Content-Type": raw ? raw.contentType : "application/json" }),
        },
        ...(body === undefined
          ? {}
          : { body: raw ? raw.raw : JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      const retryable = [429, 503, 504].includes(response.status);
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 2_000;
        await response.body?.cancel().catch(() => {});
        await this.sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
        continue;
      }
      const failure = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      throw new GraphError(
        response.status,
        failure.error?.code ?? "",
        failure.error?.message ?? "",
      );
    }
  }
}
