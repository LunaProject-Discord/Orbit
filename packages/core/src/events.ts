import type { CalendarPushMessage } from "./calendar-notifications.js";

/**
 * プロセス間の通知に使う PostgreSQL の LISTEN / NOTIFY のチャンネル名。
 * - API → ワーカー: メールアカウントが追加・削除された
 * - ワーカー → API: 利用者のデータに変更があった (SSE で端末へ伝える)
 * - API → ワーカー: 送信待ちキューに操作が積まれた (payload はアカウントの ID)
 */
export const CHANNEL_ACCOUNTS = "accounts_changed";
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
export type FocusNotification = {
  accountId: string;
  mailboxId: string | null;
  /** 利用者がフォルダの更新を指示した。開いているフォルダを、すぐに確認し直させる。 */
  refresh?: boolean;
};

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
  /** 本文の冒頭。まだ本文を取得していないときと、まとめて知らせるときは付けない。 */
  preview?: string;
};

/**
 * CHANNEL_NEW_MAIL の payload。NOTIFY は 8000 バイトまでなので、messages には
 * 先頭の数件だけを入れ、全体の件数は count で伝える。
 */
export type NewMailNotification = {
  userId: string;
  accountId: string;
  /** アカウントの名前 (表示名、無ければメールアドレス)。通知をアカウントごとに分けるのに使う。 */
  accountName?: string;
  messages: NewMailItem[];
  count: number;
};

/**
 * API → ワーカー: 利用者が見ているメールの本文を、取り込みの順番を待たずに取得してほしい。
 * 本文は一覧より後に新しい順で取り込むので、取り込みの途中で見ているメールはこれで先に取得する。
 * 取得が終わったことは、通常の変更通知 (CHANNEL_CHANGES) で端末へ伝わる。
 */
export const CHANNEL_BODY_FETCH = "mail_body_fetch";

/**
 * 本文を先に取得する理由。上にあるものほど先に取得する。
 * - open: 利用者が開いたメール。
 * - hover: 一覧でカーソルを載せたメール (次に開きそう)。
 * - visible: 一覧の、いま画面に見えている行。
 */
export const BODY_FETCH_PRIORITIES = ["open", "hover", "visible"] as const;
export type BodyFetchPriority = (typeof BODY_FETCH_PRIORITIES)[number];

/** 1 回の依頼で頼める本文の数。 */
export const MAX_BODY_FETCH_IDS = 50;

/** CHANNEL_BODY_FETCH の payload。 */
export type BodyFetchNotification = {
  accountId: string;
  /** messages.id。先頭ほど先に取得する。 */
  messageIds: string[];
  priority: BodyFetchPriority;
};

/**
 * API → ワーカー: 受信メールの添付ファイルの実体を取得してほしい。
 * 実体はメールサーバーに置いたままにしてあり、開いたときにだけ取得して置き場に保存する。
 */
export const CHANNEL_ATTACHMENT_FETCH = "mail_attachment_fetch";

/** CHANNEL_ATTACHMENT_FETCH の payload。 */
export type AttachmentFetchNotification = {
  accountId: string;
  /** attachments.id */
  attachmentId: string;
};

/** ワーカー → API: 添付ファイルの取得が終わった (失敗も含む)。 */
export const CHANNEL_ATTACHMENT_READY = "mail_attachment_ready";

/** 取得できなかった理由。画面に出す文言は端末側で決める。 */
export type AttachmentFetchError =
  /** アカウントが同期されていない (再ログインが必要、など)。 */
  | "account_unavailable"
  /** メールや添付ファイルがサーバーから無くなっていた。 */
  | "not_found"
  | "too_large"
  | "fetch_failed";

/** CHANNEL_ATTACHMENT_READY の payload。error が null なら置き場に保存済み。 */
export type AttachmentReadyNotification = {
  attachmentId: string;
  error: AttachmentFetchError | null;
};

/**
 * API → ワーカー: カレンダーを同期してほしい (書き戻しが積まれた、変更通知が届いた、など)。
 * メールの同期を無駄に起こさないよう、CHANNEL_OUTBOX とは別のチャンネルにする。
 */
export const CHANNEL_CALENDAR_SYNC = "calendar_sync";

/**
 * 同期を求める理由。
 * - outbox: 予定の書き戻しが積まれた。
 * - push: プロバイダから変更通知 (Webhook) が届いた。
 * - refresh: 利用者が更新を指示した。
 * - focus: 利用者がカレンダーの画面を開いている。
 */
export type CalendarSyncReason = "outbox" | "push" | "refresh" | "focus";

/** CHANNEL_CALENDAR_SYNC の payload。calendarId を省けば、アカウントのカレンダー全部。 */
export type CalendarSyncNotification = {
  accountId: string;
  calendarId?: string;
  reason: CalendarSyncReason;
};

/**
 * ワーカー → API: 予定の招待・変更・取り消しを知らせる (段取り 9)。API の EventsHub が受け、
 * SSE の "calendar" イベント (CalendarHubEvent) で開いている画面へ配る。リマインダーは載せない
 * (端末が自分で鳴らすか、push で届く)。
 */
export const CHANNEL_CALENDAR_NOTICE = "calendar_notice";

/**
 * CHANNEL_CALENDAR_NOTICE の payload。NOTIFY は 8000 バイトまでなので、notifications には
 * rsvp を付けない (Desktop の SSE には出欠の合言葉を載せない。設計 4.3)。
 */
export type CalendarNoticeNotification = {
  userId: string;
  notifications: CalendarPushMessage[];
};

/**
 * API → ワーカー: 利用者のタイムゾーンか、予定の通知の設定 (終日の通知など) が変わった。
 * ReminderIndexer がその利用者の終日の job を作り直す。
 */
export const CHANNEL_CALENDAR_NOTIFICATION_SETTINGS =
  "calendar_notification_settings";

/** CHANNEL_CALENDAR_NOTIFICATION_SETTINGS の payload。 */
export type CalendarNotificationSettingsNotification = { userId: string };
