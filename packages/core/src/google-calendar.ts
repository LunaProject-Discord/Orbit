import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Google Calendar API の変更通知 (events.watch) で、worker と API が共有するもの。
 * https://developers.google.com/workspace/calendar/api/guides/push
 */

/** 変更通知を受ける API のパス (/v1 より後ろ)。 */
export const GOOGLE_CALENDAR_WEBHOOK_PATH = "/webhooks/google-calendar";

/**
 * 変更通知の送り先 (watch の address)。base は worker に渡る Webhook の土台の URL。
 * 「https://host/v1」でも、Graph のメール用の受け口 (「https://host/v1/webhooks/microsoft」) でも
 * 受け付け、末尾の /webhooks/... を外して Google の受け口に付け替える。
 * Google は有効な証明書の HTTPS にしか送らないので、HTTPS でなければ null。
 */
export function googleCalendarWebhookUrl(base: string | null): string | null {
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/webhooks\/[^/]+$/, "");
  if (!/\/v1$/.test(path)) path = `${path}/v1`;
  return `${url.origin}${path}${GOOGLE_CALENDAR_WEBHOOK_PATH}`;
}

/**
 * チャンネルに付ける合言葉 (watch の token)。Google は通知のたびに X-Goog-Channel-Token で
 * 送り返すので、通知が本当に自分の作ったチャンネルのものかを確かめられる。チャンネル ID は
 * 推測できない UUID で、鍵から計算するので保存は要らない (秘密の鍵が無いと作れない)。
 */
export function googleCalendarChannelToken(
  key: Buffer,
  channelId: string,
): string {
  return createHmac("sha256", key)
    .update(`google-calendar-webhook:${channelId}`)
    .digest("hex");
}

export function verifyGoogleCalendarChannelToken(
  key: Buffer,
  channelId: string,
  token: unknown,
): boolean {
  if (typeof token !== "string") return false;
  const expected = Buffer.from(googleCalendarChannelToken(key, channelId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
