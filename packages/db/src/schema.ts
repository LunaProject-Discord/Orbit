import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  customType,
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

/** バイト列 (bytea)。node-postgres は Buffer で読み書きする。 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** メールアドレス 1 件分 (From / To / Cc / Bcc の要素) */
export type Address = { name?: string; address: string };

/** 認証の 1 つの方式の結果 (@orbit/core の AuthMethodResult と同じ形)。 */
export type StoredAuthMethodResult = { result: string; domain: string | null };

/** 送信元の認証結果 (@orbit/core の AuthResults と同じ形)。 */
export type StoredAuthResults = {
  authservId: string;
  spf: StoredAuthMethodResult | null;
  dkim: StoredAuthMethodResult[];
  dmarc: StoredAuthMethodResult | null;
  compauth: StoredAuthMethodResult | null;
};

/** 差出人の確認結果 (@orbit/core の SenderCheck と同じ形)。 */
export type StoredSenderCheck = {
  verified: boolean;
  warnings: ("dmarc_fail" | "auth_fail" | "name_mismatch")[];
  claimed: string | null;
};

// ---------------------------------------------------------------------------
// ユーザーと端末
// ---------------------------------------------------------------------------

/**
 * アプリの利用者。全データはこの ID で分離する。
 * users / sessions / auth_accounts / verifications は Better Auth が読み書きするため、
 * 列名 (プロパティ名) は Better Auth の既定に合わせている。
 */
export const users = pgTable("users", {
  id: id(),
  email: text().notNull().unique(),
  name: text().notNull(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  /** 2 段階認証を有効にしているか (Better Auth の twoFactor プラグインが読み書きする)。 */
  twoFactorEnabled: boolean().notNull().default(false),
  /**
   * 管理者か。管理者だけが、招待リンクを発行してほかの利用者を増やせる。
   * Better Auth は読み書きしない (自前の API とコマンドだけが扱う)。
   */
  isAdmin: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * 利用者を増やすための招待。新規登録は受け付けていないので、管理者が発行した
 * 招待リンクを開いた人だけが、自分で利用者を作れる。1 つの招待で作れるのは 1 人。
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    /** リンクに付ける合言葉の SHA-256 (16 進)。合言葉そのものは保存しない。 */
    tokenHash: text().notNull().unique(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 誰に渡したかの覚え書き。 */
    label: text(),
    /** 指定すると、このメールアドレスでしか登録できない。 */
    email: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** 使われた時刻。null なら未使用。 */
    usedAt: timestamp({ withTimezone: true }),
    /** この招待で作られた利用者。 */
    usedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_created_by_idx").on(t.createdBy)],
);

/** ログインセッション。token を Bearer トークンとして各クライアントが保持する。 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * ログイン手段 (メール + パスワードなら providerId = "credential")。
 * 外部メールアカウントの mail_accounts とは別物。
 */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    /** パスワードのハッシュ (Better Auth が scrypt で生成)。 */
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * 2 段階認証 (認証アプリ) の設定。利用者ごとに 1 行。
 * secret と backupCodes は、Better Auth が BETTER_AUTH_SECRET で暗号化して保存する。
 * verified は、認証アプリのコードを 1 度入力して登録を終えたか。
 */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().notNull().default(true),
    /** 続けて失敗した回数。上限に達すると lockedUntil までコードを受け付けない。 */
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("two_factors_user_idx").on(t.userId),
    index("two_factors_secret_idx").on(t.secret),
  ],
);

/** ログインに使うパスキー (WebAuthn の公開鍵)。Better Auth の passkey プラグインが読み書きする。 */
export const passkeys = pgTable(
  "passkeys",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 利用者が付けた名前 (「ノート PC」など)。 */
    name: text(),
    publicKey: text().notNull(),
    credentialID: text("credential_id").notNull(),
    counter: integer().notNull(),
    /** singleDevice (その端末だけ) か multiDevice (同期されるパスキー)。 */
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    /** 認証器の種類を表す ID (「Windows Hello」などの名前を出すのに使う)。 */
    aaguid: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("passkeys_user_idx").on(t.userId),
    uniqueIndex("passkeys_credential_idx").on(t.credentialID),
  ],
);

