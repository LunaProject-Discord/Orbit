import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_ACCOUNTS,
  CHANNEL_CHANGES,
  CHANNEL_OUTBOX,
  type ChangeNotification,
  createGoogleAuthorizeUrl,
  createMicrosoftAuthorizeUrl,
  decryptCredentials,
  EVENT_OUTBOX_KINDS,
  encryptCredentials,
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  fetchGoogleEmail,
  fetchMicrosoftProfile,
  GoogleOAuthError,
  hasGmailScope,
  hasGoogleCalendarScope,
  hasMicrosoftCalendarScope,
  MAIL_PROVIDER_PRESETS,
  MicrosoftOAuthError,
  openGoogleState,
  openMicrosoftState,
  providerOfImapHost,
  resolvesToPrivateAddress,
} from "@orbit/core";
import {
  accounts,
  changes,
  mailboxes,
  messages,
  outbox,
  popMessages,
} from "@orbit/db";
import { and, asc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { accountIcon } from "../lib/account-icon.js";
import {
  type DiscoveryDeps,
  defaultDiscoveryDeps,
  discoverMailSettings,
} from "../lib/autoconfig.js";
import { isDistinct, recordChanges } from "../lib/changes.js";
import { verifyImap as defaultVerifyImap } from "../lib/imap-verify.js";
import { verifyPop3 as defaultVerifyPop3 } from "../lib/pop3-verify.js";
import { verifySmtp as defaultVerifySmtp } from "../lib/smtp-verify.js";

const server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
});

/** 受信の方式。imap なら IMAP、pop3 なら POP3 で受け取る (どちらも送信は SMTP)。 */
const incomingProtocol = z.enum(["imap", "pop3"]);

/** POP3 で受け取るときの、サーバーに残すかどうかの設定。 */
const popOptions = z.object({
  /** 受け取ったメールをサーバーに残す。false なら取り込んだあとサーバーから消す。 */
  leaveOnServer: z.boolean(),
  /** サーバーに残したメールを、この日数が過ぎたら消す。null なら消さない。 */
  deleteAfterDays: z.number().int().min(1).max(3650).nullable(),
});

const createAccountBody = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().max(200).optional(),
  provider: z
    .enum(["gmail", "microsoft", "icloud", "generic"])
    .default("generic"),
  /**
   * 接続先。provider が gmail か icloud なら省略でき、そのサービスの決まった値を使う。
   * ユーザー名を省略するとメールアドレスを使う。
   * imap は受信の接続先で、incomingProtocol が pop3 なら POP3 サーバーを入れる。
   */
  incomingProtocol: incomingProtocol.default("imap"),
  imap: server.optional(),
  /** POP3 のときの、サーバーに残すかどうか。省略するとサーバーに残し、消さない。 */
  pop: popOptions.optional(),
  /** 送信の接続先。null なら受信専用のアカウントにする (送信サーバーを使わない)。 */
  smtp: server.nullable().optional(),
  username: z.string().min(1).max(320).optional(),
  password: z.string().min(1).max(1024),
  /**
   * 安全な再ネゴシエーションに対応していない古いサーバーへの接続を許す。
   * 接続先を手で設定したときだけ効く (Gmail と iCloud では使わない)。
   */
  allowLegacyTls: z.boolean().optional(),
});

const microsoftAuthorizeBody = z.object({
  /** 再ログインするアカウントの ID。ログイン画面にそのメールアドレスを入れておく。 */
  accountId: z.uuid().optional(),
  /** スマホアプリから始めるログイン。戻ってきた Web のページが、アプリへ引き渡す。 */
  app: z.boolean().optional(),
  /** 新しく追加するアカウントのメールアドレス。ログイン画面に入れておく。 */
  email: z.email().max(320).optional(),
  /**
   * カレンダーの権限も求める。省くと、再ログインではアカウントの calendarEnabled に従い
   * (使っている権限を失わないように)、新しく追加するときは求めない。
   */
  calendar: z.boolean().optional(),
});

/**
 * アプリから始めたログインの state に付ける目印。ログイン後に戻る先は Web 版の URL なので、
 * 戻ってきたページがこの目印を見て、アプリ専用の URL でアプリへ引き渡す。
 * 目印は state の検証には関わらない (complete で外してから確かめる)。
 */
const APP_STATE_PREFIX = "app~";

function markAppState(url: string, app: boolean | undefined): string {
  if (!app) return url;
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state");
  if (state) parsed.searchParams.set("state", `${APP_STATE_PREFIX}${state}`);
  return parsed.toString();
}

function unmarkAppState(state: string): string {
  return state.startsWith(APP_STATE_PREFIX)
    ? state.slice(APP_STATE_PREFIX.length)
    : state;
}

const oauthAuthorizeBody = microsoftAuthorizeBody;

const microsoftCompleteBody = z.object({
  code: z.string().min(1).max(8192),
  state: z.string().min(1).max(4096),
  /** 追加画面で入力した名前。新しく追加したときだけ使う (再ログインでは変えない)。 */
  displayName: z.string().trim().max(200).optional(),
});

const idParam = z.object({ id: z.uuid() });

const discoverBody = z.object({ email: z.email().max(320) });

/**
 * 追加済みアカウントの接続先を変える。password を省くと、保存済みのパスワードを使う。
 * incomingProtocol を省くと、いまの受信の方式のまま。変えると、取り込み済みのメールを
 * いったん消して、新しい方式で取り込み直す。
 */
const serverSettingsBody = z.object({
  incomingProtocol: incomingProtocol.optional(),
  imap: server,
  pop: popOptions.optional(),
  /** 送信の接続先。null なら受信専用にする。 */
  smtp: server.nullable(),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024).optional(),
  allowLegacyTls: z.boolean().optional(),
});

