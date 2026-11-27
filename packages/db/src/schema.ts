import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  customType,
  date,
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
    /** 発行した管理者。管理者を消しても、招待は残す。 */
    createdBy: uuid().references(() => adminUsers.id, {
      onDelete: "set null",
    }),
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
 * 外部アカウントの accounts とは別物。
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
  (t) => [
    index("auth_accounts_user_idx").on(t.userId),
    // 1 つの IdP のアカウントは、1 人の利用者にしか結び付けない。
    uniqueIndex("auth_accounts_provider_account_idx").on(
      t.providerId,
      t.accountId,
    ),
    // 1 人の利用者が 1 つの IdP に結び付けられるのは、1 つのアカウントだけ。
    uniqueIndex("auth_accounts_user_sso_idx")
      .on(t.userId, t.providerId)
      .where(sql`${t.providerId} like 'sso:%'`),
  ],
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

// ---------------------------------------------------------------------------
// 管理者 (一般の利用者とは別のアカウント)
// ---------------------------------------------------------------------------

/**
 * サーバーの管理者。一般の利用者 (users) とは別のアカウントで、メールは持たず、
 * 管理画面 (/admin) にだけログインできる。ログインは名前 (username) とパスワード
 * (+ 2 段階認証・パスキー) で、SSO は通らない。
 * admin_* の表は、管理者用の Better Auth (apps/api の admin-auth.ts) が読み書きする。
 */
export const adminUsers = pgTable("admin_users", {
  id: id(),
  /** ログインに使う名前 (小文字に揃えて保存する)。 */
  username: text().notNull().unique(),
  /** 入力されたままの名前 (大文字・小文字を残す)。 */
  displayUsername: text(),
  /**
   * Better Auth が必須とする項目。管理者はメールを持たないので、
   * 名前から作った届かないアドレス (<名前>@admin.orbit.invalid) を入れる。
   */
  email: text().notNull().unique(),
  /** 表示名。 */
  name: text().notNull(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  twoFactorEnabled: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("admin_sessions_user_idx").on(t.userId)],
);

export const adminAuthAccounts = pgTable(
  "admin_auth_accounts",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("admin_auth_accounts_user_idx").on(t.userId)],
);

export const adminVerifications = pgTable(
  "admin_verifications",
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("admin_verifications_identifier_idx").on(t.identifier)],
);

export const adminTwoFactors = pgTable(
  "admin_two_factors",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("admin_two_factors_user_idx").on(t.userId),
    index("admin_two_factors_secret_idx").on(t.secret),
  ],
);

export const adminPasskeys = pgTable(
  "admin_passkeys",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    name: text(),
    publicKey: text().notNull(),
    credentialID: text("credential_id").notNull(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    aaguid: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("admin_passkeys_user_idx").on(t.userId),
    uniqueIndex("admin_passkeys_credential_idx").on(t.credentialID),
  ],
);

/** IdP のトークン エンドポイントへのクライアントの認証方法。 */
export const ssoTokenAuthMethod = pgEnum("sso_token_auth_method", [
  "client_secret_basic",
  "client_secret_post",
]);

/**
 * Orbit のログインに使える外部の IdP (OAuth2 / OpenID Connect)。管理者が管理画面で登録する。
 * 利用者と IdP のアカウントの結び付きは auth_accounts (provider_id = "sso:<この ID>"、
 * account_id = IdP の利用者 ID) に入れる。
 */
