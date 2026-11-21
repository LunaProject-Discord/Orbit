/**
 * 送信待ちキュー (outbox テーブル) の payload。
 * API サーバーが操作を受け付けた時点の情報を入れ、同期ワーカーがプロバイダへ反映する。
 * 移動や削除では DB 上の所在を先に消すので、反映に必要な情報 (UID など) は
 * すべてここに持たせる。
 */

/** 操作の対象。メッセージがあるフォルダ 1 つ分。 */
export type OutboxTarget = {
  messageId: string;
  /** Microsoft Graph のメッセージ ID (不変 ID)。IMAP では使わない。 */
  providerMessageId: string | null;
  mailboxId: string;
  /** IMAP ではフォルダのパス、Microsoft Graph ではフォルダの ID。 */
  mailboxPath: string;
  /** IMAP のフォルダ内の UID (bigint を文字列にしたもの)。 */
  uid: string | null;
  /**
   * 受け付けた時点の UIDVALIDITY。反映時に変わっていたら UID が別のメールを
   * 指しているおそれがあるので、反映せずに失敗させる。
   */
  uidValidity: string | null;
};

export type SetFlagsPayload = {
  targets: OutboxTarget[];
  seen?: boolean;
  flagged?: boolean;
};

export type MovePayload = {
  targets: OutboxTarget[];
  destination: { mailboxId: string; path: string };
};

export type DeletePayload = { targets: OutboxTarget[] };

export type OutboxOperation =
  | { kind: "set_flags"; payload: SetFlagsPayload }
  | { kind: "move"; payload: MovePayload }
  | { kind: "delete"; payload: DeletePayload };

/**
 * アカウント単位の排他に使う PostgreSQL の勧告ロックのキー。
 * 操作の受け付け (API) と同期結果の書き込み (ワーカー) が同時に走ると、
 * 受け付けたばかりの操作を同期が古い状態で上書きしかねないので、
 * どちらもトランザクションの中で pg_advisory_xact_lock(hashtextextended(key, 0)) を取る。
 */
export function accountLockKey(accountId: string): string {
  return `mail-account:${accountId}`;
}
