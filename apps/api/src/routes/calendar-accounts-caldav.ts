import { zValidator } from "@hono/zod-validator";
import {
  CaldavAuthError,
  CaldavClient,
  CaldavHostError,
  CaldavHttpError,
  CaldavXmlError,
  CHANNEL_ACCOUNTS,
  decryptCredentials,
  encryptCredentials,
  ICLOUD_CALDAV_URL,
} from "@orbit/core";
import { accounts } from "@orbit/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { recordChanges } from "../lib/changes.js";

/**
 * CalDAV のアカウント (iCloud、一般の CalDAV サーバー) の追加と設定。ログインが要る。
 * /v1/accounts/caldav にマウントされる (/v1/accounts の /:id より先に登録する)。
 *
 * - POST /         カレンダーだけのアカウントを追加する。接続を確かめてから行を作る
 *                  (mailEnabled=false、calendarEnabled=true、caldavUrl に起点の URL)。
 *                  iCloud で、同じ Apple ID のメールのアカウントが既にあれば、保存済みのパスワードで
 *                  CalDAV に入れるかを確かめ、入れればそのアカウントのカレンダーをオンにする。
 * - POST /:id/enable  既存の iCloud のメールのアカウントで、カレンダーをオンにする
 *                  (保存済みのアプリ用パスワードで CalDAV に入れるかを確かめてから)。
 */

const caldavAccountBody = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("icloud"),
    /** Apple ID (メールアドレス)。 */
    appleId: z.email().max(320),
    /** アプリ用パスワード。 */
    password: z.string().min(1).max(1024),
    displayName: z.string().trim().max(200).optional(),
  }),
  z.object({
    provider: z.literal("generic"),
    /** サーバーの URL。https:// は省略できる。 */
    url: z.string().trim().min(1).max(2000),
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
    /** 画面に出すアドレス。省けば、ユーザー名 (アドレスの形なら) か「ユーザー名@ホスト」。 */
    email: z.email().max(320).optional(),
    displayName: z.string().trim().max(200).optional(),
  }),
]);

const idParam = z.object({ id: z.uuid() });

type Failure =
  | "auth_failed"
  | "host_not_allowed"
  | "host_not_found"
  | "invalid_url"
  | "not_caldav"
  | "connection_failed";

const FAILURE_MESSAGES: Record<Failure, string> = {
  auth_failed:
    "ログインできませんでした。ユーザー名とパスワード (iCloud はアプリ用パスワード) を確かめてください。",
  host_not_allowed: "このサーバーには接続できません。",
  host_not_found: "サーバーが見つかりませんでした。URL を確かめてください。",
  invalid_url: "URL が正しくありません。",
  not_caldav:
    "CalDAV のカレンダーが見つかりませんでした。URL を確かめてください。",
  connection_failed: "サーバーに接続できませんでした。",
};

/** クライアントへ返す形 (accounts.ts の publicAccount と同じ項目)。認証情報は返さない。 */
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

/** パスワードの CalDAV のアカウントには、OAuth の同意の仕組みが無い。 */
function publicAccount<T extends object>(row: T) {
  return { ...row, calendarConsent: "not_applicable" as const };
}

/** テストで差し替えるもの。 */
export type CaldavAccountRouteOverrides = {
  fetchImpl?: typeof fetch;
  isPrivateHost?: (host: string) => Promise<boolean>;
};

/** 入力された URL を http(s) の URL にする。使えなければ null。 */
export function normalizeCaldavUrl(
  input: string,
  allowHttp: boolean,
): string | null {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // パスワードを平文で送らないよう、http は開発用 (内部への接続を許すとき) だけにする。
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return null;
  }
  if (url.username || url.password) return null;
  url.hash = "";
  return url.toString();
}

