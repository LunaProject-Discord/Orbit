import { NOTIFICATION_EVENT_ACTION_PATH } from "@orbit/core/calendar-notifications";

/**
 * 通知の出欠のボタンが合言葉を送ってよい URL か (段取り 9 のレビュー M4)。
 * 自分の API (apiBase = 画面が使っている API の URL) の POST /v1/notification-actions/event だけを許す。
 * 同じ決まりを public/sw.js (isEventActionUrl) と Android の EventActionReceiver.allowedUrl にも置く。
 */
export function isEventActionUrl(url: unknown, apiBase: string): boolean {
  if (typeof url !== "string") return false;
  let target: URL;
  let api: URL;
  try {
    target = new URL(url);
    api = new URL(apiBase);
  } catch {
    return false;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  if (target.username || target.password || target.search || target.hash) {
    return false;
  }
  const basePath = api.pathname.replace(/\/+$/, "");
  return (
    target.origin === api.origin &&
    target.pathname === `${basePath}/v1${NOTIFICATION_EVENT_ACTION_PATH}`
  );
}
