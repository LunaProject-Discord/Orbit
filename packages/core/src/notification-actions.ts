import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 新着メールの通知に付けるボタン (既読にする、アーカイブなど)。
 * 押すと、画面を開かずにそのメールを操作する。どのボタンを出すかは利用者が設定で選ぶ。
 *
 * 通知から操作するときはログインの情報を使えない (サービスワーカーやアプリの通知の受け口は、
 * 画面のログイン状態を持っていない) ので、通知ごとに「このメールを操作してよい」ことを示す
 * 合言葉を付ける。合言葉はサーバーの鍵から計算するので、保存は不要。
 */

/** 通知に付けられるボタン。 */
export const NOTIFICATION_ACTIONS = [
  "read",
  "star",
  "archive",
  "delete",
  "junk",
] as const;

export type NotificationActionId = (typeof NOTIFICATION_ACTIONS)[number];

/** ボタンに出す文言。 */
export const NOTIFICATION_ACTION_TITLES: Record<NotificationActionId, string> =
  {
    read: "既読にする",
    star: "スターを付ける",
    archive: "アーカイブ",
    delete: "削除",
    junk: "迷惑メール",
  };

/** 通知に付けるボタンの数の上限 (Android の通知に並べられる数)。 */
export const MAX_NOTIFICATION_ACTIONS = 3;

/** 何も保存していない利用者の設定。 */
export const DEFAULT_NOTIFICATION_ACTIONS: readonly NotificationActionId[] = [
  "read",
  "archive",
  "delete",
];

const known = new Set<string>(NOTIFICATION_ACTIONS);

export function isNotificationAction(
  value: unknown,
): value is NotificationActionId {
  return typeof value === "string" && known.has(value);
}

/**
 * 保存してあった設定を読む。配列でなければ標準の値。知らないボタンと重複は捨て、
 * 上限までにする (空の配列は「ボタンを付けない」)。
 */
export function readNotificationActions(
  saved: unknown,
): NotificationActionId[] {
  if (!Array.isArray(saved)) return [...DEFAULT_NOTIFICATION_ACTIONS];
  const actions: NotificationActionId[] = [];
  for (const value of saved) {
    if (isNotificationAction(value) && !actions.includes(value)) {
      actions.push(value);
    }
  }
  return actions.slice(0, MAX_NOTIFICATION_ACTIONS);
}

/** 通知の操作を受け付ける API のパス (/v1 より後ろ)。 */
export const NOTIFICATION_ACTION_PATH = "/notification-actions";

/**
 * 通知の返信欄から返信を受け付ける API のパス (/v1 より後ろ)。
 * アプリは、ボタンの送り先 (PushActions.url) の後ろに "/reply" を付けて送る。
 */
export const NOTIFICATION_REPLY_PATH = `${NOTIFICATION_ACTION_PATH}/reply`;

/** 通知の返信欄に書ける文字数の上限。 */
export const MAX_NOTIFICATION_REPLY_LENGTH = 10_000;

/** 通知の操作を受け付ける URL。API の公開 URL が分からなければ null (ボタンを付けない)。 */
export function notificationActionUrl(
  publicUrl: string | undefined,
): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/v1${NOTIFICATION_ACTION_PATH}`;
  } catch {
    return null;
  }
}

/** 合言葉の有効期間。通知を出したままにしておける長さ。 */
export const NOTIFICATION_ACTION_TTL_MS = 7 * 24 * 60 * 60_000;

function signature(
  key: Buffer,
  userId: string,
  messageId: string,
  expiresAt: number,
): string {
  return createHmac("sha256", key)
    .update(`notification-action:${userId}:${messageId}:${expiresAt}`)
    .digest("base64url");
}

/**
 * 通知に付ける合言葉。その利用者のそのメール 1 通だけを、期限まで操作できる。
 * 形は「期限 (ミリ秒).署名」。
 */
export function signNotificationAction(
  key: Buffer,
  userId: string,
  messageId: string,
  now = Date.now(),
): string {
  const expiresAt = now + NOTIFICATION_ACTION_TTL_MS;
  return `${expiresAt}.${signature(key, userId, messageId, expiresAt)}`;
}

export function verifyNotificationAction(
  key: Buffer,
  userId: string,
  messageId: string,
  token: unknown,
  now = Date.now(),
): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(signature(key, userId, messageId, expiresAt));
  const actual = Buffer.from(token.slice(dot + 1));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 通知 1 件に付ける、ボタンと操作の送り先。 */
export type PushActions = {
  /** 出すボタン (設定した順)。 */
  buttons: { id: NotificationActionId; title: string }[];
  /** 押したときに POST する URL。 */
  url: string;
  /** このメールを操作してよいことを示す合言葉。 */
  token: string;
  /** 返信欄を出すか。送り先は url の後ろに "/reply" を付けたもの。 */
  reply: boolean;
};

/** 通知にボタンを付けるための材料。 */
export type PushActionSigner = {
  actions: readonly NotificationActionId[];
  /** 返信欄を出すか (ボタンを 1 つも選んでいなくても出す)。 */
  reply?: boolean;
  url: string;
  sign: (messageId: string) => string;
};

export function toPushActions(
  signer: PushActionSigner | null | undefined,
  messageId: string,
): PushActions | undefined {
  if (!signer) return undefined;
  const reply = signer.reply === true;
  if (signer.actions.length === 0 && !reply) return undefined;
  return {
    buttons: signer.actions.map((id) => ({
      id,
      title: NOTIFICATION_ACTION_TITLES[id],
    })),
    url: signer.url,
    token: signer.sign(messageId),
    reply,
  };
}
