import type { ImapFlow } from "imapflow";

/**
 * ImapFlow は、サーバーに拒否された命令 (NO / BAD) の多くを例外にせず false で返すので、
 * そのままでは「なぜ拒否されたか」が分からない。拒否の内容はログ (warn) には流れるので、
 * 接続ごとに覚えておき、失敗の理由として利用者に見せられるようにする。覚えるのは、
 * clearRejection の後で最初に拒否された 1 件 (代わりの方法を試した後の応答より、
 * 最初の命令への応答のほうが原因を表している)。
 */
type Recorder = { first: string | null };

const recorders = new WeakMap<object, Recorder>();

type LogEntry = {
  err?: {
    responseStatus?: unknown;
    responseText?: unknown;
    serverResponseCode?: unknown;
    message?: unknown;
  };
};

/** ログの 1 件から、サーバーの応答 (「NO [CANNOT] ...」の形) を取り出す。無ければ null。 */
export function rejectionText(entry: unknown): string | null {
  const err = (entry as LogEntry | null)?.err;
  if (!err || typeof err !== "object") return null;
  const status =
    typeof err.responseStatus === "string" ? err.responseStatus : "";
  if (status !== "NO" && status !== "BAD") return null;
  const code =
    typeof err.serverResponseCode === "string" && err.serverResponseCode
      ? `[${err.serverResponseCode}]`
      : "";
  const text = typeof err.responseText === "string" ? err.responseText : "";
  // 応答文にコードが含まれているサーバーもあるので、重ねて出さない。
  const parts = [status, text.includes(code) ? "" : code, text]
    .map((part) => part.trim())
    .filter(Boolean);
  // 長い応答や改行で、失敗の一覧が崩れないようにする。
  return parts.join(" ").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * ImapFlow に渡すロガーと、接続に結び付ける関数を作る。
 * 拒否の内容だけを覚え、ほかのログは捨てる (これまでの logger: false と同じ)。
 */
export function createRejectionLogger() {
  const recorder: Recorder = { first: null };
  const ignore = () => {};
  return {
    logger: {
      debug: ignore,
      info: ignore,
      error: ignore,
      warn: (entry: unknown) => {
        const text = rejectionText(entry);
        if (text) recorder.first ??= text;
      },
    },
    /** 作った接続に結び付ける。 */
    attach: (client: ImapFlow) => {
      recorders.set(client, recorder);
    },
  };
}

/** これまでに覚えた拒否の内容を忘れる (これから実行する命令の分だけを取り出すため)。 */
export function clearRejection(client: ImapFlow): void {
  const recorder = recorders.get(client);
  if (recorder) recorder.first = null;
}

/** clearRejection の後で最初に拒否された命令への、サーバーの応答。分からなければ null。 */
export function firstRejection(client: ImapFlow): string | null {
  return recorders.get(client)?.first ?? null;
}
