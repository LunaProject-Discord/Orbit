import { type GraphClient, GraphError } from "./graph-client.js";

/**
 * 購読の期限。Outlook のメッセージの購読は最長 10,080 分 (7 日弱) なので、余裕を持って 6 日にする。
 * https://learn.microsoft.com/graph/api/resources/subscription#subscription-lifetime
 */
export const SUBSCRIPTION_LIFETIME_MS = 6 * 24 * 60 * 60_000;
/** 期限がこれより近づいたら延長する。 */
export const RENEW_BEFORE_MS = 2 * 24 * 60 * 60_000;

export type PushState = {
  subscriptionId: string | null;
  expiresAt: Date | null;
};

type Subscription = { id: string; expirationDateTime: string };

/**
 * 変更通知 (Webhook) の購読を用意する。有効な購読があれば期限を延ばし (再認可も兼ねる)、
 * 無ければ作る。メールボックス内の全メッセージ (全フォルダ) の追加・変更・削除を対象にする。
 * 作成時には Graph が notificationUrl に確認の要求を送り、API がそれに応えられないと失敗する。
 * https://learn.microsoft.com/graph/outlook-change-notifications-overview
 */
export async function ensureSubscription(
  client: GraphClient,
  options: {
    state: PushState;
    notificationUrl: string;
    clientState: string;
    now?: number;
    signal?: AbortSignal;
  },
): Promise<PushState> {
  const now = options.now ?? Date.now();
  const expirationDateTime = new Date(
    now + SUBSCRIPTION_LIFETIME_MS,
  ).toISOString();
  const { subscriptionId, expiresAt } = options.state;

  if (subscriptionId && expiresAt && expiresAt.getTime() > now) {
    try {
      const renewed = await client.request<Subscription>(
        "PATCH",
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { expirationDateTime },
        options.signal,
      );
      return {
        subscriptionId,
        expiresAt: new Date(renewed?.expirationDateTime ?? expirationDateTime),
      };
    } catch (error) {
      // 購読が Graph 側で消されていた。作り直す。
      if (!(error instanceof GraphError && error.notFound)) throw error;
    }
  }

  const created = await client.request<Subscription>(
    "POST",
    "/subscriptions",
    {
      changeType: "created,updated,deleted",
      notificationUrl: options.notificationUrl,
      // 購読が消された、通知を取りこぼした、再認可が必要、といった知らせも同じ受け口で受ける。
      lifecycleNotificationUrl: options.notificationUrl,
      resource: "me/messages",
      expirationDateTime,
      clientState: options.clientState,
    },
    options.signal,
  );
  return {
    subscriptionId: created.id,
    expiresAt: new Date(created.expirationDateTime ?? expirationDateTime),
  };
}

/** 確認の間隔を決めるための状況。 */
export type PollSituation = {
  /** 利用者が画面を開いている。 */
  present: boolean;
  /** 変更通知が実際に届いていて、当てにできる。 */
  pushTrusted: boolean;
  /** 制限 (429) を受けたあとの倍率。通常は 1。 */
  slowdown: number;
};

/** 画面を開いている間の確認の間隔。10 分で 10,000 回という制限に対して十分少ない (120 回)。 */
export const ACTIVE_POLL_MS = 5_000;
export const IDLE_POLL_MS = 15_000;
/** 変更通知が届いている間の、取りこぼしに備えた確認の間隔。 */
export const PUSH_ACTIVE_POLL_MS = 60_000;
export const PUSH_IDLE_POLL_MS = 5 * 60_000;
export const MAX_SLOWDOWN = 8;

/** 受信トレイと開いているフォルダの差分を確認する間隔を、状況に応じて決める。 */
export function pollInterval(situation: PollSituation): number {
  const base = situation.pushTrusted
    ? situation.present
      ? PUSH_ACTIVE_POLL_MS
      : PUSH_IDLE_POLL_MS
    : situation.present
      ? ACTIVE_POLL_MS
      : IDLE_POLL_MS;
  return base * Math.min(Math.max(situation.slowdown, 1), MAX_SLOWDOWN);
}
