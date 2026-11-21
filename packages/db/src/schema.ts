import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** 主キーは時系列順に並ぶ UUID v7。PostgreSQL 18 以降の uuidv7() で採番する。 */
const id = () => uuid().primaryKey().default(sql`uuidv7()`);
const createdAt = () =>
  timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** メールアドレス 1 件分 (From / To / Cc / Bcc の要素) */
export type Address = { name?: string; address: string };

// ---------------------------------------------------------------------------
// ユーザーと端末
// ---------------------------------------------------------------------------

/** アプリの利用者。全データはこの ID で分離する。認証用テーブルは認証導入時に追加する。 */
export const users = pgTable("users", {
  id: id(),
  email: text().notNull().unique(),
  displayName: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const devicePlatform = pgEnum("device_platform", [
  "web",
  "desktop",
  "android",
  "ios",
]);

/** ログイン中の端末。プッシュ通知 (FCM / APNs) の宛先を持つ。 */
export const devices = pgTable(
  "devices",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    platform: devicePlatform().notNull(),
    pushToken: text(),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("devices_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// メールアカウントとフォルダ
// ---------------------------------------------------------------------------

export const mailProvider = pgEnum("mail_provider", [
  "gmail",
  "microsoft",
  "icloud",
  "generic",
]);

export const mailAuthType = pgEnum("mail_auth_type", ["oauth2", "password"]);

export const mailAccountStatus = pgEnum("mail_account_status", [
  "active",
  "auth_required",
  "error",
  "disabled",
]);

/** 利用者が登録した外部メールアカウント (Gmail など)。 */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text().notNull(),
    displayName: text(),
    provider: mailProvider().notNull(),
    authType: mailAuthType().notNull(),
    imapHost: text().notNull(),
    imapPort: integer().notNull(),
    imapSecure: boolean().notNull().default(true),
    smtpHost: text().notNull(),
    smtpPort: integer().notNull(),
    smtpSecure: boolean().notNull().default(false),
    username: text().notNull(),
    /** リフレッシュトークンまたはパスワードを AES-GCM で暗号化したもの。平文は保存しない。 */
    credentialsEncrypted: text().notNull(),
    status: mailAccountStatus().notNull().default("active"),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mail_accounts_user_email_idx").on(t.userId, t.email)],
);

export const mailboxSpecialUse = pgEnum("mailbox_special_use", [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "junk",
  "archive",
  "all",
  "flagged",
]);

/** IMAP のフォルダ (Gmail ではラベル)。差分同期用の IMAP 状態を持つ。 */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    path: text().notNull(),
    name: text().notNull(),
    delimiter: text(),
    specialUse: mailboxSpecialUse(),
    uidValidity: bigint({ mode: "bigint" }),
    uidNext: bigint({ mode: "bigint" }),
    highestModseq: bigint({ mode: "bigint" }),
    lastSyncedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mailboxes_account_path_idx").on(t.accountId, t.path)],
);

// ---------------------------------------------------------------------------
// メッセージ
// ---------------------------------------------------------------------------

/** メール 1 通。複数フォルダにあっても 1 行で、所在は message_mailboxes が持つ。 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** プロバイダ固有の不変 ID (Gmail の X-GM-MSGID など)。無ければ null。 */
    providerMessageId: text(),
    /** スレッドをまとめるキー (Gmail の X-GM-THRID、または References から算出)。 */
    threadKey: text().notNull(),
    messageIdHeader: text(),
    inReplyTo: text(),
    references: text().array().notNull().default(sql`'{}'::text[]`),
    subject: text().notNull().default(""),
    from: jsonb().$type<Address[]>().notNull().default([]),
    to: jsonb().$type<Address[]>().notNull().default([]),
    cc: jsonb().$type<Address[]>().notNull().default([]),
    bcc: jsonb().$type<Address[]>().notNull().default([]),
    replyTo: jsonb().$type<Address[]>().notNull().default([]),
    sentAt: timestamp({ withTimezone: true }),
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    snippet: text().notNull().default(""),
    size: integer().notNull().default(0),
    hasAttachments: boolean().notNull().default(false),
    /** 本文は後追いで取得するため、取得前は null。 */
    bodyText: text(),
    bodyHtml: text(),
    bodyFetchedAt: timestamp({ withTimezone: true }),
    seen: boolean().notNull().default(false),
    flagged: boolean().notNull().default(false),
    answered: boolean().notNull().default(false),
    draft: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_account_provider_id_idx").on(
      t.accountId,
      t.providerMessageId,
    ),
    index("messages_account_thread_idx").on(t.accountId, t.threadKey),
    index("messages_account_received_idx").on(t.accountId, t.receivedAt),
    index("messages_message_id_header_idx").on(t.messageIdHeader),
  ],
);

/** メッセージがどのフォルダに、どの IMAP UID で存在するか。 */
export const messageMailboxes = pgTable(
  "message_mailboxes",
  {
    mailboxId: uuid()
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    uid: bigint({ mode: "bigint" }).notNull(),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    modseq: bigint({ mode: "bigint" }),
  },
  (t) => [
    primaryKey({ columns: [t.mailboxId, t.uid] }),
    index("message_mailboxes_message_idx").on(t.messageId),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text(),
    contentType: text().notNull(),
    size: integer().notNull().default(0),
    /** HTML 本文から cid: で参照されるインライン画像の ID。 */
    contentId: text(),
    inline: boolean().notNull().default(false),
    /** IMAP の BODYSTRUCTURE 上の位置 (例: "2.1")。必要時にここから取得する。 */
    partId: text().notNull(),
    /** 取得済みの実体の保存先。未取得なら null。 */
    storageKey: text(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

// ---------------------------------------------------------------------------
// 同期
// ---------------------------------------------------------------------------

export const changeEntity = pgEnum("change_entity", [
  "account",
  "mailbox",
  "message",
]);

export const changeOp = pgEnum("change_op", ["upsert", "delete"]);

/**
 * 変更履歴。seq は単調増加の変更番号で、端末は「前回の seq 以降」を
 * GET /v1/sync で取得する。
 */
export const changes = pgTable(
  "changes",
  {
    seq: bigserial({ mode: "bigint" }).primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entity: changeEntity().notNull(),
    entityId: uuid().notNull(),
    op: changeOp().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("changes_user_seq_idx").on(t.userId, t.seq)],
);

export const outboxKind = pgEnum("outbox_kind", [
  "send",
  "set_flags",
  "move",
  "delete",
  "append",
]);

export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "processing",
  "done",
  "failed",
]);

/**
 * プロバイダへ反映待ちの操作 (送信、既読、移動など)。
 * API サーバーが積み、同期ワーカーが IMAP / SMTP に反映する。
 */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    kind: outboxKind().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** 端末が操作ごとに付ける一意な ID。再送されても二重に実行しない。 */
    idempotencyKey: text().notNull(),
    status: outboxStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("outbox_account_idempotency_idx").on(
      t.accountId,
      t.idempotencyKey,
    ),
    index("outbox_status_run_after_idx").on(t.status, t.runAfter),
  ],
);