export const ssoProviders = pgTable("sso_providers", {
  id: id(),
  /** ログイン画面のボタンに出す名前。 */
  name: text().notNull(),
  clientId: text().notNull(),
  /** クライアント シークレット。CREDENTIALS_ENCRYPTION_KEY で暗号化して保存する。 */
  clientSecretEncrypted: text().notNull(),
  /** OpenID Connect の設定の URL (…/.well-known/openid-configuration)。null なら下の 3 つを使う。 */
  discoveryUrl: text(),
  authorizationUrl: text(),
  tokenUrl: text(),
  userInfoUrl: text(),
  /** 求める権限 (空白区切り)。 */
  scopes: text().notNull(),
  /** プロフィールの、利用者 ID・メールアドレス・名前が入っている項目の名前。 */
  subjectClaim: text().notNull().default("sub"),
  emailClaim: text().notNull().default("email"),
  nameClaim: text().notNull().default("name"),
  tokenAuthMethod: ssoTokenAuthMethod()
    .notNull()
    .default("client_secret_basic"),
  /** PKCE を使う (対応していない IdP のときだけ false)。 */
  usePkce: boolean().notNull().default(true),
  /** 初めてログインした人の Orbit のアカウントを自動で作る。 */
  allowSignUp: boolean().notNull().default(false),
  /** 自動で作ってよいメールアドレスのドメイン (小文字)。空なら制限しない。 */
  allowedDomains: text().array().notNull().default(sql`'{}'::text[]`),
  /** IdP が返すメールアドレスを信頼し、同じアドレスの利用者に自動で結び付ける。 */
  trustEmail: boolean().notNull().default(false),
  /** この IdP でのログインでは、Orbit の 2 段階認証を求めない。 */
  skipTwoFactor: boolean().notNull().default(false),
  /** 自動で作った利用者に、初回ログイン後にメールアカウントの追加を案内する。 */
  suggestMailAccount: boolean().notNull().default(false),
  /** false ならログイン画面に出さず、ログインもできない (設定は残す)。 */
  enabled: boolean().notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const devicePlatform = pgEnum("device_platform", [
  "web",
  "desktop",
  "android",
  "ios",
]);

/** devices.app の値 (@orbit/core の DeviceApp と同じ)。 */
export type DeviceAppValue = "mail" | "calendar";

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
    /**
     * 登録したアプリ (段取り 9)。Android の Calendar アプリ (段取り 10) は calendar。
     * enum にしない (enum の値の追加を同じトランザクションで使えない問題を避ける)。
     */
    app: text().$type<DeviceAppValue>().notNull().default("mail"),
    /** 新着メールの通知を送る。 */
    notifyMail: boolean().notNull().default(true),
    /**
     * 予定の通知を送る。古いアプリは予定の通知を正しく出せないので、新しいアプリが
     * 登録のときに明示して true にしたものにだけ送る (既定 false)。
     */
    notifyCalendar: boolean().notNull().default(false),
    /** 端末の ID (Web の deviceId())。 */
    installId: uuid(),
    /**
     * 端末が自分で予約済みのリマインダーの範囲 (POST /v1/push/devices/reminders)。
     * coverUntil までの時刻で、job の changeSeq が coverSeq 以下で、exactAlarms なら push を省く。
     * 送り先を別の利用者に付け替えるときは消す。
     */
    reminderCoverUntil: timestamp({ withTimezone: true }),
    reminderCoverSeq: bigint({ mode: "bigint" }),
    exactAlarms: boolean().notNull().default(false),
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
    /** 新着メールの通知を送る。 */
    notifyMail: boolean().notNull().default(true),
    /** 予定の通知を送る (新しいサービスワーカーが登録のときに true にしたものだけ)。 */
    notifyCalendar: boolean().notNull().default(false),
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

/** メールを書く形式。html は書式付き、text はテキストだけ (プレーンテキスト)。 */
export type ComposeFormat = "html" | "text";

/**
 * 利用者が登録した外部アカウント (Gmail など)。
 * メールとカレンダー (将来は連絡先) をアカウントごとにオンにする。
 */
export const accounts = pgTable(
  "accounts",
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
    /** このアカウントでメールを使う。 */
    mailEnabled: boolean().notNull().default(true),
    /** このアカウントでカレンダーを使う。 */
    calendarEnabled: boolean().notNull().default(false),
    /** OAuth で許可されたスコープ (空白区切り)。null は不明 (記録する前に追加したアカウント)。 */
    oauthScopes: text(),
    /** カレンダーの同期のアカウント単位の失敗 (認証、スコープ不足、設定なし)。無ければ null。 */
    calendarError: text(),
    /** 一般の CalDAV サーバーの起点の URL。iCloud や CalDAV を使わないアカウントは null。 */
    caldavUrl: text(),
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
    /**
     * このアカウントから書くメールの形式。html は書式付き、text はテキストだけ。
     * null なら利用者の既定 (user_settings.compose_format) に従う。
     */
    composeFormat: text().$type<ComposeFormat>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 同じアドレスでも、受信サーバーかユーザー名が違えば別のアカウントとして追加できる
    // (例: ドコモメールを IMAP で、同じアドレスのメッセージR/S を POP3 で)。
    // Microsoft Graph のアカウントは受信サーバーが無い (null) ので、空文字として比べる。
    uniqueIndex("accounts_user_email_server_idx").on(
      t.userId,
      t.email,
      sql`coalesce(lower(${t.imapHost}), '')`,
      t.username,
    ),
    index("accounts_user_email_idx").on(t.userId, t.email),
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
      .references(() => accounts.id, { onDelete: "cascade" }),
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
      .references(() => accounts.id, { onDelete: "cascade" }),
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
      .references(() => accounts.id, { onDelete: "cascade" }),
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
  "calendar",
  "event",
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
  (t) => [
    index("changes_user_seq_idx").on(t.userId, t.seq),
    /**
     * 消えた予定の作り直しを防ぐ (POST /v1/calendars/events の再送) ときに引く。
     * entity の値は条件に入れない ("event" は後から足した enum の値で、新しい DB に全部の
     * マイグレーションを 1 つのトランザクションで当てると使えないため)。
     * changes は大きく書き込みも多い表なので、マイグレーション 0047 では作らず、同期ワーカーが
     * 起動時に CREATE INDEX CONCURRENTLY で作る (apps/worker/src/changes-index.ts)。
     */
    index("changes_delete_entity_idx")
      .on(t.entityId)
      .where(sql`${t.op} = 'delete'`),
  ],
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
  "event_create",
  "event_update",
  "event_delete",
  "event_respond",
  /** Orbit が送る招待メール (iMIP)。送信元のメールアカウントに積み、processSends が送る。 */
  "imip_send",
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
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: outboxKind().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** 端末が操作ごとに付ける一意な ID。再送されても二重に実行しない。 */
    idempotencyKey: text().notNull(),
    status: outboxStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * 一時的な失敗が最初に起きた時刻 (予定の書き戻し event_* で使う)。ここからの経過時間で
     * 打ち切る。失敗していなければ null。
     */
    firstFailedAt: timestamp({ withTimezone: true }),
    /**
     * 予約送信で利用者が指定した日時 (send のみ)。予約でなければ null。
     * 予約の間は runAfter も同じ日時になる。「今すぐ送信」にすると null に戻す。
     */
    scheduledAt: timestamp({ withTimezone: true }),
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
      .references(() => accounts.id, { onDelete: "cascade" }),
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
    /** 書いている形式。text なら本文は text 列が正で、html 列はそれを HTML にしたもの。 */
    format: text().$type<ComposeFormat>().notNull().default("html"),
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
  /** メールを書くときの既定の形式。アカウントごとの指定 (accounts.compose_format) が優先。 */
  composeFormat: text().$type<ComposeFormat>().notNull().default("html"),
  /**
   * 利用者のタイムゾーン (IANA 名、段取り 9)。サーバーが終日の予定の通知の時刻を決めるのに使う。
   * null のあいだは、最初に開いた端末が自分のタイムゾーンを保存する。
   */
  timeZone: text(),
  /** 予定の通知の設定。null は標準の値 (@orbit/core の readCalendarNotificationSettings で読む)。 */
  calendarNotifications: jsonb().$type<StoredCalendarNotificationSettings>(),
  updatedAt: updatedAt(),
});

/** user_settings.calendar_notifications (@orbit/core の CalendarNotificationSettings と同じ形)。 */
export type StoredCalendarNotificationSettings = {
  invites?: boolean;
  changes?: boolean;
  replies?: boolean;
  allDay?: { minutes: number } | null;
  detail?: "full" | "private";
};

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
    accountId: uuid().references(() => accounts.id, {
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

// ---------------------------------------------------------------------------
// カレンダー
// ---------------------------------------------------------------------------

/**
 * カレンダーの出どころ。google / microsoft / caldav はアカウントのカレンダー、
 * ics は URL の購読、local は Orbit 内だけのカレンダー、holidays は日本の祝日 (アプリが持つ)、
 * birthdays は各サービスの誕生日をまとめたもの。
 */
export const calendarSource = pgEnum("calendar_source", [
  "google",
  "microsoft",
  "caldav",
  "ics",
  "local",
  "holidays",
  "birthdays",
]);

/** プロバイダの既定のリマインダー (Google の defaultReminders など)。 */
export type CalendarReminder = { method: "display" | "email"; minutes: number };

/**
 * 利用者のカレンダー。アカウントのカレンダー (accountId あり) と、
 * アカウントを持たないカレンダー (ICS の購読、Orbit 内、祝日、誕生日) がある。
 */
export const calendars = pgTable(
  "calendars",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid().references(() => accounts.id, { onDelete: "cascade" }),
    source: calendarSource().notNull(),
    /** プロバイダでの ID (Google の calendarId、Graph の id、CalDAV のコレクションの URL)。 */
    remoteId: text(),
    name: text().notNull(),
    description: text(),
    /** 表示色 "#rrggbb"。利用者が選んだ色があればそれ、無ければプロバイダの色。 */
    color: text(),
    /** カレンダーの既定のタイムゾーン (IANA 名)。 */
    timeZone: text(),
    /** 書き込めない (購読、祝日、誕生日、閲覧だけの共有) なら true。 */
    readOnly: boolean().notNull().default(false),
    /** 画面に表示する。サイドバーのチェックで切り替える。 */
    visible: boolean().notNull().default(true),
    /** サイドバーでの表示順 (小さいほど上)。null は追加した順。 */
    sortOrder: integer(),
    /** ICS の購読や CalDAV の URL。 */
    url: text(),
    /** CalDAV / ICS の確認間隔 (秒)。null は既定 (CalDAV 5 分、ICS 1 時間)。 */
    pollIntervalSeconds: integer(),
    /** 差分同期の続きの位置 (Google の syncToken、Graph の deltaLink、CalDAV の sync-token)。 */
    syncToken: text(),
    /** CalDAV の getctag や ICS の ETag / Last-Modified。変わっていなければ取得を省く。 */
    etag: text(),
    /** 最後に同期が最後まで成功した時刻。失敗では進めない (書き戻しの gone の決まりの基準)。 */
    lastSyncedAt: timestamp({ withTimezone: true }),
    /** 最後に同期を試みた時刻 (成功も失敗も)。失敗したカレンダーの次の確認の時期に使う。 */
    syncAttemptedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** 変更通知 (Google の watch、Graph の subscription) の ID と期限。 */
    pushChannelId: text(),
    pushExpiresAt: timestamp({ withTimezone: true }),
    defaultReminders: jsonb().$type<CalendarReminder[]>(),
    /**
     * プロバイダが自由に使う欄 (Google の watch の resourceId、CalDAV が sync-collection に
     * 対応しているか、など)。
     */
    providerState: jsonb().$type<Record<string, unknown>>(),
    /**
     * 招待メール (iMIP) の送信元に利用者が選んだメールアカウント。null は自動で決める
     * (apps/api/src/lib/imip-sender.ts)。アカウントを消すと null に戻る。
     */
    imipAccountId: uuid().references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** 繰り返しの回を event_occurrences に展開済みの範囲の終わり (この日の前日まで)。 */
    expandedUntil: date({ mode: "string" }),
    /**
     * 予定の通知 (リマインダー・招待・変更) を出す (段取り 9)。null は種類ごとの既定
     * (ics・holidays・birthdays はオフ、ほかはオン。@orbit/core の calendarNotifies)。
     */
    notify: boolean(),
    /**
     * 通知に関わる値 (notify、visible、defaultReminders、timeZone) をつないだもの
     * (@orbit/core の calendarRemindersFingerprint)。ReminderIndexer が、変わったときだけ作り直す。
     */
    remindersHash: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("calendars_user_idx").on(t.userId),
    uniqueIndex("calendars_account_remote_idx").on(t.accountId, t.remoteId),
  ],
);

export const eventStatus = pgEnum("event_status", [
  "confirmed",
  "tentative",
  "cancelled",
]);

/**
 * 予定の主催者。self は自分が主催者か (Google の organizer.self、Graph の isOrganizer、
 * CalDAV はアカウントのアドレスとの比較)。段取り 8 より前に取り込んだ行には無い。
 */
export type EventPerson = { email: string; name?: string; self?: boolean };

/**
 * 予定。繰り返しは原本 (rrule を持つ親) と、その回だけ変えた例外 (recurrenceId を持つ子) で持つ。
 * 時刻のある予定は startAt / endAt (UTC) とタイムゾーン、終日の予定は startDate / endDate
 * (endDate はその日を含まない) で持つ。
 * raw はプロバイダの元データ (iCalendar の文字列や JSON)。書き戻すときに、Orbit が知らない
 * 項目を消さないために使い、競合を項目ごとにまとめるときの基準にもする。
 */
export const events = pgTable(
  "events",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: uuid()
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    /** iCalendar の UID。繰り返しの原本と例外で同じ値になる。 */
    uid: text().notNull(),
    /**
     * 例外のとき、元の回の開始 (時刻付きは UTC の ISO 8601、終日は YYYY-MM-DD)。
     * 原本と繰り返さない予定は null。
     */
    recurrenceId: text(),
    /** 例外の原本。原本と繰り返さない予定は null。 */
    parentId: uuid().references((): AnyPgColumn => events.id, {
      onDelete: "cascade",
    }),
    /** プロバイダでの ID (Google / Graph の id、CalDAV のリソースの URL)。Orbit 内は null。 */
    remoteId: text(),
    /** プロバイダの ETag。書き戻すときに、相手が変わっていないことの確認に使う。 */
    etag: text(),
    summary: text(),
    location: text(),
    description: text(),
    status: eventStatus().notNull().default("confirmed"),
    /** 予定あり (OPAQUE) なら true、空き時間として扱う (TRANSPARENT) なら false。 */
    busy: boolean().notNull().default(true),
    allDay: boolean().notNull().default(false),
    startAt: timestamp({ withTimezone: true }),
    endAt: timestamp({ withTimezone: true }),
    startDate: date({ mode: "string" }),
    endDate: date({ mode: "string" }),
    /** 開始と終了のタイムゾーン (IANA 名)。終日や浮動時刻 (タイムゾーン無し) は null。 */
    startTimeZone: text(),
    endTimeZone: text(),
    /** 繰り返しの規則 (RRULE の値、"FREQ=WEEKLY;BYDAY=MO" など)。繰り返さなければ null。 */
    rrule: text(),
    /** 追加の回 (RDATE) と除く回 (EXDATE)。recurrenceId と同じ書き方。 */
    rdates: jsonb().$type<string[]>(),
    exdates: jsonb().$type<string[]>(),
    organizer: jsonb().$type<EventPerson>(),
    /** iCalendar の SEQUENCE。招待の更新で増える。 */
    sequence: integer().notNull().default(0),
    /** Google の Meet、Teams などの会議の URL。 */
    conferenceUrl: text(),
    /** カレンダーの既定のリマインダーを使う (Google の useDefault)。 */
    useDefaultReminders: boolean().notNull().default(true),
    /** プロバイダでの最終更新時刻 (Google の updated、Graph の lastModifiedDateTime、LAST-MODIFIED)。 */
    remoteUpdatedAt: timestamp({ withTimezone: true }),
    /**
     * 項目ごとの最後の変更時刻 (項目名 → ISO 8601)。同じ項目の変更がぶつかったとき、
     * 後から変更した方を残すために使う。
     */
    fieldUpdatedAt: jsonb().$type<Record<string, string>>(),
    /**
     * 相手側で消えたのを取り込みが見たが、書き戻し待ちなので消すのを見送った予定に付ける。
     * 値は、その前に相手側にあると確かめていた時刻 (直前に成功した同期の時刻)。
     * 相手側の削除はこの時刻より後に起きた。書き戻しの gone の決まりで、ローカルの変更と比べる。
     * 相手側の内容を書き込むと null に戻る。
     */
    remoteDeletedAfter: timestamp({ withTimezone: true }),
    /** メールから取り込んだ・更新した招待 (REQUEST) の DTSTAMP。次の更新との新旧の比較に使う。 */
    inviteStamp: timestamp({ withTimezone: true }),
    raw: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("events_calendar_uid_recurrence_idx").on(
      t.calendarId,
      t.uid,
      sql`coalesce(${t.recurrenceId}, '')`,
    ),
    index("events_user_idx").on(t.userId),
    index("events_parent_idx").on(t.parentId),
    index("events_calendar_remote_idx").on(t.calendarId, t.remoteId),
  ],
);

export const attendeeStatus = pgEnum("attendee_status", [
  "needs_action",
  "accepted",
  "declined",
  "tentative",
  "delegated",
]);

export const attendeeRole = pgEnum("attendee_role", [
  "chair",
  "required",
  "optional",
  "non_participant",
]);

/** 予定の参加者と出欠。 */
export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: id(),
    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    email: text().notNull(),
    name: text(),
    role: attendeeRole().notNull().default("required"),
    status: attendeeStatus().notNull().default("needs_action"),
    /** 利用者自身 (このアカウントのアドレス) なら true。出欠ボタンの対象。 */
    self: boolean().notNull().default(false),
    comment: text(),
    /** 最後に反映した返事 (REPLY) の DTSTAMP。これより古い返事は捨てる。 */
    repliedAt: timestamp({ withTimezone: true }),
    /** 最後に反映した返事の SEQUENCE。 */
    replySequence: integer(),
  },
  (t) => [
    uniqueIndex("event_attendees_event_email_idx").on(
      t.eventId,
      sql`lower(${t.email})`,
    ),
  ],
);