export const devicePlatform = pgEnum("device_platform", [
  "web",
  "desktop",
  "android",
  "ios",
]);

/**
 * スマホアプリを入れた端末。新着メールの通知 (Android は FCM) の送り先を持つ。
 * アプリで通知を有効にしたときに登録し、無効にしたときとログアウトのときに消す。
 * pushToken は FCM が端末ごとに発行する値で、端末を一意に表す。
 */
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
  (t) => [
    index("devices_user_idx").on(t.userId),
    uniqueIndex("devices_push_token_idx").on(t.pushToken),
  ],
);

/**
 * Web Push の送り先 (ブラウザーごと)。新着メールの通知を、画面を閉じていても届ける。
 * endpoint はブラウザーのプッシュサービスが発行する URL で、端末を一意に表す。
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    /** 通知の内容を暗号化するための、端末の公開鍵と共有の秘密の値 (base64url)。 */
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
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

/**
 * サーバーとの通信方式。imap は IMAP / SMTP、graph は Microsoft Graph
 * (Exchange Online、Outlook.com)、pop3 は POP3 / SMTP。
 * POP3 のアカウントでは、受信の接続先も imapHost / imapPort / imapSecure に入れる。
 */
export const mailProtocol = pgEnum("mail_protocol", ["imap", "graph", "pop3"]);

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
    protocol: mailProtocol().notNull().default("imap"),
    /**
     * 受信 (IMAP または POP3) と送信 (SMTP) の接続先。protocol が imap か pop3 のときだけ入る。
     * POP3 のアカウントでは、imap* の列に POP3 サーバーの接続先が入る。
     */
    imapHost: text(),
    imapPort: integer(),
    imapSecure: boolean().notNull().default(true),
    smtpHost: text(),
    smtpPort: integer(),
    smtpSecure: boolean().notNull().default(false),
    /**
     * 安全な再ネゴシエーション (RFC 5746) に対応していない古いサーバーへの接続を許す。
     * 安全性が下がるので、利用者が明示的に許可したアカウントだけ true にする。
     */
    allowLegacyTls: boolean().notNull().default(false),
    /** このアカウントに届いた新着メールを通知する。 */
    notifyNewMail: boolean().notNull().default(true),
    /**
     * 受信トレイ以外のフォルダの変化をすぐ受け取るために足す IMAP 接続の本数の上限 (0〜8)。
     * 0 なら足さない。null は自動 (サービスに合わせた数)。IMAP のアカウントでだけ使う。
     */
    pushConnections: integer(),
    /**
     * POP3: 受け取ったメールをサーバーに残す。false なら、取り込んだあとサーバーから消す。
     * true でも、アプリで完全に削除したメールはサーバーからも消す。
     */
    popLeaveOnServer: boolean().notNull().default(true),
    /** POP3: サーバーに残したメールを、取り込んでからこの日数が過ぎたら消す。null なら消さない。 */
    popDeleteAfterDays: integer(),
    username: text().notNull(),
    /** リフレッシュトークンまたはパスワードを AES-GCM で暗号化したもの。平文は保存しない。 */
    credentialsEncrypted: text().notNull(),
    status: mailAccountStatus().notNull().default("active"),
    lastError: text(),
    /** Microsoft Graph の変更通知 (Webhook) の購読 ID と期限。購読していなければ null。 */
    pushSubscriptionId: text(),
    pushExpiresAt: timestamp({ withTimezone: true }),
    /** このアカウントから送るメールの署名 (書式付き)。無ければ null。 */
    signatureHtml: text(),
    /** サイドバーでの表示順 (小さいほど上)。並び替えていなければ null で、追加した順に並ぶ。 */
    sortOrder: integer(),
    /** 画面でアカウントを見分ける色の名前 (sky など)。選んでいなければ null で、並び順から決まる。 */
    color: text(),
    /** 画面でアカウントに付けるアイコンの名前。選んでいなければ null (色の点を出す)。 */
    icon: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 同じアドレスでも、受信サーバーかユーザー名が違えば別のアカウントとして追加できる
    // (例: ドコモメールを IMAP で、同じアドレスのメッセージR/S を POP3 で)。
    // Microsoft Graph のアカウントは受信サーバーが無い (null) ので、空文字として比べる。
    uniqueIndex("mail_accounts_user_email_server_idx").on(
      t.userId,
      t.email,
      sql`coalesce(lower(${t.imapHost}), '')`,
      t.username,
    ),
    index("mail_accounts_user_email_idx").on(t.userId, t.email),
  ],
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

