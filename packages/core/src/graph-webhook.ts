import { createHmac, timingSafeEqual } from "node:crypto";

/** 変更通知を受ける API のパス (/v1 より後ろ)。 */
export const GRAPH_WEBHOOK_PATH = "/webhooks/microsoft";

/**
 * Microsoft Graph の変更通知 (Webhook) の受け口の URL を返す。
 * Graph は公開された HTTPS の URL にしか通知を送らないので、API の公開 URL が
 * HTTPS でない場合や localhost の場合は null を返す (その場合は定期的な確認だけで同期する)。
 * https://learn.microsoft.com/graph/change-notifications-delivery-webhooks
 */
export function graphWebhookBaseUrl(
  publicUrl: string | undefined,
): string | null {
  if (!publicUrl) return null;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  ) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1${GRAPH_WEBHOOK_PATH}`;
}

/** アカウントごとの通知先。どのアカウントの通知かを URL で見分ける。 */
export function graphWebhookUrl(baseUrl: string, accountId: string): string {
  return `${baseUrl}?account=${encodeURIComponent(accountId)}`;
}

/**
 * 購読に付ける合言葉 (clientState)。Graph は通知のたびにこれを送り返すので、
 * 通知が本当に Graph から来たものかを確かめられる。鍵から計算するので保存は不要。
 */
export function graphClientState(key: Buffer, accountId: string): string {
  return createHmac("sha256", key)
    .update(`graph-webhook:${accountId}`)
    .digest("hex");
}

export function verifyGraphClientState(
  key: Buffer,
  accountId: string,
  clientState: unknown,
): boolean {
  if (typeof clientState !== "string") return false;
  const expected = Buffer.from(graphClientState(key, accountId));
  const actual = Buffer.from(clientState);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
