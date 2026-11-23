import { MicrosoftOAuthError, type OutgoingMessage } from "@orbit/core";
import { type GraphClient, GraphError } from "./graph-client.js";
import { buildMime } from "./mime.js";
import type { SendOutcome } from "./send.js";

/**
 * Microsoft Graph でメールを 1 通送る。MIME 形式のまま渡すので、
 * 返信の In-Reply-To / References もそのまま相手に届く。
 * 送信済みアイテムには Graph が自動で保存する。
 * https://learn.microsoft.com/graph/api/user-sendmail
 */
export async function sendViaGraph(
  client: GraphClient,
  message: OutgoingMessage,
  signal?: AbortSignal,
): Promise<SendOutcome> {
  const mime = await buildMime(message, { keepBcc: true });
  try {
    await client.request(
      "POST",
      "/me/sendMail",
      { raw: mime.toString("base64"), contentType: "text/plain" },
      signal,
    );
    return { status: "sent" };
  } catch (error) {
    const err = error as Error;
    if (err instanceof GraphError) {
      // 制限 (429) と障害 (5xx) は時間を置けば通る。401 はトークンの取り直しで直ることがある。
      if (err.status === 401 || err.status === 429 || err.status >= 500) {
        return { status: "retry", reason: err.message };
      }
      return {
        status: "failed",
        reason: `Microsoft に拒否されました: ${err.message}`,
      };
    }
    if (err instanceof MicrosoftOAuthError) {
      return { status: "retry", reason: err.message };
    }
    if (err.name === "TimeoutError") {
      // 応答を待っている間に時間切れになった。受け付けられたかどうかは分からない。
      return {
        status: "failed",
        reason:
          "Microsoft からの応答がありませんでした。相手に届いているか確認してから送り直してください。",
      };
    }
    return { status: "retry", reason: err.message };
  }
}