/**
 * フォルダ (Gmail ではラベル)。差分同期用の状態を持つ。
 * path は IMAP ではフォルダのパス、Microsoft Graph ではフォルダの ID。
 * parentId は親フォルダ (最上位なら null) で、画面のフォルダツリーに使う。
 */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    path: text().notNull(),
    parentId: uuid().references((): AnyPgColumn => mailboxes.id, {
      onDelete: "set null",
    }),
    name: text().notNull(),
    delimiter: text(),
    /**
     * 実際に使う役割。メールサーバーが知らせてきた役割 (detectedSpecialUse) に、
     * 利用者の上書き (roleOverride) を当てはめた結果で、どちらかが変わるたびに計算し直す
     * (@orbit/core の resolveMailboxRoles)。移動先を探す処理などは、すべてこの列を見る。
     */
    specialUse: mailboxSpecialUse(),
    /** メールサーバーが知らせてきた役割 (IMAP の SPECIAL-USE、Graph の既定のフォルダ)。 */
    detectedSpecialUse: mailboxSpecialUse(),
    /**
     * 利用者がアプリ内で付けた役割 (sent / drafts / archive / junk / trash)。"none" は
     * 「役割なしとして扱う」。付けていなければ null。メールサーバー側には反映しない。
     */
    roleOverride: text().$type<
      "sent" | "drafts" | "archive" | "junk" | "trash" | "none"
    >(),
    /** アプリ内での表示名。付けていなければ null (役割の名前か、サーバー上の名前で出す)。 */
    displayName: text(),
    /** アプリ内でのアイコン (Lucide の名前か絵文字)。付けていなければ null。 */
    icon: text(),
    /** アプリ内でのアイコンの色 ("#rrggbb")。付けていなければ null。 */
    color: text(),
    /**
     * 同じ親を持つフォルダの中での表示順 (小さいほど上)。並び替えていなければ null で、
     * 既定の順 (受信トレイなどの役割、次に名前) に並ぶ。メールサーバー側には反映しない。
     */
    sortOrder: integer(),
    uidValidity: bigint({ mode: "bigint" }),
    uidNext: bigint({ mode: "bigint" }),
    highestModseq: bigint({ mode: "bigint" }),
    /** Microsoft Graph の差分取得の続き (deltaLink)。IMAP では使わない。 */
    syncState: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_account_path_idx").on(t.accountId, t.path),
    index("mailboxes_parent_idx").on(t.parentId),
  ],
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
    /** プロバイダ固有の不変 ID (Gmail の X-GM-MSGID、Microsoft Graph の不変 ID など)。無ければ null。 */
    providerMessageId: text(),
    /** スレッドをまとめるキー (Gmail の X-GM-THRID、Graph の conversationId、または References から算出)。 */
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
    /** Sender ヘッダー (代理で送った人)。差出人と同じ場合も、サーバーが返した値をそのまま入れる。 */
    sender: jsonb().$type<Address[]>().notNull().default([]),
    /** List-Id ヘッダーの ID (メーリングリストやメールマガジンの識別子)。無ければ null。 */
    listId: text(),
    /** List-Unsubscribe ヘッダーにあった配信停止の宛先 (https / mailto の URL)。 */
    listUnsubscribe: jsonb().$type<string[]>().notNull().default([]),
    /**
     * つなぎ先のメールサーバーが付けた送信元の認証結果 (Authentication-Results)。
     * ヘッダーが無いメールや、取り込む前のメールは null。
     */
    authResults: jsonb().$type<StoredAuthResults>(),
    /** 認証結果と表示名から決めた、差出人の確認結果 (確認済みか、なりすましの疑い)。 */
    senderCheck: jsonb().$type<StoredSenderCheck>(),
    /**
     * sender / listId / listUnsubscribe / authResults を取り込んだ時刻。
     * これらの項目を足す前に取り込んだメールは null で、同期ワーカーが後から補う。
     */
    headersFetchedAt: timestamp({ withTimezone: true }),
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
    // ヘッダーの補完がまだのメールを探すための索引。補完が終われば空になる。
    index("messages_headers_pending_idx")
      .on(t.accountId)
      .where(sql`${t.headersFetchedAt} is null`),
    // 認証結果を足す前に取り込んだメール (同期ワーカーが補う) を探すための索引。補完が終われば空になる。
    index("messages_sender_check_pending_idx")
      .on(t.accountId)
      .where(sql`${t.senderCheck} is null`),
  ],
);

