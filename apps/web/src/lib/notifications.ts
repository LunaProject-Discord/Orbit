import {
  deletePushSubscription,
  getPushPublicKey,
  type MailboxSummary,
  type MailNotification,
  type NotificationAction,
  savePushSubscription,
} from "@/lib/api";
import {
  isDesktopApp,
  listenDesktop,
  NOTIFICATION_ACTION_EVENT,
  notifyNewMail,
  OPEN_MESSAGE_EVENT,
  setDesktopUnreadCount,
} from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";
import {
  currentNotificationActions,
  isNotificationAction,
  NOTIFICATION_ACTIONS,
} from "@/lib/notification-actions";

/**
 * 新着メールの通知。
 * - push: サーバーからの Web Push をサービスワーカーが受けて通知する (画面を閉じていても届く)。
 * - page: Web Push が使えないとき。画面を開いている間だけ、SSE で届いた新着を通知する。
 * 有効にするかどうかは端末 (ブラウザー) ごとに選び、localStorage に覚えておく。
 *
 * デスクトップ版 (Tauri) は page と同じ仕組みで、SSE で届いた新着を OS の通知で出す。
 * ウィンドウを閉じても通知領域に残って動き続けるので、アプリを終了するまで届く。
 * メールソフトとして入れたものなので、切らない限り最初から有効にする。
 */
export type NotificationStatus =
  /** このブラウザーでは通知を出せない。 */
  | "unsupported"
  | "off"
  /** ブラウザーの設定で通知が拒否されている。 */
  | "blocked"
  | "page"
  | "push";

const SETTING_KEY = "mail.notifications";
/** メッセージの ID (UUID) の形。通知や URL から受け取った値を確かめる。 */
export const MESSAGE_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const APP_NAME = "Orbit";

/** 受信トレイの未読数の合計 (全アカウント分)。 */
export function inboxUnreadCount(
  mailboxes: Pick<MailboxSummary, "specialUse" | "unreadCount">[],
): number {
  return mailboxes.reduce(
    (sum, mailbox) =>
      mailbox.specialUse === "inbox" ? sum + mailbox.unreadCount : sum,
    0,
  );
}

/** タブに出す題名。未読があれば先頭に数を付ける。 */
export function unreadTitle(count: number): string {
  if (count <= 0) return APP_NAME;
  return `(${count > 999 ? "999+" : count}) ${APP_NAME}`;
}

/** VAPID の公開鍵 (base64url) を、購読に渡す形にする。 */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const left = new Uint8Array(a);
  return (
    left.length === b.length && left.every((byte, index) => byte === b[index])
  );
}

/** 保存した値から、通知が有効かどうかを決める。未設定のときはデスクトップ版だけ有効。 */
export function enabledFrom(stored: string | null, desktop: boolean): boolean {
  return desktop ? stored !== "off" : stored === "on";
}

function isEnabled(): boolean {
  try {
    return enabledFrom(
      window.localStorage.getItem(SETTING_KEY),
      isDesktopApp(),
    );
  } catch {
    return isDesktopApp();
  }
}

function setEnabled(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(SETTING_KEY, "on");
    else if (isDesktopApp()) window.localStorage.setItem(SETTING_KEY, "off");
    else window.localStorage.removeItem(SETTING_KEY);
  } catch {
    // 保存できなければ、このページを開いている間だけ有効になる。
  }
}

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Web Push の送り先を用意してサーバーへ登録する。使えなければ false
 * (サーバーに鍵が無い、ブラウザーが対応していない、プッシュサービスに届かないなど)。
 */
