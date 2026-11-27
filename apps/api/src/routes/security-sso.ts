import { zValidator } from "@hono/zod-validator";
import { openSsoState } from "@orbit/core";
import { authAccounts, type Database, passkeys, ssoProviders } from "@orbit/db";
import { and, asc, count, eq, like, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { type AppEnv, withoutCookies } from "../context.js";
import { passwordLoginEnabled } from "../lib/login-policy.js";
import { clientAddress, createRateWindow } from "../lib/rate-window.js";
import {
  ssoAuthorizeUrl,
  ssoProfileFromCode,
  stripAppPrefix,
} from "../lib/sso-flow.js";
import {
  findEnabledSsoProvider,
  type SsoClientResolver,
  ssoAccountProviderId,
  ssoRedirectUri,
} from "../lib/sso-providers.js";
import { ssoCallbackBody, ssoStartBody } from "./sso.js";

/**
 * Better Auth の「最近ログインしたセッション」(freshAge の既定値) と同じ長さ。
 * ログインの方法を足すのは、パスキーの登録やパスワードの設定と同じく、最近ログインした端末だけ。
 */
const FRESH_SESSION_MS = 24 * 60 * 60_000;

const PREFIX = "sso:";

type Deps = {
  db: Database;
  auth: Auth;
  encryptionKey: Buffer;
  webOrigin: string;
  clients: SsoClientResolver;
};

const providerParam = z.object({ providerId: z.uuid() });

/**
 * 設定画面の「ログインとセキュリティ」から、IdP (SSO) のアカウントを結び付け・解除する。
 * /v1/security/sso の下に置き、ログインは呼び出し元 (requireUser) が確かめる。
 *
 *   画面 → link (IdP のログイン画面の URL) → IdP → Web の /oauth/sso → link/callback
 *
 * state には結び付けを始めた利用者を入れ、戻ってきたときにログイン中の利用者と照合する
 * (ほかの人のセッションで、自分の IdP のアカウントを結び付けさせる攻撃を防ぐ)。
 */
export function securitySsoRoutes({
  db,
  auth,
  encryptionKey,
  webOrigin,
  clients,
}: Deps) {
  const app = new Hono<AppEnv>();
  const redirectUri = ssoRedirectUri(webOrigin);
  const linkLimit = createRateWindow({ limit: 20, windowMs: 60_000 });

  const sessionIsFresh = (headers: Headers) => isFreshSession(auth, headers);

  /** 使える IdP と、この利用者が結び付けたもの。 */
  app.get("/", async (c) => {
    const userId = c.var.user.id;
    const [providers, links, credential] = await Promise.all([
      db
        .select({
          id: ssoProviders.id,
          name: ssoProviders.name,
          enabled: ssoProviders.enabled,
        })
        .from(ssoProviders)
        .orderBy(asc(ssoProviders.createdAt), asc(ssoProviders.id)),
      db
        .select({
          providerId: authAccounts.providerId,
          createdAt: authAccounts.createdAt,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, userId),
            like(authAccounts.providerId, `${PREFIX}%`),
          ),
        ),
      hasPassword(db, userId),
    ]);
    const passwordLogin = await passwordLoginEnabled(db);
    const linked = new Map(
      links.map((link) => [link.providerId.slice(PREFIX.length), link]),
    );
    return c.json({
      hasPassword: credential,
      /** パスワードでログインできるサーバーか (管理者が止めていれば false)。 */
      passwordLogin,
      providers: providers
        // 無効な IdP は、結び付けたものだけ (解除できるように) 出す。
        .filter((provider) => provider.enabled || linked.has(provider.id))
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          linkedAt: linked.get(provider.id)?.createdAt ?? null,
        })),
    });
  });

  /** 結び付けを始める (IdP のログイン画面の URL を返す)。 */
  app.post("/link", zValidator("json", ssoStartBody), async (c) => {
    if (!linkLimit.take(clientAddress(c.req.raw.headers))) {
      return c.json({ error: "too_many_requests" }, 429);
    }
    if (!(await sessionIsFresh(c.req.raw.headers))) {
      return c.json({ error: "SESSION_NOT_FRESH" }, 403);
    }
    const body = c.req.valid("json");
    const provider = await findEnabledSsoProvider(db, body.providerId);
    if (!provider) return c.json({ error: "provider_unavailable" }, 404);
    const url = await ssoAuthorizeUrl({
      provider,
      clients,
      encryptionKey,
      redirectUri,
      binding: body.binding,
      app: body.app,
      mode: "link",
      userId: c.var.user.id,
    });
    if (!url) return c.json({ error: "provider_unreachable" }, 502);
    return c.json({ url });
  });

  /** IdP から戻ってきた code で、ログイン中の利用者に結び付ける。 */
  app.post("/link/callback", zValidator("json", ssoCallbackBody), async (c) => {
    if (!linkLimit.take(clientAddress(c.req.raw.headers))) {
      return c.json({ error: "too_many_requests" }, 429);
    }
    const body = c.req.valid("json");
    const userId = c.var.user.id;
    const state = openSsoState(
      stripAppPrefix(body.state),
      body.binding,
      encryptionKey,
    );
    if (!state || state.mode !== "link" || state.userId !== userId) {
      return c.json({ error: "invalid_state" }, 400);
    }
    const provider = await findEnabledSsoProvider(db, state.provider);
    if (!provider) return c.json({ error: "provider_unavailable" }, 404);
    const fetched = await ssoProfileFromCode({
      provider,
      clients,
      redirectUri,
      code: body.code,
      verifier: state.verifier,
    });
    if (!fetched.ok) return c.json({ error: fetched.error }, 502);
    const { subject } = fetched.profile;
    const providerKey = ssoAccountProviderId(provider.id);

    const result = await db.transaction(async (tx) => {
      // 同じ利用者の結び付け・解除を同時に走らせない。
      await tx.execute(
        sql`select 1 from users where id = ${userId} for update`,
      );
      const [owner] = await tx
        .select({ userId: authAccounts.userId })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, providerKey),
            eq(authAccounts.accountId, subject),
          ),
        );
      if (owner) {
        return owner.userId === userId ? "linked" : "linked_to_other";
      }
      // 1 つの IdP につき、結び付けられるのは 1 つのアカウントだけ (付け替えは解除してから)。
      const [mine] = await tx
        .select({ accountId: authAccounts.accountId })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, providerKey),
            eq(authAccounts.userId, userId),
          ),
        );
      if (mine) return "already_linked";
      const inserted = await tx
        .insert(authAccounts)
        .values({ userId, providerId: providerKey, accountId: subject })
        .onConflictDoNothing({
          target: [authAccounts.providerId, authAccounts.accountId],
        })
        .returning({ id: authAccounts.id });
      return inserted.length > 0 ? "linked" : "linked_to_other";
    });
    if (result !== "linked") return c.json({ error: result }, 409);
    return c.json({ provider: { id: provider.id, name: provider.name } });
  });

  /** 結び付けを解く。ほかにログインの方法が残らなければ断る。 */
  app.delete("/:providerId", zValidator("param", providerParam), async (c) => {
    if (!(await sessionIsFresh(c.req.raw.headers))) {
      return c.json({ error: "SESSION_NOT_FRESH" }, 403);
    }
    const { providerId } = c.req.valid("param");
    const userId = c.var.user.id;
    const providerKey = ssoAccountProviderId(providerId);
    const deleted = await db.transaction(async (tx) => {
      // 同じ利用者の解除を同時に送られても、ログインの方法が 1 つも残らない状態にしない。
      await tx.execute(
        sql`select 1 from users where id = ${userId} for update`,
      );
      const [password, passwordAllowed, otherLinks, passkeyRow] =
        await Promise.all([
          hasPassword(tx, userId),
          // パスワードでのログインが止められていれば、パスワードは残る方法に数えない。
          passwordLoginEnabled(tx),
          tx
            .select({ value: count() })
            .from(authAccounts)
            // sso:<id> の id で、有効な IdP だけを数える。
            .innerJoin(ssoProviders, eq(authAccounts.providerId, sqlSsoKey()))
            .where(
              and(
                eq(authAccounts.userId, userId),
                ne(authAccounts.providerId, providerKey),
                eq(ssoProviders.enabled, true),
              ),
            ),
          tx
            .select({ value: count() })
            .from(passkeys)
            .where(eq(passkeys.userId, userId)),
        ]);
      const remaining =
        (password && passwordAllowed) ||
        (otherLinks[0]?.value ?? 0) > 0 ||
        (passkeyRow[0]?.value ?? 0) > 0;
      if (!remaining) return null;
      return tx
        .delete(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, userId),
            eq(authAccounts.providerId, providerKey),
          ),
        )
        .returning({ id: authAccounts.id });
    });
    if (deleted === null) return c.json({ error: "last_login_method" }, 409);
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

/**
 * 最近ログインしたセッションか。ログインの方法を足したり外したりするのは、
 * パスキーの登録と同じく、最近ログインした端末だけにする (漏れた古いトークンで変えられないように)。
 */
export async function isFreshSession(
  auth: Auth,
  headers: Headers,
): Promise<boolean> {
  const session = await auth.api.getSession({
    headers: withoutCookies(headers),
  });
  if (!session) return false;
  return (
    Date.now() - new Date(session.session.createdAt).getTime() <=
    FRESH_SESSION_MS
  );
}

/** auth_accounts.provider_id と比べる "sso:" || sso_providers.id。 */
function sqlSsoKey() {
  return sql`${PREFIX} || ${ssoProviders.id}::text`;
}

/** パスワードでログインできるか (Better Auth の credential のアカウントにパスワードがある)。 */
export async function hasPassword(
  db: Pick<Database, "select">,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ password: authAccounts.password })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, userId),
        eq(authAccounts.providerId, "credential"),
      ),
    );
  return !!row?.password;
}
