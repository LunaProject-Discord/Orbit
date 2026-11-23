import {
  deletePushDevice,
  getNativePushAvailable,
  savePushDevice,
} from "@/lib/api";
import { loadAppShell } from "@/lib/native/app";

/**
 * スマホアプリ (Capacitor) での新着メールの通知。
 * Android は FCM。端末のトークンをサーバーへ登録すると、同期ワーカーが FCM 経由で通知を送る。
 * 通知はアプリを閉じていても Android が表示し、押すとアプリが開いてそのメールを表示する。
 */

/** lib/notifications.ts の NotificationStatus のうち、アプリで使うもの。 */
export type NativePushStatus = "unsupported" | "off" | "blocked" | "push";

/** サーバーへ登録した端末のトークン。ログアウトや無効化のときに消すために覚えておく。 */
const TOKEN_KEY = "mail.push-device-token";
/** 通知の分類 (Android の通知チャンネル)。サーバーが送る通知の channel_id と合わせる。 */
export const NEW_MAIL_CHANNEL = "new-mail";
/**
 * アカウントごとの通知の分類の ID の先頭 (後ろにアカウントの ID が付く)。
 * アプリ側 (MailNotifications.java) と合わせる。
 */
export const ACCOUNT_CHANNEL_PREFIX = "new-mail-";
const CHANNEL_DESCRIPTION = "新しいメールが届いたときに知らせます";
const REGISTER_TIMEOUT_MS = 20_000;

function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 覚えられなくても通知は届く (消すときにサーバー側の送り先が残るだけ)。
  }
}

/** Firebase の設定を入れてビルドしたアプリか (入っていなければ通知を登録できない)。 */
async function pushConfigured(): Promise<boolean> {
  const { AppShell } = await loadAppShell();
  return (await AppShell.isPushConfigured()).configured;
}

/** 端末の許可の状態を、画面で使う 3 つの値にそろえる。 */
export function permissionOf(receive: string): "granted" | "denied" | "prompt" {
  if (receive === "granted") return "granted";
  if (receive === "denied") return "denied";
  return "prompt";
}

/** FCM に端末を登録し、発行されたトークンを受け取る。 */
async function registerDevice(): Promise<string> {
  const { PushNotifications: push } = await import(
    "@capacitor/push-notifications"
  );
  return await new Promise<string>((resolve, reject) => {
    const handles: Promise<{ remove: () => Promise<void> }>[] = [];
    const finish = () => {
      clearTimeout(timer);
      for (const handle of handles) void handle.then((h) => h.remove());
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("timeout"));
    }, REGISTER_TIMEOUT_MS);
    handles.push(
      push.addListener("registration", (token) => {
        finish();
        resolve(token.value);
      }),
      push.addListener("registrationError", (error) => {
        finish();
        reject(new Error(error.error));
      }),
    );
    Promise.all(handles)
      .then(() => push.register())
      .catch((error) => {
        finish();
        reject(error);
      });
  });
}

/**
 * 通知を使える状態にそろえる。enabled は、この端末で通知を有効にしているか。
 * 画面を開いたときにも呼び、トークンが変わっていればサーバーの送り先を更新する。
 */
export async function syncNativePush(
  enabled: boolean,
): Promise<NativePushStatus> {
  try {
    // Firebase の設定を入れずにビルドしたアプリでは、通知を登録できない。
    if (!(await pushConfigured())) return "unsupported";
    const { PushNotifications: push } = await import(
      "@capacitor/push-notifications"
    );
    const permission = permissionOf((await push.checkPermissions()).receive);
    if (permission === "denied") return "blocked";
    if (!enabled || permission !== "granted") return "off";
    if (!(await getNativePushAvailable())) return "unsupported";
    await push.createChannel({
      id: NEW_MAIL_CHANNEL,
      name: "新着メール",
      description: CHANNEL_DESCRIPTION,
      // 4 = 音とポップアップで知らせる (利用者は Android の設定で変えられる)。
      importance: 4,
      visibility: 0,
    });
    const token = await registerDevice();
    const previous = storedToken();
    if (previous && previous !== token) {
      await deletePushDevice(previous).catch(() => {});
    }
    await savePushDevice({ platform: "android", token });
    storeToken(token);
    return "push";
  } catch {
    return "off";
  }
}