/** 接続の確認の結果。受信と送信を別々に返し、どちらが悪いかを画面で示せるようにする。 */
type ServerCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "auth_failed"
        | "connection_failed"
        | "legacy_tls_required"
        | "host_not_found"
        | "host_not_allowed";
      detail?: string;
    };

/** アカウントに付けられる色。"#rrggbb" (小文字) の色そのもの。 */
const ACCOUNT_COLOR = /^#[0-9a-f]{6}$/;

const updateAccountBody = z
  .object({
    /** 署名 (書式付き)。null か空なら署名なしにする。 */
    signatureHtml: z.string().max(50_000).nullable().optional(),
    /** 画面に出す名前。null か空ならメールアドレスを出す。 */
    displayName: z.string().max(200).nullable().optional(),
    /** 画面でアカウントを見分ける色。null なら並び順から決める。 */
    color: z.string().regex(ACCOUNT_COLOR).nullable().optional(),
    /** 画面でアカウントに付けるアイコン。null なら色の点を出す。 */
    icon: accountIcon.nullable().optional(),
    /** 古い TLS のサーバーへの接続を許す。IMAP / SMTP のアカウントでだけ変えられる。 */
    allowLegacyTls: z.boolean().optional(),
    /**
     * 受信トレイ以外のフォルダの変化をすぐ受け取るために足す IMAP 接続の本数の上限。
     * null なら自動。IMAP / SMTP のアカウントでだけ変えられる。
     */
    pushConnections: z.number().int().min(0).max(8).nullable().optional(),
    /** このアカウントに届いた新着メールを通知する。 */
    notifyNewMail: z.boolean().optional(),
    /** POP3: 受け取ったメールをサーバーに残す。POP3 のアカウントでだけ変えられる。 */
    popLeaveOnServer: z.boolean().optional(),
    /** POP3: サーバーに残したメールを消すまでの日数。null なら消さない。 */
    popDeleteAfterDays: z.number().int().min(1).max(3650).nullable().optional(),
    /** このアカウントから書くメールの形式。null なら利用者の既定に従う。 */
    composeFormat: z.enum(["html", "text"]).nullable().optional(),
    /** このアカウントでメールを使う。 */
    mailEnabled: z.boolean().optional(),
    /**
     * このアカウントでカレンダーを使う。Gmail と Microsoft Graph でカレンダーの権限が無ければ
     * 409 consent_required (authorize に calendar: true を付けてログインし直してもらう)。
     */
    calendarEnabled: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined));

const orderBody = z.object({
  /** 上から順に並べたいアカウントの ID。 */
  accountIds: z.array(z.uuid()).min(1).max(200).refine(isDistinct),
});

/** クライアントへ返す形。認証情報は暗号文であっても返さない。 */
const publicColumns = {
  id: accounts.id,
  email: accounts.email,
  displayName: accounts.displayName,
  provider: accounts.provider,
  authType: accounts.authType,
  protocol: accounts.protocol,
  imapHost: accounts.imapHost,
  imapPort: accounts.imapPort,
  imapSecure: accounts.imapSecure,
  smtpHost: accounts.smtpHost,
  smtpPort: accounts.smtpPort,
  smtpSecure: accounts.smtpSecure,
  allowLegacyTls: accounts.allowLegacyTls,
  pushConnections: accounts.pushConnections,
  notifyNewMail: accounts.notifyNewMail,
  popLeaveOnServer: accounts.popLeaveOnServer,
  popDeleteAfterDays: accounts.popDeleteAfterDays,
  username: accounts.username,
  status: accounts.status,
  lastError: accounts.lastError,
  signatureHtml: accounts.signatureHtml,
  sortOrder: accounts.sortOrder,
  color: accounts.color,
  icon: accounts.icon,
  composeFormat: accounts.composeFormat,
  mailEnabled: accounts.mailEnabled,
  calendarEnabled: accounts.calendarEnabled,
  calendarError: accounts.calendarError,
  createdAt: accounts.createdAt,
};

/** 読み出す列。publicColumns に、calendarConsent を導くための列を足したもの。 */
const accountColumns = { ...publicColumns, oauthScopes: accounts.oauthScopes };
type AccountColumns = {
  [K in keyof typeof accountColumns]: (typeof accounts.$inferSelect)[K];
};

/**
 * カレンダーを使うための同意の状態。
 * - granted: OAuth でカレンダーの権限を許可済み。
 * - required: Gmail と Microsoft Graph で、カレンダーの権限が無い。ログインし直して許可してもらう
 *   (Gmail のアプリ パスワードのアカウントは、Google でのログインへの切り替えが要る)。
 * - not_applicable: 同意の仕組みが無いアカウント (CalDAV のパスワードなど)。
 */
export type CalendarConsent = "granted" | "required" | "not_applicable";

export function calendarConsentOf(
  row: Pick<
    typeof accounts.$inferSelect,
    "provider" | "authType" | "protocol" | "oauthScopes"
  >,
): CalendarConsent {
  if (row.protocol === "graph") {
    return row.oauthScopes && hasMicrosoftCalendarScope(row.oauthScopes)
      ? "granted"
      : "required";
  }
  if (row.provider === "gmail") {
    return row.authType === "oauth2" &&
      row.oauthScopes &&
      hasGoogleCalendarScope(row.oauthScopes)
      ? "granted"
      : "required";
  }
  return "not_applicable";
}

/** クライアントへ返す形にする。許可されたスコープそのものは返さない。 */
function publicAccount({ oauthScopes, ...row }: AccountColumns) {
  return {
    ...row,
    calendarConsent: calendarConsentOf({ ...row, oauthScopes }),
  };
}

type Tx = Parameters<Parameters<RouteDeps["db"]["transaction"]>[0]>[0];