/** 予定ごとのリマインダー (useDefaultReminders が false のとき使う)。 */
export const eventReminders = pgTable(
  "event_reminders",
  {
    id: id(),
    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    method: text().$type<CalendarReminder["method"]>().notNull(),
    /** 開始の何分前か。 */
    minutes: integer().notNull(),
  },
  (t) => [index("event_reminders_event_idx").on(t.eventId)],
);

/**
 * 表示と通知のために展開した回。原本と例外から作り直せるので正本ではない。
 * 繰り返さない予定も 1 回として入れ、期間で引くときはこの表だけを見る。
 * eventId は回の中身を持つ予定 (例外があれば例外、無ければ原本)。
 */
export const eventOccurrences = pgTable(
  "event_occurrences",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: uuid()
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    /** 繰り返しの原本 (繰り返さない予定はその予定)。 */
    masterId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /**
     * 例外の行が消えたときは null になる (原本の回は残る)。ReminderIndexer は null の行の原本だけを
     * 作り直す (例外の削除で利用者の繰り返す原本を全部作り直さないため。レビュー M8)。
     */
    eventId: uuid().references(() => events.id, { onDelete: "set null" }),
    /** この回の元の開始 (events.recurrenceId と同じ書き方)。繰り返さない予定は null。 */
    recurrenceId: text(),
    allDay: boolean().notNull().default(false),
    startAt: timestamp({ withTimezone: true }),
    endAt: timestamp({ withTimezone: true }),
    startDate: date({ mode: "string" }),
    endDate: date({ mode: "string" }),
  },
  (t) => [
    index("event_occurrences_user_start_at_idx").on(t.userId, t.startAt),
    index("event_occurrences_user_start_date_idx").on(t.userId, t.startDate),
    index("event_occurrences_master_idx").on(t.masterId),
    index("event_occurrences_event_idx").on(t.eventId),
    uniqueIndex("event_occurrences_master_recurrence_idx").on(
      t.masterId,
      sql`coalesce(${t.recurrenceId}, '')`,
    ),
  ],
);

