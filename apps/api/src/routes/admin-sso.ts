import { zValidator } from "@hono/zod-validator";
import {
  discoverSsoEndpoints,
  isUsableSsoUrl,
  ssoUrlPointsInside,
} from "@orbit/core";
import { authAccounts, type Database, ssoProviders } from "@orbit/db";
import { asc, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  encryptSsoSecret,
  type SsoClientResolver,
  type SsoProviderRow,
  ssoAccountProviderId,
  ssoRedirectUri,
} from "../lib/sso-providers.js";
import type { AdminEnv } from "./admin.js";

/** 登録できる IdP の数の上限。 */
const MAX_PROVIDERS = 20;

const idParam = z.object({ id: z.uuid() });

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための正規表現
const noControl = /^[^\u0000-\u001f\u007f]*$/;
/** プロフィールの項目名。"a.b" で入れ子の項目。 */
const claim = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/);
const url = z.string().trim().max(2000);

const providerFields = {
  name: z.string().trim().min(1).max(60).regex(noControl),
  clientId: z.string().trim().min(1).max(500).regex(noControl),
  discoveryUrl: url.nullable().default(null),
  authorizationUrl: url.nullable().default(null),
  tokenUrl: url.nullable().default(null),
  userInfoUrl: url.nullable().default(null),
  scopes: z.string().trim().max(500).regex(noControl).default(""),
  subjectClaim: claim.default("sub"),
  emailClaim: claim.default("email"),
  nameClaim: claim.default("name"),
  tokenAuthMethod: z
    .enum(["client_secret_basic", "client_secret_post"])
    .default("client_secret_basic"),
  usePkce: z.boolean().default(true),
  allowSignUp: z.boolean().default(false),
  allowedDomains: z.array(domain).max(50).default([]),
  trustEmail: z.boolean().default(false),
  skipTwoFactor: z.boolean().default(false),
  suggestMailAccount: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

const createBody = z.object({
  ...providerFields,
  clientSecret: z.string().min(1).max(2000),
});

const updateBody = z.object({
  ...providerFields,
  /** 空なら、保存してあるシークレットを使い続ける。 */
  clientSecret: z.string().max(2000).default(""),
});

type Input = z.infer<typeof updateBody>;

type Deps = {
  db: Database;
  encryptionKey: Buffer;
  webOrigin: string;
  allowHttp: boolean;
  clients: SsoClientResolver;
};

/** 画面に返す IdP の設定。シークレットは返さない。 */
function publicOf(row: SsoProviderRow, linkedUsers: number) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    discoveryUrl: row.discoveryUrl,
    authorizationUrl: row.authorizationUrl,
    tokenUrl: row.tokenUrl,
    userInfoUrl: row.userInfoUrl,
    scopes: row.scopes,
    subjectClaim: row.subjectClaim,
    emailClaim: row.emailClaim,
    nameClaim: row.nameClaim,
    tokenAuthMethod: row.tokenAuthMethod,
    usePkce: row.usePkce,
    allowSignUp: row.allowSignUp,
    allowedDomains: row.allowedDomains,
    trustEmail: row.trustEmail,
    skipTwoFactor: row.skipTwoFactor,
    suggestMailAccount: row.suggestMailAccount,
    enabled: row.enabled,
    linkedUsers,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 入力の URL を確かめ、保存する URL の組を決める。OpenID Connect の設定の URL があれば
 * 実際に読んで確かめる (読めなければ保存しない)。
 */
async function checkEndpoints(
  input: Input,
  allowHttp: boolean,
): Promise<
  | {
      ok: true;
      discoveryUrl: string | null;
      authorizationUrl: string | null;
      tokenUrl: string | null;
      userInfoUrl: string | null;
    }
  | { ok: false; error: string; detail?: string }
> {
  const usable = (value: string | null) =>
    !!value && isUsableSsoUrl(value, { allowHttp });
  /** サーバーの内部ネットワークを指す URL があるか (SSRF 対策)。 */
  const inside = async (...values: string[]) =>
    (
      await Promise.all(
        values.map((value) => ssoUrlPointsInside(value, { allowHttp })),
      )
    ).some(Boolean);
  const discoveryUrl = input.discoveryUrl || null;
  if (discoveryUrl) {
    if (!usable(discoveryUrl)) return { ok: false, error: "invalid_url" };
    if (await inside(discoveryUrl)) return { ok: false, error: "private_url" };
    try {
      const found = await discoverSsoEndpoints(discoveryUrl, { allowHttp });
      if (await inside(found.tokenUrl, found.userInfoUrl)) {
        return { ok: false, error: "private_url" };
      }
    } catch (error) {
      return {
        ok: false,
        error: "discovery_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ok: true,
      discoveryUrl,
      authorizationUrl: null,
      tokenUrl: null,
      userInfoUrl: null,
    };
  }
  const { authorizationUrl, tokenUrl, userInfoUrl } = input;
  if (!authorizationUrl || !tokenUrl || !userInfoUrl) {
    return { ok: false, error: "endpoints_required" };
  }
  if (!usable(authorizationUrl) || !usable(tokenUrl) || !usable(userInfoUrl)) {
    return { ok: false, error: "invalid_url" };
  }
  // 認可 URL は利用者のブラウザーが開くだけなので、調べない。
  if (await inside(tokenUrl, userInfoUrl)) {
    return { ok: false, error: "private_url" };
  }
  return {
    ok: true,
    discoveryUrl: null,
    authorizationUrl,
    tokenUrl,
    userInfoUrl,
  };
}

/**
 * 結び付けた IdP のアカウントを、同じ人として扱い続けられるか決める値。ID の項目名と、
 * プロフィールを読む先 (OpenID Connect の設定か UserInfo の URL) のオリジン。
 */
function identityOf(row: {
  subjectClaim: string;
  discoveryUrl: string | null;
  userInfoUrl: string | null;
}): string {
  const url = row.discoveryUrl ?? row.userInfoUrl ?? "";
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // 保存してある URL は確かめ済みなので、ここには来ない。
  }
  return `${row.subjectClaim}\n${origin}`;
}

function valuesOf(input: Input) {
  return {
    name: input.name,
    clientId: input.clientId,
    scopes: input.scopes.split(/\s+/).filter(Boolean).join(" "),
    subjectClaim: input.subjectClaim,
    emailClaim: input.emailClaim,
    nameClaim: input.nameClaim,
    tokenAuthMethod: input.tokenAuthMethod,
    usePkce: input.usePkce,
    allowSignUp: input.allowSignUp,
    allowedDomains: [...new Set(input.allowedDomains)],
    trustEmail: input.trustEmail,
    skipTwoFactor: input.skipTwoFactor,
    suggestMailAccount: input.suggestMailAccount,
    enabled: input.enabled,
  };
}

/**
 * 管理画面の「シングルサインオン」。/v1/admin/sso の下に置き、管理者のログインは
 * 呼び出し元 (routes/admin.ts の requireAdmin) が確かめる。
 */
export function adminSsoRoutes({
  db,
  encryptionKey,
  webOrigin,
  allowHttp,
  clients,
}: Deps) {
  const app = new Hono<AdminEnv>();

  async function linkedCounts(): Promise<Map<string, number>> {
    const rows = await db
      .select({ providerId: authAccounts.providerId, total: count() })
      .from(authAccounts)
      .where(sql`${authAccounts.providerId} like 'sso:%'`)
      .groupBy(authAccounts.providerId);
    return new Map(rows.map((row) => [row.providerId, row.total]));
  }

  app.get("/", async (c) => {
    const rows = await db
      .select()
      .from(ssoProviders)
      .orderBy(asc(ssoProviders.createdAt), asc(ssoProviders.id));
    const counts = await linkedCounts();
    return c.json({
      redirectUri: ssoRedirectUri(webOrigin),
      providers: rows.map((row) =>
        publicOf(row, counts.get(ssoAccountProviderId(row.id)) ?? 0),
      ),
    });
  });

  app.post("/", zValidator("json", createBody), async (c) => {
    const input = c.req.valid("json");
    const [total] = await db.select({ value: count() }).from(ssoProviders);
    if ((total?.value ?? 0) >= MAX_PROVIDERS) {
      return c.json({ error: "too_many" }, 409);
    }
    const endpoints = await checkEndpoints(input, allowHttp);
    if (!endpoints.ok) {
      return c.json({ error: endpoints.error, detail: endpoints.detail }, 400);
    }
    const { ok: _, ...urls } = endpoints;
    const [row] = await db
      .insert(ssoProviders)
      .values({
        ...valuesOf(input),
        ...urls,
        clientSecretEncrypted: encryptSsoSecret(
          input.clientSecret,
          encryptionKey,
        ),
      })
      .returning();
    if (!row) throw new Error("IdP を保存できませんでした");
    return c.json({ provider: publicOf(row, 0) }, 201);
  });

  app.put(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", updateBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const [current] = await db
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.id, id));
      if (!current) return c.json({ error: "not_found" }, 404);
      const endpoints = await checkEndpoints(input, allowHttp);
      if (!endpoints.ok) {
        return c.json(
          { error: endpoints.error, detail: endpoints.detail },
          400,
        );
      }
      const { ok: _, ...urls } = endpoints;
      // 別の IdP に付け替えたり、ID の項目を変えたりすると、同じ ID が別の人を指しうる。
      // そのときは結び付けを解いて、次のログインで結び付け直す。
      const unlink =
        identityOf(current) !==
        identityOf({ subjectClaim: input.subjectClaim, ...urls });
      if (unlink) {
        await db
          .delete(authAccounts)
          .where(eq(authAccounts.providerId, ssoAccountProviderId(id)));
      }
      const [row] = await db
        .update(ssoProviders)
        .set({
          ...valuesOf(input),
          ...urls,
          ...(input.clientSecret
            ? {
                clientSecretEncrypted: encryptSsoSecret(
                  input.clientSecret,
                  encryptionKey,
                ),
              }
            : {}),
        })
        .where(eq(ssoProviders.id, id))
        .returning();
      if (!row) return c.json({ error: "not_found" }, 404);
      clients.forget(current.discoveryUrl);
      const counts = await linkedCounts();
      return c.json({
        provider: publicOf(row, counts.get(ssoAccountProviderId(id)) ?? 0),
        unlinked: unlink,
      });
    },
  );

  /**
   * IdP を削除する。結び付けたアカウントも消すので、この IdP でしかログインできない利用者は
   * ログインできなくなる (画面で確かめてから呼ぶ)。
   */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const deleted = await db.transaction(async (tx) => {
      await tx
        .delete(authAccounts)
        .where(eq(authAccounts.providerId, ssoAccountProviderId(id)));
      return tx
        .delete(ssoProviders)
        .where(eq(ssoProviders.id, id))
        .returning({ discoveryUrl: ssoProviders.discoveryUrl });
    });
    const [row] = deleted;
    if (!row) return c.json({ error: "not_found" }, 404);
    clients.forget(row.discoveryUrl);
    return c.body(null, 204);
  });

  return app;
}