/**
 * アカウントの取り込み済みのフォルダとメールを消す (受信の方式を変えたとき)。
 * まだ反映していない既読や移動などの操作も、古い方式のものなので捨てる (送信待ちのメールは残す)。
 * 消したものは変更履歴に載せ、端末からも消えるようにする。
 */
async function resetMailData(tx: Tx, userId: string, accountId: string) {
  // 予定の書き戻し (event_*) はメールのデータではないので残す。
  await tx
    .delete(outbox)
    .where(
      and(
        eq(outbox.accountId, accountId),
        ne(outbox.kind, "send"),
        notInArray(outbox.kind, [...EVENT_OUTBOX_KINDS]),
      ),
    );
  await tx.delete(popMessages).where(eq(popMessages.accountId, accountId));
  const removedMessages = await tx
    .delete(messages)
    .where(eq(messages.accountId, accountId))
    .returning({ id: messages.id });
  const removedMailboxes = await tx
    .delete(mailboxes)
    .where(eq(mailboxes.accountId, accountId))
    .returning({ id: mailboxes.id });
  const entries = [
    ...removedMessages.map((row) => ({
      entity: "message" as const,
      entityId: row.id,
    })),
    ...removedMailboxes.map((row) => ({
      entity: "mailbox" as const,
      entityId: row.id,
    })),
  ];
  for (let i = 0; i < entries.length; i += 1000) {
    await tx.insert(changes).values(
      entries.slice(i, i + 1000).map((entry) => ({
        userId,
        ...entry,
        op: "delete" as const,
      })),
    );
  }
}

/** テストで差し替えるもの。省けば実際のネットワークを使う。 */
export type AccountRouteOverrides = {
  discovery?: DiscoveryDeps;
  verifyImap?: typeof defaultVerifyImap;
  verifyPop3?: typeof defaultVerifyPop3;
  verifySmtp?: typeof defaultVerifySmtp;
  /** OAuth のトークンの引き換えとプロフィールの取得。 */
  fetchImpl?: typeof fetch;
};