type ChannelAccount = { id: string; email: string; displayName: string | null };

/** 分類の一覧をアカウントにそろえるために、作るものと消すものを決める。 */
export function planAccountChannels(
  accounts: ChannelAccount[],
  existing: { id: string; name: string }[],
): { create: { id: string; name: string }[]; remove: string[] } {
  const wanted = new Map(
    accounts.map((account) => [
      `${ACCOUNT_CHANNEL_PREFIX}${account.id}`,
      account.displayName?.trim() || account.email,
    ]),
  );
  const names = new Map(existing.map((channel) => [channel.id, channel.name]));
  return {
    // 名前が同じものは作り直さない。
    create: [...wanted]
      .filter(([id, name]) => names.get(id) !== name)
      .map(([id, name]) => ({ id, name })),
    remove: existing
      .map((channel) => channel.id)
      .filter((id) => id.startsWith(ACCOUNT_CHANNEL_PREFIX) && !wanted.has(id)),
  };
}

/**
 * アカウントごとの通知の分類 (Android の通知チャンネル) を、いまのアカウントにそろえる。
 * 分類があると、Android の設定でアカウントごとに音やオン / オフを変えられる。
 * すでにある分類は名前だけが変わり、利用者が変えた設定は残る。削除したアカウントの分は消す。
 */
export async function syncAccountChannels(
  accounts: ChannelAccount[],
): Promise<void> {
  try {
    const { PushNotifications: push } = await import(
      "@capacitor/push-notifications"
    );
    const { channels } = await push.listChannels();
    const plan = planAccountChannels(accounts, channels);
    for (const channel of plan.create) {
      await push.createChannel({
        ...channel,
        description: CHANNEL_DESCRIPTION,
        importance: 4,
        visibility: 0,
      });
    }
    for (const id of plan.remove) await push.deleteChannel({ id });
  } catch {
    // そろえられなくても、通知が届いたときにアプリが分類を作る。
  }
}

/** 通知の許可を尋ねてから有効にする。ボタンを押した操作の中で呼ぶ。 */
export async function enableNativePush(): Promise<NativePushStatus> {
  try {
    if (!(await pushConfigured())) return "unsupported";
    const { PushNotifications: push } = await import(
      "@capacitor/push-notifications"
    );
    let permission = permissionOf((await push.checkPermissions()).receive);
    if (permission === "prompt") {
      permission = permissionOf((await push.requestPermissions()).receive);
    }
    if (permission === "denied") return "blocked";
    if (permission !== "granted") return "off";
  } catch {
    return "off";
  }
  return syncNativePush(true);
}

/** この端末への通知を止める。toServer が true なら、サーバーの送り先も消す。 */
export async function releaseNativePush(toServer: boolean): Promise<void> {
  const token = storedToken();
  if (!token) return;
  storeToken(null);
  try {
    if (toServer) await deletePushDevice(token).catch(() => {});
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.unregister();
  } catch {
    // 止められなくても、画面の操作は続けられる。
  }
}

/** 許可の状態だけを調べる (通知を無効にしたあとの表示用)。 */
export async function nativePushOffStatus(): Promise<NativePushStatus> {
  try {
    if (!(await pushConfigured())) return "unsupported";
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const { receive } = await PushNotifications.checkPermissions();
    return permissionOf(receive) === "denied" ? "blocked" : "off";
  } catch {
    return "off";
  }
}

/** 通知が押されたときに、開くメールの ID (無ければ null) を受け取る。戻り値の関数で解除する。 */
export function onNativePushOpen(
  listener: (messageId: string | null) => void,
): () => void {
  let cancelled = false;
  let remove: (() => void) | null = null;
  void (async () => {
    try {
      const { PushNotifications } = await import(
        "@capacitor/push-notifications"
      );
      const handle = await PushNotifications.addListener(
        "pushNotificationActionPerformed",
        (action) => {
          const data = action.notification.data as
            | { messageId?: unknown }
            | undefined;
          listener(
            typeof data?.messageId === "string" && data.messageId
              ? data.messageId
              : null,
          );
        },
      );
      if (cancelled) void handle.remove();
      else remove = () => void handle.remove();
    } catch {
      // 登録できなくても、通知からアプリは開く (受信トレイが表示される)。
    }
  })();
  return () => {
    cancelled = true;
    remove?.();
  };
}
