/**
 * プロセス間の通知に使う PostgreSQL の LISTEN / NOTIFY のチャンネル名。
 * - API → ワーカー: メールアカウントが追加・削除された
 * - ワーカー → API: 利用者のデータに変更があった (SSE で端末へ伝える)
 * - API → ワーカー: 送信待ちキューに操作が積まれた (payload はアカウントの ID)
 */
export const CHANNEL_ACCOUNTS = "mail_accounts_changed";
export const CHANNEL_CHANGES = "mail_changes";
export const CHANNEL_OUTBOX = "mail_outbox";

/** CHANNEL_CHANGES の payload。seq は changes.seq (bigint を文字列にしたもの)。 */
export type ChangeNotification = { userId: string; seq: string };

/**
 * API → ワーカー: 利用者が画面を開いている (どのフォルダを見ているか)。
 * 見ているフォルダと、画面を開いている間のアカウントは、短い間隔で同期する。
 */
export const CHANNEL_FOCUS = "mail_focus";

/** CHANNEL_FOCUS の payload。mailboxId が null なら、画面を開いていることだけを伝える。 */
export type FocusNotification = { accountId: string; mailboxId: string | null };

/** API → ワーカー: Microsoft Graph から変更通知 (Webhook) が届いた。 */
export const CHANNEL_GRAPH_PUSH = "mail_graph_push";

/** Microsoft Graph の購読の状態が変わったことを知らせる通知の種類。 */
export type GraphLifecycleEvent =
  | "reauthorizationRequired"
  | "subscriptionRemoved"
  | "missed";

/** CHANNEL_GRAPH_PUSH の payload。lifecycle が null ならメールの変更の通知。 */
export type GraphPushNotification = {
  accountId: string;
  lifecycle: GraphLifecycleEvent | null;
};

/**
 * ワーカー → API とワーカー自身: 受信トレイに新しいメールが届いた。
 * API は SSE で開いている画面へ伝え、ワーカーは Web Push で端末へ通知する。
 */
export const CHANNEL_NEW_MAIL = "mail_new_mail";

/** 新着メール 1 通分。通知に出す内容だけを持つ。 */
export type NewMailItem = {
  /** messages.id */
  id: string;
  /** 差出人の表示名 (無ければメールアドレス)。 */
  from: string;
  subject: string;
};

/**
 * CHANNEL_NEW_MAIL の payload。NOTIFY は 8000 バイトまでなので、messages には
 * 先頭の数件だけを入れ、全体の件数は count で伝える。
 */
export type NewMailNotification = {
  userId: string;
  accountId: string;
  messages: NewMailItem[];
  count: number;
};
