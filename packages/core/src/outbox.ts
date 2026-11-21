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
  /** 返信済みの印。返信を送信したあとに同期ワーカーが付ける。 */
  answered?: boolean;
};

export type MovePayload = {
  targets: OutboxTarget[];
  destination: { mailboxId: string; path: string };
};

export type DeletePayload = { targets: OutboxTarget[] };

/** メールアドレス 1 件分 (packages/db の Address と同じ形)。 */
export type MailAddress = { name?: string; address: string };

/** 送信するメールの添付ファイル。実体は添付ファイルの置き場 (attachment-store) にある。 */
export type OutgoingAttachment = {
  id: string;
  /** 置き場の中の位置 (attachmentKey の戻り値)。 */
  storageKey: string;
  filename: string;
  contentType: string;
  size: number;
};

/**
 * 送信するメール 1 通。Message-ID と日時は受け付けた時点で決めておき、
 * やり直しても、送信済みフォルダへ保存するときも、同じ内容のメールになるようにする。
 */
export type OutgoingMessage = {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  /** 書式付きの本文。あれば、テキストと HTML の両方を入れたメールにする。 */
  html?: string | null;
  attachments?: OutgoingAttachment[];
  /** <...> の形の Message-ID。 */
  messageId: string;
  /** ISO 8601 の日時。 */
  date: string;
  inReplyTo: string | null;
  references: string[];
};

export type SendPayload = {
  message: OutgoingMessage;
  /** 返信・転送の元になったメッセージ (messages.id)。 */
  sourceMessageId: string | null;
  mode: "new" | "reply" | "forward";
};

/** 送信したメールを、送信済みフォルダへ保存する (IMAP のみ)。 */
export type AppendPayload = {
  message: OutgoingMessage;
  /** 保存先のフォルダのパス。 */
  mailboxPath: string;
  /** 移動などの操作と形を揃えるための空の配列。 */
  targets: OutboxTarget[];
};

/** 受け付けた順に、同期の接続を使ってプロバイダへ反映する操作。 */
export type OutboxOperation =
  | { kind: "set_flags"; payload: SetFlagsPayload }
  | { kind: "move"; payload: MovePayload }
  | { kind: "delete"; payload: DeletePayload }
  | { kind: "append"; payload: AppendPayload };

/**
 * アカウント単位の排他に使う PostgreSQL の勧告ロックのキー。
 * 操作の受け付け (API) と同期結果の書き込み (ワーカー) が同時に走ると、
 * 受け付けたばかりの操作を同期が古い状態で上書きしかねないので、
 * どちらもトランザクションの中で pg_advisory_xact_lock(hashtextextended(key, 0)) を取る。
 */
export function accountLockKey(accountId: string): string {
  return `mail-account:${accountId}`;
}
