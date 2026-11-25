import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_ACCOUNTS,
  CHANNEL_CHANGES,
  CHANNEL_OUTBOX,
  type ChangeNotification,
  createGoogleAuthorizeUrl,
  createMicrosoftAuthorizeUrl,
  decryptCredentials,
  encryptCredentials,
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  fetchGoogleEmail,
  fetchMicrosoftProfile,
  GoogleOAuthError,
  hasGmailScope,
  MAIL_PROVIDER_PRESETS,
  MicrosoftOAuthError,
  openGoogleState,
  openMicrosoftState,
  providerOfImapHost,
} from "@orbit/core";
import { changes, mailAccounts, mailboxes } from "@orbit/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import { resolvesToPrivateAddress } from "../lib/host-check.js";
import { verifyImap as defaultVerifyImap } from "../lib/imap-verify.js";
import { verifySmtp as defaultVerifySmtp } from "../lib/smtp-verify.js";

const server = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
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
   */
  imap: server.optional(),
  smtp: server.optional(),
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

/** 追加済みアカウントの接続先を変える。password を省くと、保存済みのパスワードを使う。 */
const serverSettingsBody = z.object({
  imap: server,
  smtp: server,
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
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined));

const orderBody = z.object({
  /** 上から順に並べたいアカウントの ID。 */
  accountIds: z.array(z.uuid()).min(1).max(200).refine(isDistinct),
});

/** クライアントへ返す形。認証情報は暗号文であっても返さない。 */
const publicColumns = {
  id: mailAccounts.id,
  email: mailAccounts.email,
  displayName: mailAccounts.displayName,
  provider: mailAccounts.provider,
  authType: mailAccounts.authType,
  protocol: mailAccounts.protocol,
  imapHost: mailAccounts.imapHost,
  imapPort: mailAccounts.imapPort,
  imapSecure: mailAccounts.imapSecure,
  smtpHost: mailAccounts.smtpHost,
  smtpPort: mailAccounts.smtpPort,
  smtpSecure: mailAccounts.smtpSecure,
  allowLegacyTls: mailAccounts.allowLegacyTls,
  pushConnections: mailAccounts.pushConnections,
  notifyNewMail: mailAccounts.notifyNewMail,
  username: mailAccounts.username,
  status: mailAccounts.status,
  lastError: mailAccounts.lastError,
  signatureHtml: mailAccounts.signatureHtml,
  sortOrder: mailAccounts.sortOrder,
  color: mailAccounts.color,
  icon: mailAccounts.icon,
  createdAt: mailAccounts.createdAt,
};

