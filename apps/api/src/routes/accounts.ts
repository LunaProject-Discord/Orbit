import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_ACCOUNTS,
  CHANNEL_CHANGES,
  CHANNEL_OUTBOX,
  type ChangeNotification,
  createGoogleAuthorizeUrl,
  createMicrosoftAuthorizeUrl,
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
} from "@mail/core";
import { changes, mailAccounts, mailboxes } from "@mail/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { isDistinct, recordChanges } from "../lib/changes.js";
import { resolvesToPrivateAddress } from "../lib/host-check.js";
import { verifyImap } from "../lib/imap-verify.js";

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
});

const microsoftAuthorizeBody = z.object({
  /** 再ログインするアカウントの ID。ログイン画面にそのメールアドレスを入れておく。 */
  accountId: z.uuid().optional(),
});

const oauthAuthorizeBody = microsoftAuthorizeBody;

const microsoftCompleteBody = z.object({
  code: z.string().min(1).max(8192),
  state: z.string().min(1).max(4096),
});

const idParam = z.object({ id: z.uuid() });

/** アカウントに付けられる色の名前。画面側 (apps/web の account-colors.ts) と揃える。 */
const ACCOUNT_COLOR_NAMES = [
  "sky",
  "violet",
  "emerald",
  "amber",
  "rose",
  "teal",
  "orange",
  "slate",
] as const;

const updateAccountBody = z
  .object({
    /** 署名 (書式付き)。null か空なら署名なしにする。 */
    signatureHtml: z.string().max(50_000).nullable().optional(),
    /** 画面に出す名前。null か空ならメールアドレスを出す。 */
    displayName: z.string().max(200).nullable().optional(),
    /** 画面でアカウントを見分ける色。null なら並び順から決める。 */
    color: z.enum(ACCOUNT_COLOR_NAMES).nullable().optional(),
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
  username: mailAccounts.username,
  status: mailAccounts.status,
  lastError: mailAccounts.lastError,
  signatureHtml: mailAccounts.signatureHtml,
  sortOrder: mailAccounts.sortOrder,
  color: mailAccounts.color,
  createdAt: mailAccounts.createdAt,
};

export function accountRoutes({
  db,
  encryptionKey,
  allowPrivateMailHosts,
  microsoft,
  google,
}: RouteDeps) {
  const app = new Hono<AppEnv>();

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
    });
    if (!verified.ok) {
      return c.json({ error: verified.reason, detail: verified.detail }, 422);
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
      const { accountId } = c.req.valid("json");
      const user = c.var.user;
      let loginHint: string | undefined;
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
      return c.json({ url });
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
        state: body.state,
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
        console.error("Microsoft のログインを完了できませんでした。", detail);
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
                displayName: profile.displayName,
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
      const { accountId } = c.req.valid("json");
      const user = c.var.user;
      let loginHint: string | undefined;
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
      return c.json({ url });
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
        state: body.state,
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
        console.error("Google のログインを完了できませんでした。", detail);
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
          })
          .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, user.id)))
          .returning(publicColumns);
        if (!row) return null;
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