/**
 * メールの検索用の文字列。1 通に 1 行で、messages への追加・変更のたびに DB のトリガーが作り直す
 * (書き込む側は意識しなくてよい)。中身は件名・差出人・宛先・本文をそれぞれ mail_search_normalize で
 * そろえて (NFKC、小文字、空白を除く) 制御文字 \x01 でつないだもの。関数とトリガーはマイグレーション 0037。
 *
 * 索引 message_search_grams_idx (1 文字と、隣り合う 2 文字の組の GIN) は、メールが多いと作るのに
 * 時間がかかるので、マイグレーションでは作らず、同期ワーカー (apps/worker/src/search-index.ts) が
 * 取り込み済みのメールの行を作ったあとに CREATE INDEX CONCURRENTLY で作る。
 */
export const messageSearch = pgTable(
  "message_search",
  {
    messageId: uuid()
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    doc: text().notNull(),
  },
  (t) => [
    index("message_search_grams_idx").using(
      "gin",
      sql`mail_search_grams(${t.doc})`,
    ),
  ],
);

/**
 * メッセージがどのフォルダに存在するか。IMAP ではフォルダ内の UID を持つ。
 * Microsoft Graph には UID が無いので null (メッセージは messages.providerMessageId で特定する)。
 */
export const messageMailboxes = pgTable(
  "message_mailboxes",
  {
    mailboxId: uuid()
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    uid: bigint({ mode: "bigint" }),
    modseq: bigint({ mode: "bigint" }),
    /**
     * 移動を受け付けた時刻。移動先のフォルダに先に置いた所在で、メールサーバーでの移動と
     * 移動先の同期が済むまで入る (その間、IMAP では UID が無い)。同期で同じメールが
     * 見つかればこの所在に結び付け直し、見つからないまま時間が経てば外す。
     */
    pendingSince: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.mailboxId, t.messageId] }),
    uniqueIndex("message_mailboxes_mailbox_uid_idx").on(t.mailboxId, t.uid),
    index("message_mailboxes_message_idx").on(t.messageId),
  ],
);

/**
 * POP3 で取り込んだメールの記録。UIDL (サーバーが付ける一意な ID) ごとに 1 行で、
 * 同じメールを二度取り込まないために使う。messageId は取り込んだメール
 * (アプリで完全に削除すると null になり、次の受信でサーバーからも消す)。
 */
export const popMessages = pgTable(
  "pop_messages",
  {
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    uidl: text().notNull(),
    messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    downloadedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.uidl] }),
    index("pop_messages_message_idx").on(t.messageId),
  ],
);