export function caldavAccountRoutes(
  {
    db,
    encryptionKey,
    allowPrivateMailHosts,
  }: Pick<RouteDeps, "db" | "encryptionKey" | "allowPrivateMailHosts">,
  overrides: CaldavAccountRouteOverrides = {},
) {
  const app = new Hono<AppEnv>();

  /** CalDAV サーバーにログインでき、カレンダーのホーム (またはカレンダー) が見つかるかを確かめる。 */
  async function verify(
    startUrl: string,
    username: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; reason: Failure }> {
    const client = new CaldavClient({
      username,
      password,
      allowPrivateHosts: allowPrivateMailHosts,
      ...(overrides.fetchImpl ? { fetchFn: overrides.fetchImpl } : {}),
      ...(overrides.isPrivateHost
        ? { isPrivateHost: overrides.isPrivateHost }
        : {}),
      signal: AbortSignal.timeout(30_000),
    });
    try {
      const found = await client.discover(startUrl);
      if (found.homeUrls[0]) await client.listCalendars(found.homeUrls[0]);
      return { ok: true };
    } catch (error) {
      if (error instanceof CaldavAuthError)
        return { ok: false, reason: "auth_failed" };
      if (error instanceof CaldavHostError)
        return { ok: false, reason: error.reason };
      if (error instanceof CaldavHttpError || error instanceof CaldavXmlError) {
        return { ok: false, reason: "not_caldav" };
      }
      return { ok: false, reason: "connection_failed" };
    }
  }

  function failure(reason: Failure) {
    return { error: reason, message: FAILURE_MESSAGES[reason] };
  }

  /** 既存のアカウントのカレンダーをオンにする (CalDAV の起点も書く)。 */
  async function enableCalendar(userId: string, id: string, startUrl: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(accounts)
        .set({
          calendarEnabled: true,
          calendarError: null,
          caldavUrl: startUrl,
        })
        .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
        .returning(publicColumns);
      if (!row) return null;
      await recordChanges(tx, userId, "account", [id]);
      // 同期ワーカーが、カレンダーの同期を始める。
      await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${id})`);
      return row;
    });
  }

  /** 保存済みのパスワードで、iCloud の CalDAV に入れるか。 */
  async function verifyStored(account: {
    userId: string;
    username: string;
    credentialsEncrypted: string;
  }) {
    const credentials = decryptCredentials(
      account.credentialsEncrypted,
      encryptionKey,
      account.userId,
    );
    if (credentials.type !== "password") {
      return { ok: false as const, reason: "auth_failed" as const };
    }
    return verify(ICLOUD_CALDAV_URL, account.username, credentials.password);
  }

  app.post("/", zValidator("json", caldavAccountBody), async (c) => {
    const input = c.req.valid("json");
    const user = c.var.user;

    let startUrl: string;
    let username: string;
    let email: string;
    if (input.provider === "icloud") {
      startUrl = ICLOUD_CALDAV_URL;
      username = input.appleId;
      email = input.appleId;
    } else {
      const normalized = normalizeCaldavUrl(input.url, allowPrivateMailHosts);
      if (!normalized) return c.json(failure("invalid_url"), 422);
      startUrl = normalized;
      username = input.username;
      email =
        input.email ??
        (username.includes("@")
          ? username
          : `${username}@${new URL(normalized).hostname}`);
    }

    // 同じアドレスとユーザー名の、カレンダーだけのアカウントが既にある。
    const [existing] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.email, email),
          isNull(accounts.imapHost),
          eq(accounts.username, username),
        ),
      );
    if (existing) {
      return c.json(
        { error: "account_exists", message: "このアカウントは追加済みです。" },
        409,
      );
    }

    if (input.provider === "icloud") {
      // 同じ Apple ID の iCloud のメールのアカウントがあれば、そのアカウントでカレンダーをオンにする。
      const mailAccounts = await db
        .select({
          id: accounts.id,
          userId: accounts.userId,
          username: accounts.username,
          credentialsEncrypted: accounts.credentialsEncrypted,
          calendarEnabled: accounts.calendarEnabled,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, user.id),
            eq(accounts.provider, "icloud"),
            sql`lower(${accounts.email}) = ${email.toLowerCase()}`,
          ),
        );
      for (const account of mailAccounts) {
        if (account.calendarEnabled) {
          return c.json(
            {
              error: "account_exists",
              message: "この Apple ID のカレンダーは追加済みです。",
            },
            409,
          );
        }
        if ((await verifyStored(account)).ok) {
          const row = await enableCalendar(user.id, account.id, startUrl);
          if (row) return c.json({ account: publicAccount(row), merged: true });
        }
      }
    }

    const verified = await verify(startUrl, username, input.password);
    if (!verified.ok) return c.json(failure(verified.reason), 422);

    const account = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({
          userId: user.id,
          email,
          displayName: input.displayName || null,
          provider: input.provider,
          authType: "password",
          protocol: "imap",
          imapHost: null,
          imapPort: null,
          smtpHost: null,
          smtpPort: null,
          username,
          mailEnabled: false,
          calendarEnabled: true,
          caldavUrl: startUrl,
          credentialsEncrypted: encryptCredentials(
            { type: "password", password: input.password },
            encryptionKey,
            user.id,
          ),
        })
        .onConflictDoNothing()
        .returning(publicColumns);
      if (!row) return null;
      await recordChanges(tx, user.id, "account", [row.id]);
      // コミット時に同期ワーカーへ届き、カレンダーの同期が始まる。
      await tx.execute(sql`select pg_notify(${CHANNEL_ACCOUNTS}, ${row.id})`);
      return row;
    });
    if (!account) {
      return c.json(
        { error: "account_exists", message: "このアカウントは追加済みです。" },
        409,
      );
    }
    return c.json({ account: publicAccount(account), merged: false }, 201);
  });

  app.post("/:id/enable", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const [account] = await db
      .select({
        id: accounts.id,
        userId: accounts.userId,
        provider: accounts.provider,
        authType: accounts.authType,
        username: accounts.username,
        credentialsEncrypted: accounts.credentialsEncrypted,
      })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.userId, user.id)));
    if (!account) return c.json({ error: "not_found" }, 404);
    if (account.provider !== "icloud" || account.authType !== "password") {
      return c.json(
        { error: "not_icloud", message: "iCloud のアカウントではありません。" },
        409,
      );
    }
    const verified = await verifyStored(account);
    if (!verified.ok) return c.json(failure(verified.reason), 422);
    const row = await enableCalendar(user.id, id, ICLOUD_CALDAV_URL);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ account: publicAccount(row) });
  });

  return app;
}