export function accountRoutes(
  {
    db,
    encryptionKey,
    allowPrivateMailHosts,
    microsoft,
    google,
  }: Pick<
    RouteDeps,
    "db" | "encryptionKey" | "allowPrivateMailHosts" | "microsoft" | "google"
  >,
  overrides: AccountRouteOverrides = {},
) {
  const app = new Hono<AppEnv>();
  const verifyImap = overrides.verifyImap ?? defaultVerifyImap;
  const verifyPop3 = overrides.verifyPop3 ?? defaultVerifyPop3;
  const fetchImpl = overrides.fetchImpl ?? fetch;

  /** 受信のサーバー (IMAP または POP3) へ、実際にログインできるかを確かめる。 */
  function verifyIncoming(
    protocol: z.infer<typeof incomingProtocol>,
    settings: z.infer<typeof server> & {
      username: string;
      password: string;
      allowLegacyTls: boolean;
    },
  ) {
    return protocol === "pop3"
      ? verifyPop3({ ...settings, allowInsecure: allowPrivateMailHosts })
      : verifyImap(settings);
  }
  const verifySmtp = overrides.verifySmtp ?? defaultVerifySmtp;
  const discovery =
    overrides.discovery ?? defaultDiscoveryDeps(allowPrivateMailHosts);

  /** 内部ネットワークを指すホストを断る。問題なければ null。 */
  async function checkHost(host: string): Promise<ServerCheck | null> {
    if (allowPrivateMailHosts) return null;
    const isPrivate = await resolvesToPrivateAddress(host).catch(() => null);
    if (isPrivate === null) return { ok: false, reason: "host_not_found" };
    if (isPrivate) return { ok: false, reason: "host_not_allowed" };
    return null;
  }

  /** 受信 (IMAP / POP3) と送信 (SMTP) に、実際にログインできるかを同時に確かめる。 */
  async function checkServers(settings: {
    incomingProtocol: z.infer<typeof incomingProtocol>;
    imap: z.infer<typeof server>;
    /** 受信専用なら null (送信は確かめない)。 */
    smtp: z.infer<typeof server> | null;
    username: string;
    password: string;
    allowLegacyTls: boolean;
  }): Promise<{ imap: ServerCheck; smtp: ServerCheck }> {
    const [imap, smtp] = await Promise.all([
      (async (): Promise<ServerCheck> =>
        (await checkHost(settings.imap.host)) ??
        (await verifyIncoming(settings.incomingProtocol, {
          ...settings.imap,
          username: settings.username,
          password: settings.password,
          allowLegacyTls: settings.allowLegacyTls,
        })))(),
      (async (): Promise<ServerCheck> => {
        const smtp = settings.smtp;
        if (!smtp) return { ok: true };
        return (
          (await checkHost(smtp.host)) ??
          (await verifySmtp({
            ...smtp,
            username: settings.username,
            password: settings.password,
            allowLegacyTls: settings.allowLegacyTls,
            allowInsecure: allowPrivateMailHosts,
          }))
        );
      })(),
    ]);
    return { imap, smtp };
  }

  /**
   * メールアドレスのドメインから、IMAP / SMTP の設定を探す。
   * 見つからなければ settings は null (画面で手入力してもらう)。
   */
  app.post("/discover", zValidator("json", discoverBody), async (c) => {
    const { email } = c.req.valid("json");
    const settings = await discoverMailSettings(email, discovery);
    return c.json({ settings });
  });

  app.get("/", async (c) => {
    const rows = await db
      .select(accountColumns)
      .from(accounts)
      .where(eq(accounts.userId, c.var.user.id))
      // 並び替えたアカウントをその順に、まだ並び替えていないものは追加した順に後ろへ。
      .orderBy(asc(accounts.sortOrder), asc(accounts.createdAt));
    return c.json({ accounts: rows.map(publicAccount) });
  });

  /** サイドバーでのアカウントの並び順を保存する。ほかの端末にも同じ順で表示される。 */
  app.put("/order", zValidator("json", orderBody), async (c) => {
    const { accountIds } = c.req.valid("json");
    const user = c.var.user;
    const saved = await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(eq(accounts.userId, user.id), inArray(accounts.id, accountIds)),
        );
      if (owned.length !== accountIds.length) return false;
      for (const [index, id] of accountIds.entries()) {
        await tx
          .update(accounts)
          .set({ sortOrder: index })
          .where(eq(accounts.id, id));
      }
      await recordChanges(tx, user.id, "account", accountIds);
      return true;
    });
    if (!saved) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.body(null, 204);
  });

  app.post("/", zValidator("json", createAccountBody), async (c) => {
    const input = c.req.valid("json");
    const user = c.var.user;

    // Gmail と iCloud の決まった接続先は IMAP。POP3 で受け取るなら接続先を指定してもらう。
    const preset =
      input.incomingProtocol === "imap" &&
      (input.provider === "gmail" || input.provider === "icloud")
        ? MAIL_PROVIDER_PRESETS[input.provider]
        : null;
    const imap = input.imap ?? preset?.imap;
    // smtp に null を渡したら受信専用 (送信サーバーを使わない)。
    const smtp = input.smtp === null ? null : (input.smtp ?? preset?.smtp);
    if (!imap || smtp === undefined) {
      return c.json({ error: "server_required" }, 400);
    }
    // 手動で設定した場合も、接続先が Gmail や iCloud ならそのサービスとして扱う。
    // POP3 で受け取るアカウントは、どのサービスでも汎用のアカウントとして扱う
    // (フォルダや送信済みの控えを、すべてこのアプリの中で持つため)。
    const provider: typeof input.provider =
      input.incomingProtocol === "pop3"
        ? "generic"
        : input.provider === "generic"
          ? (providerOfImapHost(imap.host) ?? "generic")
          : input.provider;
    const body = {
      ...input,
      imap,
      smtp,
      username: input.username ?? input.email,
      provider,
      // 決まった接続先 (Gmail、iCloud) は新しい TLS に対応しているので、許可を受け付けない。
      allowLegacyTls: provider === "generic" && input.allowLegacyTls === true,
    };

    if (!allowPrivateMailHosts) {
      for (const host of [body.imap.host, ...(smtp ? [smtp.host] : [])]) {
        const isPrivate = await resolvesToPrivateAddress(host).catch(
          () => null,
        );
        if (isPrivate === null) {
          return c.json({ error: "host_not_found", host }, 422);
        }
        if (isPrivate) {
          return c.json({ error: "host_not_allowed", host }, 422);
        }
      }
    }

    // 同じアドレスでも、受信サーバーかユーザー名が違えば別のアカウントとして扱う
    // (ドコモメールの IMAP と、同じアドレスのメッセージR/S の POP3 など)。
    const [existing] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.email, body.email),
          sql`lower(${accounts.imapHost}) = ${body.imap.host.toLowerCase()}`,
          eq(accounts.username, body.username),
        ),
      );
    if (existing) {
      return c.json({ error: "account_exists" }, 409);
    }

    const verified = await verifyIncoming(body.incomingProtocol, {
      ...body.imap,
      username: body.username,
      password: body.password,
      allowLegacyTls: body.allowLegacyTls,
    });
    if (!verified.ok) {
      return c.json({ error: verified.reason, detail: verified.detail }, 422);
    }
    // 送信の設定の誤りも、追加する前に分かるようにする (受信専用なら確かめない)。
    const smtpVerified = smtp
      ? await verifySmtp({
          ...smtp,
          username: body.username,
          password: body.password,
          allowLegacyTls: body.allowLegacyTls,
          allowInsecure: allowPrivateMailHosts,
        })
      : ({ ok: true } as const);
    if (!smtpVerified.ok) {
      return c.json(
        {
          error:
            smtpVerified.reason === "legacy_tls_required"
              ? "legacy_tls_required"
              : `smtp_${smtpVerified.reason}`,
          detail: smtpVerified.detail,
        },
        422,
      );
    }

    const account = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({
          userId: user.id,
          email: body.email,
          displayName: body.displayName || null,
          provider: body.provider,
          authType: "password",
          protocol: body.incomingProtocol,
          ...(body.incomingProtocol === "pop3" && body.pop
            ? {
                popLeaveOnServer: body.pop.leaveOnServer,
                popDeleteAfterDays: body.pop.leaveOnServer
                  ? body.pop.deleteAfterDays
                  : null,
              }
            : {}),
          imapHost: body.imap.host,
          imapPort: body.imap.port,
          imapSecure: body.imap.secure,
          smtpHost: smtp?.host ?? null,
          smtpPort: smtp?.port ?? null,
          smtpSecure: smtp?.secure ?? false,
          allowLegacyTls: body.allowLegacyTls,
          username: body.username,
          credentialsEncrypted: encryptCredentials(
            { type: "password", password: body.password },
            encryptionKey,
            user.id,
          ),
        })
        .onConflictDoNothing()
        .returning(accountColumns);
      if (!row) return null;
      await tx.insert(changes).values({
        userId: user.id,
        entity: "account",
        entityId: row.id,
        op: "upsert",
      });
      // コミット時に同期ワーカーへ届き、すぐに同期が始まる。
      await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${row.id})`);
      return row;
    });
    if (!account) {
      return c.json({ error: "account_exists" }, 409);
    }
    return c.json({ account: publicAccount(account) }, 201);
  });

  // Microsoft アカウント (Exchange Online、Outlook.com) の追加。
  // 1. authorize でログイン画面の URL を受け取り、ブラウザをそこへ移動する。
  // 2. ログイン後に Web へ戻ってきた code と state を complete に渡す。
  // complete はログイン済みの利用者しか呼べず、state を始めた本人かも確かめるので、
  // 他人に踏ませたリンクで自分のアプリに他人のメールボックスを紐づけることはできない。
  app.post(
    "/microsoft/authorize",
    zValidator("json", microsoftAuthorizeBody),
    async (c) => {
      if (!microsoft) {
        return c.json({ error: "microsoft_not_configured" }, 503);
      }
      const { accountId, app: fromApp, email, calendar } = c.req.valid("json");
      const user = c.var.user;
      let loginHint: string | undefined = email;
      let withCalendar = calendar === true;
      if (accountId) {
        const [row] = await db
          .select({
            email: accounts.email,
            calendarEnabled: accounts.calendarEnabled,
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, accountId),
              eq(accounts.userId, user.id),
              eq(accounts.protocol, "graph"),
            ),
          );
        if (!row) {
          return c.json({ error: "not_found" }, 404);
        }
        loginHint = row.email;
        withCalendar = calendar ?? row.calendarEnabled;
      }
      const url = createMicrosoftAuthorizeUrl({
        config: microsoft.config,
        redirectUri: microsoft.redirectUri,
        userId: user.id,
        encryptionKey,
        loginHint,
        calendar: withCalendar,
      });
      return c.json({ url: markAppState(url, fromApp) });
    },
  );

  app.post(
    "/microsoft/complete",
    zValidator("json", microsoftCompleteBody),
    async (c) => {
      if (!microsoft) {
        return c.json({ error: "microsoft_not_configured" }, 503);
      }
      const body = c.req.valid("json");
      const user = c.var.user;
      const opened = openMicrosoftState({
        state: unmarkAppState(body.state),
        userId: user.id,
        encryptionKey,
      });
      if (!opened) {
        return c.json({ error: "invalid_state" }, 400);
      }

      let refreshToken: string;
      let scope: string;
      let profile: Awaited<ReturnType<typeof fetchMicrosoftProfile>>;
      try {
        const tokens = await exchangeMicrosoftCode(
          microsoft.config,
          {
            code: body.code,
            verifier: opened.verifier,
            redirectUri: microsoft.redirectUri,
          },
          fetchImpl,
        );
        if (!tokens.refreshToken) {
          return c.json({ error: "no_refresh_token" }, 422);
        }
        refreshToken = tokens.refreshToken;
        scope = tokens.scope;
        profile = await fetchMicrosoftProfile(tokens.accessToken, fetchImpl);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "";
        // 接続に失敗した場合は、cause に DNS、タイムアウト、TLS などの理由が入っている。
        console.error("Microsoft のログインを完了できませんでした。", error);
        return c.json(
          {
            error:
              error instanceof MicrosoftOAuthError
                ? "oauth_failed"
                : "connection_failed",
            detail,
          },
          422,
        );
      }

      const credentialsEncrypted = encryptCredentials(
        { type: "oauth2", refreshToken },
        encryptionKey,
        user.id,
      );
      // 同意画面でカレンダーの権限を外されたら、メールだけで追加する (calendarGranted: false)。
      const calendarGranted = hasMicrosoftCalendarScope(scope);
      const oauth = {
        credentialsEncrypted,
        oauthScopes: scope || null,
        ...(opened.calendar && calendarGranted
          ? { calendarEnabled: true }
          : {}),
      };
      const result = await db.transaction(async (tx) => {
        const sameAddress = await tx
          .select({ id: accounts.id, protocol: accounts.protocol })
          .from(accounts)
          .where(
            and(
              eq(accounts.userId, user.id),
              // Microsoft のアドレスは大文字と小文字を区別しない。
              sql`lower(${accounts.email}) = ${profile.email.toLowerCase()}`,
            ),
          );
        // 同じアドレスのアカウントが複数あれば、Microsoft Graph のものを選ぶ。
        const existing =
          sameAddress.find((row) => row.protocol === "graph") ?? sameAddress[0];
        // 同じアドレスを IMAP で追加済みなら、二重に取り込まないよう断る。
        if (existing && existing.protocol !== "graph") return null;

        // 追加済みの Microsoft アカウントなら再ログイン。認証情報を入れ替えて同期を再開する。
        const [row] = existing
          ? await tx
              .update(accounts)
              .set({
                ...oauth,
                status: "active",
                lastError: null,
                calendarError: null,
              })
              .where(eq(accounts.id, existing.id))
              .returning(accountColumns)
          : await tx
              .insert(accounts)
              .values({
                ...oauth,
                userId: user.id,
                email: profile.email,
                displayName: body.displayName || profile.displayName,
                provider: "microsoft",
                authType: "oauth2",
                protocol: "graph",
                username: profile.email,
              })
              .onConflictDoNothing()
              .returning(accountColumns);
        if (!row) return null;
        await tx.insert(changes).values({
          userId: user.id,
          entity: "account",
          entityId: row.id,
          op: "upsert",
        });
        await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${row.id})`);
        return { account: row, created: !existing };
      });
      if (!result) {
        return c.json({ error: "account_exists" }, 409);
      }
      return c.json(
        {
          account: publicAccount(result.account),
          calendarGranted,
        },
        result.created ? 201 : 200,
      );
    },
  );

  // Gmail アカウントの追加 (Google でログイン)。流れは Microsoft と同じ。
  // 受け取ったトークンで、IMAP / SMTP に XOAUTH2 でログインする。
  app.post(
    "/google/authorize",
    zValidator("json", oauthAuthorizeBody),
    async (c) => {
      if (!google) {
        return c.json({ error: "google_not_configured" }, 503);
      }
      const { accountId, app: fromApp, email, calendar } = c.req.valid("json");
      const user = c.var.user;
      let loginHint: string | undefined = email;
      let withCalendar = calendar === true;
      if (accountId) {
        const [row] = await db
          .select({
            email: accounts.email,
            calendarEnabled: accounts.calendarEnabled,
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, accountId),
              eq(accounts.userId, user.id),
              eq(accounts.provider, "gmail"),
            ),
          );
        if (!row) {
          return c.json({ error: "not_found" }, 404);
        }
        loginHint = row.email;
        // Google は求めた権限だけのトークンを返すので、使っている権限も求め直す。
        withCalendar = calendar ?? row.calendarEnabled;
      }
      const url = createGoogleAuthorizeUrl({
        config: google.config,
        redirectUri: google.redirectUri,
        userId: user.id,
        encryptionKey,
        loginHint,
        calendar: withCalendar,
      });
      return c.json({ url: markAppState(url, fromApp) });
    },
  );

  app.post(
    "/google/complete",
    zValidator("json", microsoftCompleteBody),
    async (c) => {
      if (!google) {
        return c.json({ error: "google_not_configured" }, 503);
      }
      const body = c.req.valid("json");
      const user = c.var.user;
      const opened = openGoogleState({
        state: unmarkAppState(body.state),
        userId: user.id,
        encryptionKey,
      });
      if (!opened) {
        return c.json({ error: "invalid_state" }, 400);
      }

      const preset = MAIL_PROVIDER_PRESETS.gmail;
      let refreshToken: string;
      let scope: string;
      let email: string;
      try {
        const tokens = await exchangeGoogleCode(
          google.config,
          {
            code: body.code,
            verifier: opened.verifier,
            redirectUri: google.redirectUri,
          },
          fetchImpl,
        );
        // 同意画面では権限を個別に外せる。メールの権限が無ければ同期できない。
        if (!hasGmailScope(tokens.scope)) {
          return c.json({ error: "scope_missing" }, 422);
        }
        if (!tokens.refreshToken) {
          return c.json({ error: "no_refresh_token" }, 422);
        }
        refreshToken = tokens.refreshToken;
        scope = tokens.scope;
        email = await fetchGoogleEmail(tokens.accessToken, fetchImpl);
        // Google Workspace では管理者が IMAP を止めていることがある。保存する前に確かめる。
        const verified = await verifyImap({
          ...preset.imap,
          username: email,
          accessToken: tokens.accessToken,
        });
        if (!verified.ok) {
          return c.json(
            {
              error:
                verified.reason === "auth_failed"
                  ? "imap_unavailable"
                  : "connection_failed",
              detail: verified.detail,
            },
            422,
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "";
        console.error("Google のログインを完了できませんでした。", error);
        return c.json(
          {
            error:
              error instanceof GoogleOAuthError
                ? "oauth_failed"
                : "connection_failed",
            detail,
          },
          422,
        );
      }

      const settings = {
        authType: "oauth2" as const,
        imapHost: preset.imap.host,
        imapPort: preset.imap.port,
        imapSecure: preset.imap.secure,
        smtpHost: preset.smtp.host,
        smtpPort: preset.smtp.port,
        smtpSecure: preset.smtp.secure,
        username: email,
        credentialsEncrypted: encryptCredentials(
          { type: "oauth2", refreshToken },
          encryptionKey,
          user.id,
        ),
        oauthScopes: scope || null,
      };
      // 同意画面でカレンダーの権限だけ外された場合は、メールだけで追加する (calendarGranted: false)。
      const calendarGranted = hasGoogleCalendarScope(scope);
      const calendarSettings =
        opened.calendar && calendarGranted ? { calendarEnabled: true } : {};
      const result = await db.transaction(async (tx) => {
        const sameAddress = await tx
          .select({ id: accounts.id, provider: accounts.provider })
          .from(accounts)
          .where(
            and(
              eq(accounts.userId, user.id),
              sql`lower(${accounts.email}) = ${email.toLowerCase()}`,
            ),
          );
        // 同じアドレスのアカウントが複数あれば、Gmail のものを選ぶ。
        const existing =
          sameAddress.find((row) => row.provider === "gmail") ?? sameAddress[0];
        // 同じアドレスを Gmail 以外の設定で追加済みなら、二重に取り込まないよう断る。
        if (existing && existing.provider !== "gmail") return null;

        // 追加済みの Gmail アカウントなら再ログイン (アプリ パスワードからの切り替えも含む)。
        // 認証情報を入れ替えて同期を再開する。
        const [row] = existing
          ? await tx
              .update(accounts)
              .set({
                ...settings,
                ...calendarSettings,
                status: "active",
                lastError: null,
                calendarError: null,
              })
              .where(eq(accounts.id, existing.id))
              .returning(accountColumns)
          : await tx
              .insert(accounts)
              .values({
                ...settings,
                ...calendarSettings,
                userId: user.id,
                email,
                displayName: body.displayName || null,
                provider: "gmail",
              })
              .onConflictDoNothing()
              .returning(accountColumns);
        if (!row) return null;
        await tx.insert(changes).values({
          userId: user.id,
          entity: "account",
          entityId: row.id,
          op: "upsert",
        });
        await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${row.id})`);
        return { account: row, created: !existing };
      });
      if (!result) {
        return c.json({ error: "account_exists" }, 409);
      }
      return c.json(
        {
          account: publicAccount(result.account),
          calendarGranted,
        },
        result.created ? 201 : 200,
      );
    },
  );

  /**
   * アカウントの設定 (署名、表示名、色など) を変える。指定した項目だけを変える。
   * メールとカレンダーの切り替え (mailEnabled / calendarEnabled) は、同期ワーカーに知らせる。
   */
  app.patch(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", updateAccountBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.var.user;
      const account = await db.transaction(async (tx) => {
        // メールとカレンダーの切り替え。いまの値と、カレンダーの権限を確かめる。
        let flagsChanged = false;
        if (
          body.mailEnabled !== undefined ||
          body.calendarEnabled !== undefined
        ) {
          const [current] = await tx
            .select({
              provider: accounts.provider,
              authType: accounts.authType,
              protocol: accounts.protocol,
              oauthScopes: accounts.oauthScopes,
              imapHost: accounts.imapHost,
              mailEnabled: accounts.mailEnabled,
              calendarEnabled: accounts.calendarEnabled,
            })
            .from(accounts)
            .where(and(eq(accounts.id, id), eq(accounts.userId, user.id)))
            .for("update");
          if (!current) return null;
          if (
            body.calendarEnabled === true &&
            calendarConsentOf(current) === "required"
          ) {
            return "consent_required" as const;
          }
          // メールの接続先が無いアカウント (CalDAV だけで追加したもの) は、メールを使えない。
          if (
            body.mailEnabled === true &&
            current.protocol !== "graph" &&
            current.imapHost === null
          ) {
            return "mail_unavailable" as const;
          }
          flagsChanged =
            (body.mailEnabled !== undefined &&
              body.mailEnabled !== current.mailEnabled) ||
            (body.calendarEnabled !== undefined &&
              body.calendarEnabled !== current.calendarEnabled);
        }
        const [row] = await tx
          .update(accounts)
          .set({
            ...(body.mailEnabled !== undefined
              ? { mailEnabled: body.mailEnabled }
              : {}),
            ...(body.calendarEnabled !== undefined
              ? {
                  calendarEnabled: body.calendarEnabled,
                  // 止めたら、カレンダーの同期の失敗の表示も消す。
                  ...(body.calendarEnabled ? {} : { calendarError: null }),
                }
              : {}),
            ...(body.signatureHtml !== undefined
              ? { signatureHtml: body.signatureHtml?.trim() || null }
              : {}),
            ...(body.displayName !== undefined
              ? { displayName: body.displayName?.trim() || null }
              : {}),
            ...(body.color !== undefined ? { color: body.color } : {}),
            ...(body.icon !== undefined ? { icon: body.icon } : {}),
            ...(body.allowLegacyTls !== undefined
              ? { allowLegacyTls: body.allowLegacyTls }
              : {}),
            ...(body.pushConnections !== undefined
              ? { pushConnections: body.pushConnections }
              : {}),
            ...(body.notifyNewMail !== undefined
              ? { notifyNewMail: body.notifyNewMail }
              : {}),
            ...(body.popLeaveOnServer !== undefined
              ? { popLeaveOnServer: body.popLeaveOnServer }
              : {}),
            ...(body.composeFormat !== undefined
              ? { composeFormat: body.composeFormat }
              : {}),
            ...(body.popDeleteAfterDays !== undefined
              ? { popDeleteAfterDays: body.popDeleteAfterDays }
              : {}),
          })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.userId, user.id),
              // TLS の設定は IMAP / POP3 でつなぐアカウントに、接続の本数の設定は
              // IMAP のアカウントに、サーバーに残す設定は POP3 のアカウントにしか無い。
              body.pushConnections !== undefined
                ? eq(accounts.protocol, "imap")
                : undefined,
              body.allowLegacyTls !== undefined
                ? ne(accounts.protocol, "graph")
                : undefined,
              body.popLeaveOnServer !== undefined ||
                body.popDeleteAfterDays !== undefined
                ? eq(accounts.protocol, "pop3")
                : undefined,
            ),
          )
          .returning(accountColumns);
        if (!row) return null;
        if (
          flagsChanged ||
          body.allowLegacyTls !== undefined ||
          body.pushConnections !== undefined ||
          body.popLeaveOnServer !== undefined ||
          body.popDeleteAfterDays !== undefined
        ) {
          // 同期ワーカーが、新しい設定でつなぎ直す (メールとカレンダーの同期の起動と停止も)。
          await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${id})`);
        }
        // ほかの端末にも、新しい設定が届くようにする。
        const [change] = await tx
          .insert(changes)
          .values({
            userId: user.id,
            entity: "account",
            entityId: id,
            op: "upsert",
          })
          .returning({ seq: changes.seq });
        if (change) {
          const payload: ChangeNotification = {
            userId: user.id,
            seq: change.seq.toString(),
          };
          await tx.execute(
            sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
          );
        }
        return row;
      });
      if (!account) {
        return c.json({ error: "not_found" }, 404);
      }
      if (account === "consent_required" || account === "mail_unavailable") {
        return c.json({ error: account }, 409);
      }
      return c.json({ account: publicAccount(account) });
    },
  );

  /** 変更後の接続先の設定を組み立てる。パスワードを省いたら保存済みのものを使う。 */
  async function serverSettingsOf(
    userId: string,
    id: string,
    body: z.infer<typeof serverSettingsBody>,
  ) {
    const [account] = await db
      .select({
        protocol: accounts.protocol,
        authType: accounts.authType,
        provider: accounts.provider,
        allowLegacyTls: accounts.allowLegacyTls,
        credentialsEncrypted: accounts.credentialsEncrypted,
      })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
    if (!account) return { error: "not_found" as const };
    // Microsoft Graph でつなぐアカウントは IMAP / SMTP を使わない (ログインし直しだけ)。
    if (account.protocol === "graph") {
      return { error: "not_editable" as const };
    }
    // Google でログインした Gmail は、アプリ パスワードを入れればパスワードでの接続に切り替えられる。
    if (account.authType !== "password" && body.password === undefined) {
      return { error: "password_required" as const };
    }
    let password = body.password;
    if (password === undefined) {
      const credentials = decryptCredentials(
        account.credentialsEncrypted,
        encryptionKey,
        userId,
      );
      if (credentials.type !== "password") {
        return { error: "not_editable" as const };
      }
      password = credentials.password;
    }
    const protocol = body.incomingProtocol ?? account.protocol;
    // POP3 で受け取るアカウントは、どのサービスでも汎用のアカウントとして扱う。
    const provider: typeof account.provider =
      protocol === "pop3"
        ? "generic"
        : account.provider === "generic" ||
            account.provider === "icloud" ||
            account.protocol === "pop3"
          ? (providerOfImapHost(body.imap.host) ?? "generic")
          : account.provider;
    return {
      settings: {
        incomingProtocol: protocol,
        protocolChanged: protocol !== account.protocol,
        pop: body.pop ?? null,
        imap: body.imap,
        smtp: body.smtp,
        username: body.username,
        password,
        provider,
        allowLegacyTls:
          provider === "generic" &&
          (body.allowLegacyTls ?? account.allowLegacyTls),
      },
    };
  }

  /** 接続先の変更を保存せずに、受信と送信へログインできるかだけを確かめる。 */
  app.post(
    "/:id/server/test",
    zValidator("param", idParam),
    zValidator("json", serverSettingsBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const prepared = await serverSettingsOf(
        c.var.user.id,
        id,
        c.req.valid("json"),
      );
      if ("error" in prepared) {
        return c.json(
          { error: prepared.error },
          prepared.error === "not_found" ? 404 : 400,
        );
      }
      const checks = await checkServers(prepared.settings);
      return c.json({ ok: checks.imap.ok && checks.smtp.ok, ...checks });
    },
  );

  /**
   * 追加済みアカウントの接続先 (ホスト、ポート、TLS、ユーザー名、パスワード) を変える。
   * 受信と送信の両方へログインできたときだけ保存し、同期をつなぎ直す。
   */
  app.put(
    "/:id/server",
    zValidator("param", idParam),
    zValidator("json", serverSettingsBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = c.var.user;
      const prepared = await serverSettingsOf(user.id, id, c.req.valid("json"));
      if ("error" in prepared) {
        return c.json(
          { error: prepared.error },
          prepared.error === "not_found" ? 404 : 400,
        );
      }
      const { settings } = prepared;
      const checks = await checkServers(settings);
      if (!checks.imap.ok || !checks.smtp.ok) {
        return c.json(
          { error: "verification_failed", ok: false, ...checks },
          422,
        );
      }
      const account = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(accounts)
          .set({
            protocol: settings.incomingProtocol,
            ...(settings.incomingProtocol === "pop3" && settings.pop
              ? {
                  popLeaveOnServer: settings.pop.leaveOnServer,
                  popDeleteAfterDays: settings.pop.leaveOnServer
                    ? settings.pop.deleteAfterDays
                    : null,
                }
              : {}),
            imapHost: settings.imap.host,
            imapPort: settings.imap.port,
            imapSecure: settings.imap.secure,
            smtpHost: settings.smtp?.host ?? null,
            smtpPort: settings.smtp?.port ?? null,
            smtpSecure: settings.smtp?.secure ?? false,
            username: settings.username,
            provider: settings.provider,
            authType: "password",
            allowLegacyTls: settings.allowLegacyTls,
            credentialsEncrypted: encryptCredentials(
              { type: "password", password: settings.password },
              encryptionKey,
              user.id,
            ),
            // 直したので、止まっていた同期を再開する。
            status: "active",
            lastError: null,
          })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.userId, user.id),
              ne(accounts.protocol, "graph"),
            ),
          )
          .returning(accountColumns);
        if (!row) return null;
        if (settings.protocolChanged) {
          // 受信の方式を変えた。フォルダもメールの ID も方式ごとに違うので、
          // 取り込み済みのものを消して、新しい方式で取り込み直す。
          await resetMailData(tx, user.id, id);
        }
        await recordChanges(tx, user.id, "account", [id]);
        // 同期ワーカーが、新しい接続先でつなぎ直す。
        await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${id})`);
        return row;
      });
      if (!account) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ account: publicAccount(account) });
    },
  );

  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(accounts)
        .where(and(eq(accounts.id, id), eq(accounts.userId, user.id)))
        .returning({ id: accounts.id });
      if (!row) return false;
      await tx.insert(changes).values({
        userId: user.id,
        entity: "account",
        entityId: id,
        op: "delete",
      });
      await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${id})`);
      return true;
    });
    if (!deleted) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.body(null, 204);
  });

  /** 次の定期確認を待たずに、いますぐ全フォルダを確認させる。 */
  app.post("/:id/sync", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.userId, c.var.user.id)));
    if (!account) {
      return c.json({ error: "not_found" }, 404);
    }
    // 操作を積んだときと同じ知らせ。同期ワーカーはキューを処理したあと、全フォルダを確認する。
    await db.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${id})`);
    return c.body(null, 204);
  });

  app.get("/:id/mailboxes", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const rows = await db
      .select({
        id: mailboxes.id,
        parentId: mailboxes.parentId,
        path: mailboxes.path,
        name: mailboxes.name,
        specialUse: mailboxes.specialUse,
        detectedSpecialUse: mailboxes.detectedSpecialUse,
        roleOverride: mailboxes.roleOverride,
        displayName: mailboxes.displayName,
        icon: mailboxes.icon,
        color: mailboxes.color,
        sortOrder: mailboxes.sortOrder,
        lastSyncedAt: mailboxes.lastSyncedAt,
      })
      .from(mailboxes)
      .innerJoin(accounts, eq(mailboxes.accountId, accounts.id))
      .where(and(eq(accounts.id, id), eq(accounts.userId, c.var.user.id)))
      .orderBy(asc(mailboxes.path));
    return c.json({ mailboxes: rows });
  });

  return app;
}