/**
 * メールの原文 (RFC 5322 の形式)。POP3 のメールはサーバーから消えることがあるので、
 * 取り込んだときの原文をここに残し、添付ファイルはここから取り出す。
 */
export const messageSources = pgTable("message_sources", {
  messageId: uuid()
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  raw: bytea().notNull(),
  createdAt: createdAt(),
});

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
  "mailbox_create",
  "mailbox_rename",
  "mailbox_delete",
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

// ---------------------------------------------------------------------------
// 下書き
// ---------------------------------------------------------------------------

/** 宛先の欄 1 つ分。確定した宛先と、入力途中の文字列。 */
export type DraftRecipients = { list: Address[]; text: string };

/** 下書きに付けたファイル。実体は添付ファイルの置き場 (attachment-store) にある。 */
export type DraftAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

/**
 * 書きかけのメール。どの端末からも続きを書けるよう、サーバーに置く。
 * id は端末が決める UUID で、送信するときの idempotencyKey にもなる
 * (同じ下書きを 2 台から送っても 1 通しか送られない)。
 */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 差出人にするメールアカウント。 */
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    to: jsonb().$type<DraftRecipients>().notNull(),
    cc: jsonb().$type<DraftRecipients>().notNull(),
    bcc: jsonb().$type<DraftRecipients>().notNull(),
    subject: text().notNull().default(""),
    /** 本文 (書式付き)。 */
    html: text().notNull().default(""),
    /** 本文をテキストに直したもの。一覧での表示と、メールサーバーへの保存に使う。 */
    text: text().notNull().default(""),
    attachments: jsonb().$type<DraftAttachment[]>().notNull().default([]),
    mode: text().$type<"new" | "reply" | "forward">().notNull().default("new"),
    /** 返信・転送の元になったメッセージ (messages.id)。消えていてもよいので参照にはしない。 */
    sourceMessageId: uuid(),
    /** 保存のたびに増える番号。端末は、自分が元にした番号と違えば他の端末の変更に気づける。 */
    revision: integer().notNull().default(1),
    /** メールサーバーの下書きフォルダへ保存し終えた revision。まだなら null。 */
    syncedRevision: integer(),
    /** メールサーバーに置いた控えの場所。IMAP はフォルダのパスと UID、Graph はメッセージの ID。 */
    remoteMessageId: text(),
    remoteMailboxPath: text(),
    remoteUid: bigint({ mode: "bigint" }),
    remoteUidValidity: bigint({ mode: "bigint" }),
    remoteProviderId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("drafts_user_updated_idx").on(t.userId, t.updatedAt),
    index("drafts_account_idx").on(t.accountId),
  ],
);

// ---------------------------------------------------------------------------
// 統合フォルダ
// ---------------------------------------------------------------------------

/** 統合フォルダが集めるフォルダの役割 (mailboxes.specialUse のうち選べるもの)。 */
export type UnifiedRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "junk"
  | "trash";

/** 統合フォルダが集めるメールの場所。 */
export type UnifiedScope = {
  /** すべてのフォルダ (ごみ箱と迷惑メールを除く) から集める。true なら下の 2 つは見ない。 */
  all: boolean;
  /** 全アカウントの、この役割のフォルダ (後から足したアカウントの分も入る)。 */
  roles: UnifiedRole[];
  /** 個別に選んだフォルダ (mailboxes.id)。無くなったフォルダの ID は無視する。 */
  mailboxIds: string[];
};

/** 文字で絞り込む場所。any は件名・差出人・宛先・本文のどこか。 */
export type UnifiedTextField = "from" | "to" | "subject" | "body" | "any";

/** メールの状態。 */
export type UnifiedFlag = "unread" | "flagged" | "hasAttachment" | "answered";

