/**
 * プロセス間の通知に使う PostgreSQL の LISTEN / NOTIFY のチャンネル名。
 * - API → ワーカー: メールアカウントが追加・削除された
 * - ワーカー → API: 利用者のデータに変更があった (SSE で端末へ伝える)
 */
export const CHANNEL_ACCOUNTS = "mail_accounts_changed";
export const CHANNEL_CHANGES = "mail_changes";

/** CHANNEL_CHANGES の payload。seq は changes.seq (bigint を文字列にしたもの)。 */
export type ChangeNotification = { userId: string; seq: string };
