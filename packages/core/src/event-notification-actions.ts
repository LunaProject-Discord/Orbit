import { createHmac, timingSafeEqual } from "node:crypto";
import { NOTIFICATION_EVENT_ACTION_PATH } from "./calendar-notifications.js";

/**
 * 招待の通知に付ける出欠のボタン (参加 / 未定 / 不参加) の合言葉 (段取り 9、設計 4.2、7 章の 3)。
 * Node 専用 (node:crypto)。ブラウザーから読む calendar-notifications.ts には入れない。
 *
 * メールのボタンの合言葉 (notification-actions.ts) と署名する文字列を分ける
 * ("notification-event-action:" で始める)。メールの合言葉を予定の出欠に使い回せない。
 * 合言葉はその利用者のその予定 1 件の出欠だけを、期限まで認める。
 */

/** 合言葉の有効期間 (7 日)。 */
export const EVENT_NOTIFICATION_ACTION_TTL_MS = 7 * 24 * 60 * 60_000;

function signature(
  key: Buffer,
  userId: string,
  eventId: string,
  expiresAt: number,
): string {
  return createHmac("sha256", key)
    .update(`notification-event-action:${userId}:${eventId}:${expiresAt}`)
    .digest("base64url");
}

/** 出欠のボタンの合言葉。形は「期限 (ミリ秒).署名」。 */
export function signEventNotificationAction(
  key: Buffer,
  userId: string,
  eventId: string,
  now = Date.now(),
): string {
  const expiresAt = now + EVENT_NOTIFICATION_ACTION_TTL_MS;
  return `${expiresAt}.${signature(key, userId, eventId, expiresAt)}`;
}

export function verifyEventNotificationAction(
  key: Buffer,
  userId: string,
  eventId: string,
  token: unknown,
  now = Date.now(),
): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(signature(key, userId, eventId, expiresAt));
  const actual = Buffer.from(token.slice(dot + 1));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 通知からの出欠を受け付ける URL。API の公開 URL が分からなければ null (ボタンを付けない)。 */
export function notificationEventActionUrl(
  publicUrl: string | undefined,
): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1${NOTIFICATION_EVENT_ACTION_PATH}`;
  } catch {
    return null;
  }
}
