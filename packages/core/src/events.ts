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
