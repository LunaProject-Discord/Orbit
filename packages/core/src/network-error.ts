type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
};

function partOf(error: ErrorLike): string {
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (code && message.includes(code)) return message;
  return [code, message].filter(Boolean).join(": ");
}

/**
 * fetch の失敗理由を、原因 (cause) までたどって 1 行にまとめる。
 * Node の fetch は接続に失敗すると "fetch failed" とだけ言い、DNS、タイムアウト、
 * TLS などの本当の理由は cause の中にある。複数のアドレスを試して全部失敗した場合は、
 * それぞれの理由が errors に入る。
 */
export function describeFetchFailure(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const top = error as ErrorLike;
  if (top.name === "TimeoutError" || top.name === "AbortError") {
    return "時間内に応答がありませんでした";
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4) {
      return;
    }
    seen.add(value);
    const item = value as ErrorLike;
    if (Array.isArray(item.errors) && item.errors.length > 0) {
      for (const inner of item.errors) visit(inner, depth + 1);
    } else {
      const part = partOf(item);
      if (part && part !== "fetch failed" && !parts.includes(part)) {
        parts.push(part);
      }
    }
    visit(item.cause, depth + 1);
  };
  visit(error, 0);
  const summary = parts.slice(0, 4).join(" / ");
  return summary || (typeof top.message === "string" ? top.message : "不明");
}

/**
 * fetch を呼び、接続そのものに失敗したら「どこに」「なぜ」つながらなかったかを
 * 含むエラーに置き換える。HTTP のエラー応答 (4xx / 5xx) はそのまま返す。
 */
export async function fetchOrExplain(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  /** エラー文に出す接続先の説明 (例: "Microsoft のログインサーバー")。 */
  target: string,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    throw new Error(
      `${target} (${new URL(url).host}) に接続できませんでした: ${describeFetchFailure(error)}`,
      { cause: error },
    );
  }
}
