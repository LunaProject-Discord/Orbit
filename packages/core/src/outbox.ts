import type { EventFieldName } from "./event-merge.js";

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

/**
 * フォルダを作る。IMAP では path (親のパス + 区切り文字 + 名前) で、
 * Microsoft Graph では親フォルダの ID (parentPath) と名前で作る。
 */
export type MailboxCreatePayload = {
  name: string;
  /** 親フォルダの path。最上位に作るなら null。 */
  parentPath: string | null;
  /** IMAP で作るフォルダのパス。 */
  path: string;
  /** 移動などの操作と形を揃えるための空の配列。 */
  targets: OutboxTarget[];
};

/** フォルダの名前を変える。親は変えない。 */
export type MailboxRenamePayload = {
  mailboxId: string;
  /** いまの path (IMAP ではパス、Microsoft Graph ではフォルダの ID)。 */
  path: string;
  /** IMAP での変更後のパス。 */
  newPath: string;
  /** 変更後の名前。 */
  name: string;
  /** IMAP の階層の区切り文字。中のフォルダのパスを直すのに使う。 */
  delimiter: string | null;
  targets: OutboxTarget[];
};

/** フォルダを、中のメールごと削除する。 */
export type MailboxDeletePayload = {
  mailboxId: string;
  path: string;
  /** 失敗を知らせるときに出す名前。 */
  name: string;
  targets: OutboxTarget[];
};

/** フォルダそのものへの操作。 */
export type MailboxOperation =
  | { kind: "mailbox_create"; payload: MailboxCreatePayload }
  | { kind: "mailbox_rename"; payload: MailboxRenamePayload }
  | { kind: "mailbox_delete"; payload: MailboxDeletePayload };

/** 受け付けた順に、同期の接続を使ってプロバイダへ反映する操作。 */
export type OutboxOperation =
  | { kind: "set_flags"; payload: SetFlagsPayload }
  | { kind: "move"; payload: MovePayload }
  | { kind: "delete"; payload: DeletePayload }
  | { kind: "append"; payload: AppendPayload }
  | MailboxOperation;

export type MailboxNameError = "empty" | "too_long" | "invalid_character";

/** フォルダ名の長さの上限。 */
export const MAILBOX_NAME_MAX = 100;

/**
 * 新しく付けるフォルダ名を確かめる。問題が無ければ null。
 * 階層の区切り文字と、IMAP の一覧取得で特別な意味を持つ文字 (% と *)、制御文字は使えない。
 */
export function mailboxNameError(
  name: string,
  delimiter: string | null,
): MailboxNameError | null {
  if (name.trim() === "") return "empty";
  if (name !== name.trim()) return "invalid_character";
  if ([...name].length > MAILBOX_NAME_MAX) return "too_long";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くため。
  if (/[\u0000-\u001f\u007f%*]/.test(name)) return "invalid_character";
  if (delimiter && name.includes(delimiter)) return "invalid_character";
  return null;
}

/**
 * アカウント単位の排他に使う PostgreSQL の勧告ロックのキー。
 * 操作の受け付け (API) と同期結果の書き込み (ワーカー) が同時に走ると、
 * 受け付けたばかりの操作を同期が古い状態で上書きしかねないので、
 * どちらもトランザクションの中で pg_advisory_xact_lock(hashtextextended(key, 0)) を取る。
 */
export function accountLockKey(accountId: string): string {
  return `mail-account:${accountId}`;
}

/**
 * カレンダーの同期と書き戻しの排他に使う勧告ロックのキー。
 * メールのロック (accountLockKey) とは別のキーにして、メールの同期とカレンダーの同期が
 * 互いを待たないようにする。取り方は accountLockKey と同じ。
 */
export function calendarLockKey(accountId: string): string {
  return `calendar-account:${accountId}`;
}

/**
 * 予定の書き戻しの操作の種類 (outbox.kind)。
 * メールの同期はこれらの行を拾わず、カレンダーの同期だけが処理する。
 */
export const EVENT_OUTBOX_KINDS = [
  "event_create",
  "event_update",
  "event_delete",
  "event_respond",
] as const;
export type EventOutboxKind = (typeof EVENT_OUTBOX_KINDS)[number];

/**
 * 書き戻す予定の、相手側での所在。削除では行が先に消えるので、
 * 反映に必要な情報をすべて持たせる。
 */
export type EventOutboxRef = {
  eventId: string;
  calendarId: string;
  /** プロバイダでの ID。作成の書き戻し前なら null。 */
  remoteId: string | null;
  etag: string | null;
  uid: string;
  /** 例外のとき、元の回 (normalizeRecurrenceId の書き方)。 */
  recurrenceId: string | null;
  /** 例外のとき、原本の remoteId。 */
  parentRemoteId: string | null;
};

/** 予定を作る。中身は実行時に DB の行から読む。 */
export type EventCreatePayload = { eventId: string; calendarId: string };

/** 予定を変える。中身は実行時に DB の行から読み、fields の項目を書き戻す。 */
export type EventUpdatePayload = {
  eventId: string;
  calendarId: string;
  fields: EventFieldName[];
};

/** 予定を消す。 */
export type EventDeletePayload = {
  calendarId: string;
  target: EventOutboxRef;
  /** 消した時刻 (ISO 8601)。 */
  deletedAt: string;
};

/** 招待に返事をする。 */
export type EventRespondPayload = {
  eventId: string;
  calendarId: string;
  status: "accepted" | "tentative" | "declined";
  comment: string | null;
};

/** 予定の書き戻しの操作。カレンダーの同期が、受け付けた順にプロバイダへ反映する。 */
export type EventOutboxOperation =
  | { kind: "event_create"; payload: EventCreatePayload }
  | { kind: "event_update"; payload: EventUpdatePayload }
  | { kind: "event_delete"; payload: EventDeletePayload }
  | { kind: "event_respond"; payload: EventRespondPayload };

/**
 * Orbit から予定を書き戻せるカレンダーの source。
 * 各プロバイダの担当は、書き戻しができた時点で、自分の source を 1 行足す。
 * 衝突しても直しやすいよう、1 要素を 1 行で書く。
 */
export const CALENDAR_WRITEBACK_SOURCES: readonly string[] = [
  // 例: "google",
  "google",
];
