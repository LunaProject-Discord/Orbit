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
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
    if (!url.startsWith(`${GRAPH_BASE}/`)) {
      // 保存しておいた続きの URL が書き換えられていても、トークンを外へ送らない。
      throw new Error("Microsoft Graph 以外の URL は呼び出せません。");
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(false);
      const response = await this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          // 不変 ID: フォルダを移動しても変わらない ID を返してもらう。
          Prefer: 'IdType="ImmutableId", odata.maxpagesize=100',
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return (await response.json()) as T;
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
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      throw new GraphError(
        response.status,
        body.error?.code ?? "",
        body.error?.message ?? "",
      );
    }
  }
}
