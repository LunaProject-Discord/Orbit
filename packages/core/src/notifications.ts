import type { NewMailItem, NewMailNotification } from "./events.js";
import {
  type PushActionSigner,
  type PushActions,
  toPushActions,
} from "./notification-actions.js";

/**
 * 新着メールの通知。同期ワーカーが検出し、Web Push (ブラウザーを閉じていても届く) と
 * SSE (開いている画面へ届く) の両方で同じ内容を端末へ伝える。
 */

/** 1 回の同期で届いたメールのうち、1 通ずつ通知する数の上限。超えたら 1 件にまとめる。 */
export const MAX_SINGLE_NOTIFICATIONS = 3;
/** NOTIFY に載せるメールの数の上限。 */
export const MAX_NOTIFIED_ITEMS = 5;
/** これより前に受信したメールは、新着として通知しない (過去のメールを取り込んだときに備える)。 */
export const NEW_MAIL_MAX_AGE_MS = 24 * 60 * 60_000;

const MAX_FROM = 80;
const MAX_SUBJECT = 150;
/**
 * 通知に出す本文の冒頭の長さ。NOTIFY は 8000 バイトまでなので、1 通ずつ知らせるとき
 * (MAX_SINGLE_NOTIFICATIONS 通まで) にだけ付ける。
 */
export const MAX_PREVIEW = 300;

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** 端末に出す通知 1 件分。 */
export type PushMessage = {
  title: string;
  body: string;
  /** 同じ値の通知は置き換わる (複数のタブや再送で二重に出さないため)。 */
  tag: string;
  /** 押したときに開くメール。まとめた通知では null (受信トレイを開く)。 */
  messageId: string | null;
  /** 届いたアカウント。アプリは、通知をアカウントごとに分ける (通知の分類とまとまり)。 */
  accountId?: string;
  accountName?: string;
  /** 本文の冒頭。件名 (body) の下に出す。分からないときと、まとめた通知では付けない。 */
  preview?: string;
  /** 通知に付けるボタン。まとめた通知と、ボタンを使わない設定では付けない。 */
  actions?: PushActions;
};

/** 取り込んだメールのうち、新着として通知するもの。 */
export type NewMailCandidate = {
  id: string;
  from: { name?: string; address: string }[];
  subject: string;
  /** 本文の冒頭 (空白を詰めた 1 行)。分からなければ省く。 */
  preview?: string;
  seen: boolean;
  receivedAt: Date;
};

/**
 * 新着として通知するメールを選び、NOTIFY に載せる形にする。
 * 既読のもの (ほかの端末で読んだ、自分で移したなど) と、古いメールは通知しない。
 * 通知するものが無ければ null。
 */
export function toNewMailNotification(
  account: { id: string; userId: string; name?: string | null },
  candidates: NewMailCandidate[],
  now = Date.now(),
): NewMailNotification | null {
  const fresh = candidates
    .filter(
      (item) =>
        !item.seen && now - item.receivedAt.getTime() <= NEW_MAIL_MAX_AGE_MS,
    )
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  if (fresh.length === 0) return null;
  const single = fresh.length <= MAX_SINGLE_NOTIFICATIONS;
  return {
    userId: account.userId,
    accountId: account.id,
    ...(account.name?.trim()
      ? { accountName: truncate(account.name.trim(), MAX_FROM) }
      : {}),
    count: fresh.length,
    messages: fresh.slice(0, MAX_NOTIFIED_ITEMS).map((item): NewMailItem => {
      const sender = item.from[0];
      const preview = single ? item.preview?.trim() : "";
      return {
        id: item.id,
        from: truncate(sender?.name?.trim() || sender?.address || "", MAX_FROM),
        subject: truncate(item.subject, MAX_SUBJECT),
        ...(preview ? { preview: truncate(preview, MAX_PREVIEW) } : {}),
      };
    }),
  };
}

/**
 * 新着メールの知らせを、端末に出す通知へ変える。多いときは 1 件にまとめる。
 * signer を渡すと、1 通ずつの通知にボタンを付ける。
 */
export function toPushMessages(
  notification: Pick<
    NewMailNotification,
    "accountId" | "accountName" | "messages" | "count"
  >,
  signer?: PushActionSigner | null,
): PushMessage[] {
  const { messages, count } = notification;
  const account = {
    accountId: notification.accountId,
    ...(notification.accountName
      ? { accountName: notification.accountName }
      : {}),
  };
  if (count <= MAX_SINGLE_NOTIFICATIONS && messages.length >= count) {
    return messages.map((message) => {
      const actions = toPushActions(signer, message.id);
      return {
        title: message.from || "新着メール",
        body: message.subject || "(件名なし)",
        tag: `mail:${message.id}`,
        messageId: message.id,
        ...account,
        ...(message.preview ? { preview: message.preview } : {}),
        ...(actions ? { actions } : {}),
      };
    });
  }
  const senders = [
    ...new Set(messages.map((message) => message.from).filter(Boolean)),
  ];
  const first = messages[0];
  return [
    {
      title: `新着メール ${count} 件`,
      body:
        senders.length > 0
          ? `${senders.slice(0, 3).join("、")}${senders.length > 3 || count > messages.length ? " ほか" : ""}`
          : "",
      // まとめた通知は、届くたびに別の通知として出す。
      tag: `mail-batch:${notification.accountId}:${first?.id ?? count}`,
      messageId: null,
      ...account,
    },
  ];
}

/** Web Push の設定 (VAPID)。3 つとも揃っていなければ null で、Web Push は使わない。 */
export type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  /** プッシュサービスが運営者へ連絡するための宛先 (mailto: または https: の URL)。 */
  subject: string;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function loadWebPushConfig(
  env: Record<string, string | undefined>,
): WebPushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  if (!BASE64URL.test(publicKey) || !BASE64URL.test(privateKey)) {
    throw new Error(
      "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY は base64url で指定してください (`pnpm env:init` で生成できます)。",
    );
  }
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:admin@localhost";
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error(
      "VAPID_SUBJECT は mailto: か https:// で始まる値にしてください。",
    );
  }
  return { publicKey, privateKey, subject };
}

/**
 * Web Push の送り先として受け付けるホスト。送り先の URL は端末が申告するので、
 * 主要なブラウザーのプッシュサービス以外には送らない (サーバーから任意の URL へ
 * リクエストを送らせないため)。
 */
const PUSH_HOSTS = [
  // Chrome、Edge (Chromium)、Android
  "fcm.googleapis.com",
  "android.googleapis.com",
  // Firefox
  "push.services.mozilla.com",
  // Safari (macOS、iOS)
  "push.apple.com",
  // Edge (旧)、Windows
  "notify.windows.com",
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}