/** テストで差し替えるもの。省けば実際のネットワークを使う。 */
export type AccountRouteOverrides = {
  discovery?: DiscoveryDeps;
  verifyImap?: typeof defaultVerifyImap;
  verifySmtp?: typeof defaultVerifySmtp;
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

  /** 受信 (IMAP) と送信 (SMTP) に、実際にログインできるかを同時に確かめる。 */
  async function checkServers(settings: {
    imap: z.infer<typeof server>;
    smtp: z.infer<typeof server>;
    username: string;
    password: string;
    allowLegacyTls: boolean;
  }): Promise<{ imap: ServerCheck; smtp: ServerCheck }> {
    const [imap, smtp] = await Promise.all([
      (async (): Promise<ServerCheck> =>
        (await checkHost(settings.imap.host)) ??
        (await verifyImap({
          ...settings.imap,
          username: settings.username,
          password: settings.password,
          allowLegacyTls: settings.allowLegacyTls,
        })))(),
      (async (): Promise<ServerCheck> =>
        (await checkHost(settings.smtp.host)) ??
        (await verifySmtp({
          ...settings.smtp,
          username: settings.username,
          password: settings.password,
          allowLegacyTls: settings.allowLegacyTls,
          allowInsecure: allowPrivateMailHosts,
        })))(),
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
      .select(publicColumns)
      .from(mailAccounts)
      .where(eq(mailAccounts.userId, c.var.user.id))
      // 並び替えたアカウントをその順に、まだ並び替えていないものは追加した順に後ろへ。
      .orderBy(asc(mailAccounts.sortOrder), asc(mailAccounts.createdAt));
    return c.json({ accounts: rows });
  });

  /** サイドバーでのアカウントの並び順を保存する。ほかの端末にも同じ順で表示される。 */
  app.put("/order", zValidator("json", orderBody), async (c) => {
    const { accountIds } = c.req.valid("json");
    const user = c.var.user;
    const saved = await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: mailAccounts.id })
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.userId, user.id),
            inArray(mailAccounts.id, accountIds),
          ),
        );
      if (owned.length !== accountIds.length) return false;
      for (const [index, id] of accountIds.entries()) {
        await tx
          .update(mailAccounts)
          .set({ sortOrder: index })
          .where(eq(mailAccounts.id, id));
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

    const preset =
      input.provider === "gmail" || input.provider === "icloud"
        ? MAIL_PROVIDER_PRESETS[input.provider]
        : null;
    const imap = input.imap ?? preset?.imap;
    const smtp = input.smtp ?? preset?.smtp;
    if (!imap || !smtp) {
      return c.json({ error: "server_required" }, 400);
    }
    // 手動で設定した場合も、接続先が Gmail や iCloud ならそのサービスとして扱う。
    const provider: typeof input.provider =
      input.provider === "generic"
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
      for (const host of [body.imap.host, body.smtp.host]) {
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

    const [existing] = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.userId, user.id),
          eq(mailAccounts.email, body.email),
        ),
      );
    if (existing) {
      return c.json({ error: "account_exists" }, 409);
    }

    const verified = await verifyImap({
      ...body.imap,
      username: body.username,
      password: body.password,
      allowLegacyTls: body.allowLegacyTls,
    });
    if (!verified.ok) {
      return c.json({ error: verified.reason, detail: verified.detail }, 422);
    }
    // 送信の設定の誤りも、追加する前に分かるようにする。
    const smtpVerified = await verifySmtp({
      ...body.smtp,
      username: body.username,
      password: body.password,
      allowLegacyTls: body.allowLegacyTls,
      allowInsecure: allowPrivateMailHosts,
    });
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
        .insert(mailAccounts)
        .values({
          userId: user.id,
          email: body.email,
          displayName: body.displayName || null,
          provider: body.provider,
          authType: "password",
          imapHost: body.imap.host,
          imapPort: body.imap.port,
          imapSecure: body.imap.secure,
          smtpHost: body.smtp.host,
          smtpPort: body.smtp.port,
          smtpSecure: body.smtp.secure,
          allowLegacyTls: body.allowLegacyTls,
          username: body.username,
          credentialsEncrypted: encryptCredentials(
            { type: "password", password: body.password },
            encryptionKey,
            user.id,
          ),
        })
        .onConflictDoNothing()
        .returning(publicColumns);
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
    return c.json({ account }, 201);
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
      const { accountId, app: fromApp, email } = c.req.valid("json");
      const user = c.var.user;
      let loginHint: string | undefined = email;
      if (accountId) {
        const [row] = await db
          .select({ email: mailAccounts.email })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.id, accountId),
              eq(mailAccounts.userId, user.id),
              eq(mailAccounts.protocol, "graph"),
            ),
          );
        if (!row) {
          return c.json({ error: "not_found" }, 404);
        }
        loginHint = row.email;
      }
      const url = createMicrosoftAuthorizeUrl({
        config: microsoft.config,
        redirectUri: microsoft.redirectUri,
        userId: user.id,
        encryptionKey,
        loginHint,
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
      let profile: Awaited<ReturnType<typeof fetchMicrosoftProfile>>;
      try {
        const tokens = await exchangeMicrosoftCode(microsoft.config, {
          code: body.code,
          verifier: opened.verifier,
          redirectUri: microsoft.redirectUri,
        });
        if (!tokens.refreshToken) {
          return c.json({ error: "no_refresh_token" }, 422);
        }
        refreshToken = tokens.refreshToken;
        profile = await fetchMicrosoftProfile(tokens.accessToken);
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
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: mailAccounts.id, protocol: mailAccounts.protocol })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.userId, user.id),
              // Microsoft のアドレスは大文字と小文字を区別しない。
              sql`lower(${mailAccounts.email}) = ${profile.email.toLowerCase()}`,
            ),
          );
        // 同じアドレスを IMAP で追加済みなら、二重に取り込まないよう断る。
        if (existing && existing.protocol !== "graph") return null;

        // 追加済みの Microsoft アカウントなら再ログイン。認証情報を入れ替えて同期を再開する。
        const [row] = existing
          ? await tx
              .update(mailAccounts)
              .set({ credentialsEncrypted, status: "active", lastError: null })
              .where(eq(mailAccounts.id, existing.id))
              .returning(publicColumns)
          : await tx
              .insert(mailAccounts)
              .values({
                userId: user.id,
                email: profile.email,
                displayName: body.displayName || profile.displayName,
                provider: "microsoft",
                authType: "oauth2",
                protocol: "graph",
                username: profile.email,
                credentialsEncrypted,
              })
              .onConflictDoNothing()
              .returning(publicColumns);
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
      return c.json({ account: result.account }, result.created ? 201 : 200);
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
      const { accountId, app: fromApp, email } = c.req.valid("json");
      const user = c.var.user;
      let loginHint: string | undefined = email;
      if (accountId) {
        const [row] = await db
          .select({ email: mailAccounts.email })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.id, accountId),
              eq(mailAccounts.userId, user.id),
              eq(mailAccounts.provider, "gmail"),
            ),
          );
        if (!row) {
          return c.json({ error: "not_found" }, 404);
        }
        loginHint = row.email;
      }
      const url = createGoogleAuthorizeUrl({
        config: google.config,
        redirectUri: google.redirectUri,
        userId: user.id,
        encryptionKey,
        loginHint,
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
      let email: string;
      try {
        const tokens = await exchangeGoogleCode(google.config, {
          code: body.code,
          verifier: opened.verifier,
          redirectUri: google.redirectUri,
        });
        // 同意画面では権限を個別に外せる。メールの権限が無ければ同期できない。
        if (!hasGmailScope(tokens.scope)) {
          return c.json({ error: "scope_missing" }, 422);
        }
        if (!tokens.refreshToken) {
          return c.json({ error: "no_refresh_token" }, 422);
        }
        refreshToken = tokens.refreshToken;
        email = await fetchGoogleEmail(tokens.accessToken);
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
      };
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: mailAccounts.id, provider: mailAccounts.provider })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.userId, user.id),
              sql`lower(${mailAccounts.email}) = ${email.toLowerCase()}`,
            ),
          );
        // 同じアドレスを Gmail 以外の設定で追加済みなら、二重に取り込まないよう断る。
        if (existing && existing.provider !== "gmail") return null;

        // 追加済みの Gmail アカウントなら再ログイン (アプリ パスワードからの切り替えも含む)。
        // 認証情報を入れ替えて同期を再開する。
        const [row] = existing
          ? await tx
              .update(mailAccounts)
              .set({ ...settings, status: "active", lastError: null })
              .where(eq(mailAccounts.id, existing.id))
              .returning(publicColumns)
          : await tx
              .insert(mailAccounts)
              .values({
                ...settings,
                userId: user.id,
                email,
                displayName: body.displayName || null,
                provider: "gmail",
              })
              .onConflictDoNothing()
              .returning(publicColumns);
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
      return c.json({ account: result.account }, result.created ? 201 : 200);
    },
  );

  /** アカウントの設定 (署名、表示名、色) を変える。指定した項目だけを変え、同期には影響しない。 */
  app.patch(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", updateAccountBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.var.user;
      const account = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(mailAccounts)
          .set({
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
          })
          .where(
            and(
              eq(mailAccounts.id, id),
              eq(mailAccounts.userId, user.id),
              // TLS と接続の本数の設定は、IMAP / SMTP でつなぐアカウントにしか無い。
              body.allowLegacyTls !== undefined ||
                body.pushConnections !== undefined
                ? eq(mailAccounts.protocol, "imap")
                : undefined,
            ),
          )
          .returning(publicColumns);
        if (!row) return null;
        if (
          body.allowLegacyTls !== undefined ||
          body.pushConnections !== undefined
        ) {
          // 同期ワーカーが、新しい設定でつなぎ直す。
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
      return c.json({ account });
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
        protocol: mailAccounts.protocol,
        authType: mailAccounts.authType,
        provider: mailAccounts.provider,
        allowLegacyTls: mailAccounts.allowLegacyTls,
        credentialsEncrypted: mailAccounts.credentialsEncrypted,
      })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId)));
    if (!account) return { error: "not_found" as const };
    // Microsoft Graph でつなぐアカウントは IMAP / SMTP を使わない (ログインし直しだけ)。
    if (account.protocol !== "imap") {
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
    const provider: typeof account.provider =
      account.provider === "generic" || account.provider === "icloud"
        ? (providerOfImapHost(body.imap.host) ?? "generic")
        : account.provider;
    return {
      settings: {
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
          .update(mailAccounts)
          .set({
            imapHost: settings.imap.host,
            imapPort: settings.imap.port,
            imapSecure: settings.imap.secure,
            smtpHost: settings.smtp.host,
            smtpPort: settings.smtp.port,
            smtpSecure: settings.smtp.secure,
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
              eq(mailAccounts.id, id),
              eq(mailAccounts.userId, user.id),
              eq(mailAccounts.protocol, "imap"),
            ),
          )
          .returning(publicColumns);
        if (!row) return null;
        await recordChanges(tx, user.id, "account", [id]);
        // 同期ワーカーが、新しい接続先でつなぎ直す。
        await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${id})`);
        return row;
      });
      if (!account) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ account });
    },
  );

  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(mailAccounts)
        .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, user.id)))
        .returning({ id: mailAccounts.id });
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
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(
        and(eq(mailAccounts.id, id), eq(mailAccounts.userId, c.var.user.id)),
      );
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
      .innerJoin(mailAccounts, eq(mailboxes.accountId, mailAccounts.id))
      .where(
        and(eq(mailAccounts.id, id), eq(mailAccounts.userId, c.var.user.id)),
      )
      .orderBy(asc(mailboxes.path));
    return c.json({ mailboxes: rows });
  });

  return app;
}