/**
 * サーバーが push で送るリマインダー (段取り 9)。worker の ReminderIndexer が event_occurrences と
 * 一緒に作り直し、NotificationDispatcher が fire_at の来たものを送る。
 * changeSeq は内容 (鳴らす時刻) が最後に変わった changes.seq。端末が予約済みか (coverSeq) と比べる。
 * 題名だけが変わったときは sentAt を保ち、鳴らす時刻が先へ動いたら sentAt を null に戻す。
 */
export const eventReminderJobs = pgTable(
  "event_reminder_jobs",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    occurrenceId: uuid()
      .notNull()
      .references(() => eventOccurrences.id, { onDelete: "cascade" }),
    /** 開始の何分前か (終日の利用者ごとの既定では負もある)。 */
    minutes: integer().notNull(),
    fireAt: timestamp({ withTimezone: true }).notNull(),
    changeSeq: bigint({ mode: "bigint" }).notNull(),
    sentAt: timestamp({ withTimezone: true }),
    /**
     * NotificationDispatcher が送るために取った時刻。送り終えたら sentAt を付ける。
     * 取ったまま一定の時間 (worker の停止など) たったものは取り直す。
     */
    claimedAt: timestamp({ withTimezone: true }),
    /** 取った回数。上限に達したら送らずに済ませる (同じ行で worker が落ち続けないように)。 */
    attempts: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("event_reminder_jobs_occurrence_minutes_idx").on(
      t.occurrenceId,
      t.minutes,
    ),
    index("event_reminder_jobs_pending_idx")
      .on(t.fireAt)
      .where(sql`${t.sentAt} is null`),
    index("event_reminder_jobs_user_idx").on(t.userId),
  ],
);

