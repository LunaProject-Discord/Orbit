import { describe, expect, it } from "vitest";
import { describeFetchFailure, fetchOrExplain } from "./network-error.js";

function failure(cause: unknown) {
  return new TypeError("fetch failed", { cause });
}

describe("describeFetchFailure", () => {
  it("cause にある本当の理由を取り出す", () => {
    const cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"),
      { code: "ENOTFOUND" },
    );
    expect(describeFetchFailure(failure(cause))).toBe(
      "getaddrinfo ENOTFOUND login.microsoftonline.com",
    );
  });

  it("複数のアドレスを試して全部失敗した場合は、それぞれの理由を並べる", () => {
    const cause = Object.assign(new AggregateError([], ""), {
      code: "ETIMEDOUT",
      errors: [
        Object.assign(new Error("connect ETIMEDOUT 20.190.144.1:443"), {
          code: "ETIMEDOUT",
        }),
        Object.assign(new Error("connect ENETUNREACH 2603:1036::1:443"), {
          code: "ENETUNREACH",
        }),
      ],
    });
    expect(describeFetchFailure(failure(cause))).toBe(
      "connect ETIMEDOUT 20.190.144.1:443 / connect ENETUNREACH 2603:1036::1:443",
    );
  });

  it("メッセージにコードが無ければコードを添える", () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(describeFetchFailure(failure(cause))).toBe(
      "UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error",
    );
  });

  it("タイムアウトと、原因の無い失敗も説明できる", () => {
    expect(
      describeFetchFailure(new DOMException("aborted", "TimeoutError")),
    ).toBe("時間内に応答がありませんでした");
    expect(describeFetchFailure(new TypeError("fetch failed"))).toBe(
      "fetch failed",
    );
  });
});

describe("fetchOrExplain", () => {
  it("接続に失敗したら、接続先と理由を含むエラーにする", async () => {
    const cause = Object.assign(new Error("self-signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    const fetchFn = (async () => {
      throw failure(cause);
    }) as unknown as typeof fetch;
    await expect(
      fetchOrExplain(
        fetchFn,
        "https://graph.microsoft.com/v1.0/me",
        {},
        "Microsoft Graph",
      ),
    ).rejects.toThrow(
      "Microsoft Graph (graph.microsoft.com) に接続できませんでした: DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate",
    );
  });

  it("HTTP のエラー応答はそのまま返す", async () => {
    const fetchFn = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const response = await fetchOrExplain(
      fetchFn,
      "https://example.com/",
      {},
      "x",
    );
    expect(response.status).toBe(500);
  });
});