/**
 * 条件ビルダーの条件 1 つ。negate が true なら「〜でない」(含まない、未読でない、N 日より前など)。
 * - text: その場所に value を含む (部分一致、大文字小文字は区別しない)。
 * - flag: その状態である。
 * - received: 受信してから days 日以内。
 * - query: 検索欄と同じ書き方 (from: や OR など) で書いた条件に当てはまる。
 */
export type UnifiedRule =
  | { type: "text"; field: UnifiedTextField; value: string; negate: boolean }
  | { type: "flag"; flag: UnifiedFlag; negate: boolean }
  | { type: "received"; days: number; negate: boolean }
  | { type: "query"; value: string; negate: boolean };

/**
 * 条件のグループ。all はすべてに当てはまる (AND)、any はいずれかに当てはまる (OR)、
 * none はどれにも当てはまらない (NOT ... OR ...)。グループの中にグループを入れられる。
 * 中身が空のグループや、文字が空の条件は、無いものとして扱う。
 */
export type UnifiedGroup = {
  type: "group";
  match: "all" | "any" | "none";
  children: UnifiedCondition[];
};

export type UnifiedCondition = UnifiedRule | UnifiedGroup;

/**
 * 統合フォルダに並べるメールの条件 (条件ビルダーで組んだ木)。
 * version 1 (未読のみ・差出人などをすべて AND で持つ形) はマイグレーション 0032 で変換した。
 */
export type UnifiedFilters = { version: 2; root: UnifiedGroup };

/**
 * 利用者が作った統合フォルダ。複数のアカウントのフォルダを 1 つの一覧にまとめ、
 * 条件で絞り込める。メールサーバーには何も作らない (画面での見せ方だけ)。
 */
export const unifiedFolders = pgTable(
  "unified_folders",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** アイコンの名前か絵文字。選んでいなければ null (既定のアイコンを出す)。 */
    icon: text(),
    /** アイコンの色 ("#rrggbb")。選んでいなければ null。 */
    color: text(),
    scope: jsonb().$type<UnifiedScope>().notNull(),
    filters: jsonb().$type<UnifiedFilters>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("unified_folders_user_idx").on(t.userId)],
);

/**
 * サイドバーのカテゴリ (利用者が作る、アカウントや統合フォルダのまとまり)。
 * items は中に入れた項目 (初めからある項目の名前、統合フォルダの ID、アカウントの ID)。
 * 中での順番は、項目そのものの並び順 (order やアカウントの並び順) に従う。
 */
export type SidebarCategory = {
  id: string;
  name: string;
  items: string[];
};

/** 初めからある項目の見た目。null は初期の設定のまま。 */
export type BuiltinViewStyle = {
  name: string | null;
  icon: string | null;
  color: string | null;
};

/**
 * サイドバー上部の項目 (すべての受信トレイ、スター付き、下書き、送信待ち、統合フォルダ) の
 * 並び順と、隠している項目。項目は、決まった名前 (inbox など) か統合フォルダの ID で表す。
 */
export const sidebarLayouts = pgTable("sidebar_layouts", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 上から順の項目。載っていない項目は、既定の順でその後ろに並ぶ。 */
  order: jsonb().$type<string[]>().notNull().default([]),
  hidden: jsonb().$type<string[]>().notNull().default([]),
  /** 初めからある項目 (inbox など) に付けた名前・アイコン・色。変えていない項目は載らない。 */
  builtins: jsonb()
    .$type<Record<string, BuiltinViewStyle>>()
    .notNull()
    .default({}),
  /** サイドバーのカテゴリ (上から順)。 */
  categories: jsonb().$type<SidebarCategory[]>().notNull().default([]),
  /**
   * カテゴリに入れていないアカウントとカテゴリの、混ぜた並び (ID、上から順)。
   * どこに何が来るか (アカウントかカテゴリか) だけを決め、アカウントどうし・カテゴリどうしの
   * 順番は、それぞれの並び順に従う。
   */
  sectionOrder: jsonb().$type<string[]>().notNull().default([]),
  updatedAt: updatedAt(),
});