/** event_notices.kind の値。 */
export type EventNoticeKindValue = "invite" | "update" | "cancel";

/** event_notices.snapshot (@orbit/core の EventNoticeSnapshot と同じ形)。 */
export type StoredEventNoticeSnapshot = {
  title: string | null;
  location: string | null;
  organizer: string | null;
  sequence: number;
  rrule?: string | null;
  timeZone: string | null;
  /** 記録したときの自分の出欠 (取り消しを不参加の予定で出さないため)。古い行には無い。 */
  selfStatus?: string | null;
  allDay: boolean;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
};

/**
 * 招待・変更・取り消しの「知らせた内容」と送信待ち (段取り 9)。取り込みが予定を書いた直後に
 * 足し、NotificationDispatcher が sentAt の無いものを送る。最初の同期や過去の予定は、送信済みの
 * invite を静かに入れて基準だけ作る。calendarId と eventId は外部キーにしない (行が消えても残す)。
 * 予定の終了から 7 日たった行は worker が消す。
 */
export const eventNotices = pgTable(
  "event_notices",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: uuid().notNull(),
    eventId: uuid().notNull(),
    kind: text().$type<EventNoticeKindValue>().notNull(),
    snapshot: jsonb().$type<StoredEventNoticeSnapshot>().notNull(),
    createdAt: createdAt(),
    sentAt: timestamp({ withTimezone: true }),
    /** 送るために取った時刻 (event_reminder_jobs と同じ)。静かに入れた基準の行は null のまま。 */
    claimedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
  },
  (t) => [
    index("event_notices_event_idx").on(t.eventId, t.createdAt),
    index("event_notices_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.sentAt} is null`),
    index("event_notices_user_idx").on(t.userId, t.claimedAt),
  ],
);