async function subscribePush(
  registration: ServiceWorkerRegistration | null,
): Promise<boolean> {
  if (!registration || !("PushManager" in window)) return false;
  try {
    const publicKey = await getPushPublicKey();
    if (!publicKey) return false;
    const key = decodeBase64Url(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    // サーバーの鍵が変わっていたら、古い送り先では届かないので作り直す。
    if (
      subscription &&
      !sameBytes(subscription.options.applicationServerKey, key)
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    const { endpoint, keys } = subscription.toJSON();
    if (!endpoint || !keys?.p256dh || !keys.auth) return false;
    await savePushSubscription({
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存した設定とブラウザーの許可に合わせて、通知の状態を整える。
 * 画面を開いたときに呼ぶ (ログインし直したあとの送り先の登録もここで行う)。
 */
export async function syncNotifications(): Promise<NotificationStatus> {
  if (isNativeApp()) {
    const { syncNativePush } = await import("@/lib/native/push");
    return syncNativePush(isEnabled());
  }
  // デスクトップ版は OS の許可を尋ねる必要がない (拒否は OS の設定側で行う)。
  if (isDesktopApp()) return isEnabled() ? "page" : "off";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (!isEnabled() || Notification.permission !== "granted") return "off";
  const registration = await registerWorker();
  return (await subscribePush(registration)) ? "push" : "page";
}

/** 通知を有効にする。ブラウザーが許可を尋ねるので、ボタンを押した操作の中で呼ぶ。 */
export async function enableNotifications(): Promise<NotificationStatus> {
  if (isNativeApp()) {
    const { enableNativePush } = await import("@/lib/native/push");
    const status = await enableNativePush();
    if (status === "push") setEnabled(true);
    return status;
  }
  if (isDesktopApp()) {
    setEnabled(true);
    return "page";
  }
  if (!supported()) return "unsupported";
  let permission: NotificationPermission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = Notification.permission;
    }
  }
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  setEnabled(true);
  return syncNotifications();
}

/**
 * このブラウザーへの Web Push を止める。toServer が true なら、サーバーの送り先も消す
 * (セッションが切れたあとは消せないが、次に送ろうとした時点でサーバー側が消す)。
 */
export async function releasePush(toServer: boolean): Promise<void> {
  if (isNativeApp()) {
    const { releaseNativePush } = await import("@/lib/native/push");
    return releaseNativePush(toServer);
  }
  // デスクトップ版はサーバーに送り先を登録していない。
  if (isDesktopApp()) return;
  try {
    const registration = await existingRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription) return;
    if (toServer) {
      await deletePushSubscription(subscription.endpoint).catch(() => {});
    }
    await subscription.unsubscribe();
  } catch {
    // 止められなくても、画面の操作は続けられる。
  }
}

export async function disableNotifications(): Promise<NotificationStatus> {
  setEnabled(false);
  await releasePush(true);
  if (isNativeApp()) {
    const { nativePushOffStatus } = await import("@/lib/native/push");
    return nativePushOffStatus();
  }
  if (isDesktopApp()) return "off";
  if (!supported()) return "unsupported";
  return Notification.permission === "denied" ? "blocked" : "off";
}

/**
 * 画面を開いている間の通知 (Web Push が使えないとき)。
 * サービスワーカーがあればそちらから出す (スマートフォンのブラウザーではページから
 * 直接は出せない)。押したときの処理は、どちらの場合も onOpen に届く。
 */
export async function showPageNotification(
  notification: MailNotification,
  onOpen: (messageId: string | null) => void,
): Promise<void> {
  // 件名の下に、本文の冒頭を出す。
  const body = notification.preview
    ? `${notification.body}\n${notification.preview}`
    : notification.body;
  if (isDesktopApp()) {
    // 押されたときは、アプリ側からのイベントが onNotificationOpen に届く。
    // ボタンと返信欄 (Windows のみ) の操作は onNotificationAction に届く。
    await notifyNewMail({
      title: notification.title,
      body,
      messageId: notification.messageId,
      ...(notification.messageId
        ? { buttons: desktopNotificationButtons(), reply: true }
        : {}),
    });
    return;
  }
  if (!supported() || Notification.permission !== "granted") return;
  const options = {
    body,
    tag: notification.tag,
    icon: "/icons/icon-192.png",
    data: { messageId: notification.messageId },
  };
  try {
    const registration = await existingRegistration();
    if (registration?.active) {
      await registration.showNotification(notification.title, options);
      return;
    }
    const shown = new Notification(notification.title, options);
    shown.onclick = () => {
      window.focus();
      shown.close();
      onOpen(notification.messageId);
    };
  } catch {
    // 通知を出せなくても、一覧には新着が表示される。
  }
}

/** デスクトップ版の通知に付けるボタン。利用者が設定で選んだもの (Web Push の通知と同じ)。 */
export function desktopNotificationButtons(): { id: string; title: string }[] {
  return currentNotificationActions().map((id) => ({
    id,
    title: NOTIFICATION_ACTIONS.find((action) => action.id === id)?.label ?? id,
  }));
}

/** 通知のボタン、または返信欄からの操作。 */
export type NotificationActionRequest =
  | { messageId: string; action: "reply"; text: string }
  | { messageId: string; action: NotificationAction };

/** アプリ側から届いた値を確かめる。形が違えば null。 */
export function parseNotificationAction(
  payload: unknown,
): NotificationActionRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const { messageId, action, text } = payload as Record<string, unknown>;
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) {
    return null;
  }
  if (action === "reply") {
    return typeof text === "string" && text.trim() !== ""
      ? { messageId, action, text }
      : null;
  }
  return isNotificationAction(action) ? { messageId, action } : null;
}

/**
 * 通知のボタンが押された、または返信欄から送られたときに受け取る (デスクトップ版の Windows)。
 * 戻り値の関数で解除する。
 */
export function onNotificationAction(
  listener: (request: NotificationActionRequest) => void,
): () => void {
  if (!isDesktopApp()) return () => {};
  return listenDesktop<unknown>(NOTIFICATION_ACTION_EVENT, (payload) => {
    const request = parseNotificationAction(payload);
    if (request) listener(request);
  });
}

/**
 * 通知が押されたときに、開くメールを受け取る (サービスワーカーからの知らせ)。
 * 戻り値の関数で解除する。
 */
export function onNotificationOpen(
  listener: (messageId: string | null) => void,
): () => void {
  const check = (messageId: string | null) =>
    listener(messageId && MESSAGE_ID.test(messageId) ? messageId : null);
  if (isNativeApp()) {
    let cancelled = false;
    let remove: (() => void) | null = null;
    void import("@/lib/native/push").then(({ onNativePushOpen }) => {
      const stop = onNativePushOpen(check);
      if (cancelled) stop();
      else remove = stop;
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }
  if (isDesktopApp()) {
    return listenDesktop<{ messageId?: unknown }>(
      OPEN_MESSAGE_EVENT,
      ({ messageId }) =>
        check(typeof messageId === "string" ? messageId : null),
    );
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; messageId?: unknown } | null;
    if (data?.type !== "open-message") return;
    const { messageId } = data;
    check(typeof messageId === "string" ? messageId : null);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () =>
    navigator.serviceWorker.removeEventListener("message", onMessage);
}

/** SSE の mail イベントの中身を取り出す。形式が違えば空。 */
export function parseMailEvent(data: string): MailNotification[] {
  try {
    const parsed = JSON.parse(data) as { notifications?: unknown };
    if (!Array.isArray(parsed.notifications)) return [];
    return parsed.notifications.filter(
      (item): item is MailNotification =>
        !!item &&
        typeof item === "object" &&
        typeof (item as MailNotification).title === "string" &&
        typeof (item as MailNotification).body === "string" &&
        typeof (item as MailNotification).tag === "string",
    );
  } catch {
    return [];
  }
}

/** タブの題名とアプリのアイコンに、受信トレイの未読数を出す。 */
export function showUnreadCount(count: number) {
  document.title = unreadTitle(count);
  if (isDesktopApp()) {
    setDesktopUnreadCount(count);
    return;
  }
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  // ホーム画面やタスクバーに置いたアプリのアイコンにも数を出す (対応している環境のみ)。
  const result = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
  result?.catch(() => {});
}