/** 一覧の行を左右にスワイプしたときの操作。 */
export type SwipeAction =
  | "none"
  | "toggle_read"
  | "star"
  | "archive"
  | "delete"
  | "junk"
  | "move";

/** 左へスワイプしたときと、右へスワイプしたときの操作。 */
export type SwipeSettings = { left: SwipeAction; right: SwipeAction };

/**
 * 日付と時刻の形式 (Windows の「地域」の設定と同じ書き方の書式)。
 * listDate は一覧の日付 (auto は今日なら時刻だけ、datetime は常に日付と時刻)。
 */
export type DateFormatSettings = {
  listDate: "auto" | "datetime";
  shortDateFormat: string;
  monthDayFormat: string;
  longDateFormat: string;
  shortTimeFormat: string;
  longTimeFormat: string;
};

/**
 * 利用者ごとの、どの端末でも同じにする設定。行の無い利用者は、すべて標準の値。
 * 画面の大きさなどに依る設定 (フォント、行の間隔など) は端末側に保存する。
 */
export const userSettings = pgTable("user_settings", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 一覧のスワイプ操作。null は標準の値。 */
  swipe: jsonb().$type<SwipeSettings>(),
  /**
   * 新着メールの通知に付けるボタン (read、star、archive、delete、junk を出す順に)。
   * null は標準の値、空の配列はボタンを付けない。
   */
  notificationActions: jsonb().$type<string[]>(),
  /** 日付と時刻の形式。null は標準の値。 */
  dateFormat: jsonb().$type<DateFormatSettings>(),
  /**
   * 差出人のアイコンを Gravatar で探す。取得はサーバーが代わりに行うので、
   * 端末ごとではなく利用者ごとに決める (アドレスのハッシュが Gravatar に送られるため、標準はオフ)。
   */
  senderIconGravatar: boolean().notNull().default(false),
  updatedAt: updatedAt(),
});

/** 署名の決まりの種類。contact は宛先のアドレスごと、thread は会話ごと。 */
export type SignatureRuleKind = "contact" | "thread";

/**
 * 連絡先 (宛先のアドレス) ごと、会話ごとの署名。アカウントの署名より優先して使う。
 * 連絡先の決まりは利用者のすべてのアカウントに効き、会話の決まりはその会話のあるアカウントにだけ効く。
 */
export const signatureRules = pgTable(
  "signature_rules",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().$type<SignatureRuleKind>().notNull(),
    /** 会話のあるアカウント。連絡先の決まりでは null。 */
    accountId: uuid().references(() => mailAccounts.id, {
      onDelete: "cascade",
    }),
    /** 連絡先は小文字にしたメールアドレス、会話は会話のキー (messages.thread_key)。 */
    key: text().notNull(),
    /** 一覧に出す名前 (連絡先の名前、会話の件名)。分からなければ null。 */
    label: text(),
    /** 使う署名 (書式付き)。null は「署名を付けない」。 */
    signatureHtml: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("signature_rules_contact_idx")
      .on(t.userId, t.key)
      .where(sql`${t.kind} = 'contact'`),
    uniqueIndex("signature_rules_thread_idx")
      .on(t.accountId, t.key)
      .where(sql`${t.kind} = 'thread'`),
    index("signature_rules_user_idx").on(t.userId),
  ],
);

/**
 * 差出人のアイコン (BIMI のロゴ、Gravatar、ドメインのファビコン) のキャッシュ。
 * どれも公開されている情報なので、利用者をまたいで共有する。
 * 見つからなかったことも data = null で覚え、同じ問い合わせを繰り返さない。
 */
export const senderIcons = pgTable("sender_icons", {
  /** 「bimi:example.com」「gravatar:<SHA-256>」「favicon:example.com」の形。 */
  key: text().primaryKey(),
  /** 画像の種類 (image/png など)。見つからなかったときは null。 */
  contentType: text(),
  data: bytea(),
  fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** この時刻を過ぎたら取り直す。 */
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