/** worker の処理が読んだ changes の位置 (名前ごと。ReminderIndexer は "reminder-indexer")。 */
export const workerCursors = pgTable("worker_cursors", {
  name: text().primaryKey(),
  seq: bigint({ mode: "bigint" }).notNull(),
  updatedAt: updatedAt(),
});

/**
 * 予定の検索用の文書 (タイトル・場所・メモを正規化してつないだもの)。
 * メールの message_search と同じ 1〜2 文字の組の GIN で引く。
 */
export const eventSearch = pgTable(
  "event_search",
  {
    eventId: uuid()
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    doc: text().notNull(),
  },
  (t) => [
    index("event_search_grams_idx").using(
      "gin",
      sql`mail_search_grams(${t.doc})`,
    ),
    index("event_search_user_idx").on(t.userId),
  ],
);

export const eventConflictKind = pgEnum("event_conflict_kind", [
  /** 未送信の変更が、相手側の新しい変更に負けた (取り込みか、書き戻しの競合の統合)。 */
  "field_lost",
  /** 書き戻しが確定して失敗した。変更は相手側の内容に巻き戻し済み。 */
  "write_failed",
  /** 作成の書き戻しが確定して失敗した。行は残っている。 */
  "create_failed",
  /** 相手側で消されていて、ローカルの変更の方が古かったので消した。 */
  "remote_deleted",
  /** 削除しようとしたが、相手側の変更の方が新しかったので取りやめた。 */
  "delete_cancelled",
  /** 招待メール (iMIP) を送れなかった。lost に { outboxId, method, to } を入れる。 */
  "invite_failed",
]);

/**
 * 反映されなかった変更の記録 (端末の「反映されなかった変更」の一覧に出す)。
 * 同期ワーカーが書き、端末が閉じる (resolvedAt)。30 日たった行はワーカーが消す。
 * eventId は外部キーにしない (予定が消えても残す)。
 */
export const eventConflicts = pgTable(
  "event_conflicts",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: uuid()
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    eventId: uuid().notNull(),
    kind: eventConflictKind().notNull(),
    /** 関係する項目名 (EVENT_FIELD_NAMES)。削除の失敗などでは空。 */
    fields: jsonb().$type<string[]>().notNull().default([]),
    /** 負けた側 (Orbit) の値。API の予定の変更 (changes) と同じ形。 */
    lost: jsonb().$type<Record<string, unknown>>(),
    /** 消されたときの予定全体 (API の作成の項目と同じ形 + parentId、recurrenceId)。 */
    snapshot: jsonb().$type<Record<string, unknown>>(),
    /** 表示用の題名 (記録したときの予定の題名)。 */
    title: text(),
    reason: text(),
    createdAt: createdAt(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("event_conflicts_user_open_idx")
      .on(t.userId, t.createdAt)
      .where(sql`${t.resolvedAt} is null`),
    index("event_conflicts_created_idx").on(t.createdAt),
  ],
);
