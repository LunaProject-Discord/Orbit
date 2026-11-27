import {
  decryptText,
  discoverSsoEndpoints,
  encryptText,
  type SsoClient,
  type SsoEndpoints,
  ssoUrlPointsInside,
} from "@orbit/core";
import { type Database, ssoProviders } from "@orbit/db";
import { and, asc, eq } from "drizzle-orm";

/** sso_providers の 1 行。 */
export type SsoProviderRow = typeof ssoProviders.$inferSelect;

const SECRET_CONTEXT = "sso-client-secret";
/** OpenID Connect の設定を読み直すまでの時間。 */
const DISCOVERY_TTL_MS = 10 * 60_000;

/** auth_accounts.provider_id に入れる値。 */
export function ssoAccountProviderId(providerId: string): string {
  return `sso:${providerId}`;
}

/** IdP に登録するリダイレクト URI (Web の /oauth/sso)。 */
export function ssoRedirectUri(webOrigin: string): string {
  return `${webOrigin}/oauth/sso`;
}

export function encryptSsoSecret(secret: string, key: Buffer): string {
  return encryptText(secret, key, SECRET_CONTEXT);
}

export function decryptSsoSecret(encrypted: string, key: Buffer): string {
  return decryptText(encrypted, key, SECRET_CONTEXT);
}

/** ログイン画面に出す IdP (有効なものだけ、作った順)。 */
export async function listEnabledSsoProviders(
  db: Database,
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: ssoProviders.id, name: ssoProviders.name })
    .from(ssoProviders)
    .where(eq(ssoProviders.enabled, true))
    .orderBy(asc(ssoProviders.createdAt), asc(ssoProviders.id));
}

/** 有効な IdP を 1 つ読む。無いか無効なら null。 */
export async function findEnabledSsoProvider(
  db: Database,
  id: string,
): Promise<SsoProviderRow | null> {
  const [row] = await db
    .select()
    .from(ssoProviders)
    .where(and(eq(ssoProviders.id, id), eq(ssoProviders.enabled, true)));
  return row ?? null;
}

/** 読めなかったことを覚えておく時間 (読めない IdP へ、ログインのたびに繋ぎに行かない)。 */
const DISCOVERY_FAILURE_TTL_MS = 30_000;

type DiscoveryEntry =
  | { endpoints: SsoEndpoints; expiresAt: number }
  | { error: Error; expiresAt: number };

/**
 * IdP の設定 (行) から、通信に使う設定を作る。OpenID Connect の設定の URL があれば、
 * そこから 3 つの URL を読む (しばらく覚えておく)。
 */
export function createSsoClientResolver(options: {
  encryptionKey: Buffer;
  allowHttp: boolean;
  fetchFn?: typeof fetch;
}) {
  const cache = new Map<string, DiscoveryEntry>();

  /**
   * サーバーから通信する URL が、内部ネットワークを指していないか確かめる (SSRF 対策)。
   * 保存したときに確かめていても、名前の向き先や IdP の設定はあとから変わりうる。
   */
  async function assertOutside(...urls: string[]) {
    for (const url of urls) {
      if (await ssoUrlPointsInside(url, { allowHttp: options.allowHttp })) {
        throw new Error(
          `IdP の URL がサーバーの内部ネットワークを指しています: ${url}`,
        );
      }
    }
  }

  async function endpointsOf(row: SsoProviderRow): Promise<SsoEndpoints> {
    const endpoints = await loadEndpoints(row);
    await assertOutside(endpoints.tokenUrl, endpoints.userInfoUrl);
    return endpoints;
  }

  async function loadEndpoints(row: SsoProviderRow): Promise<SsoEndpoints> {
    if (!row.discoveryUrl) {
      if (!row.authorizationUrl || !row.tokenUrl || !row.userInfoUrl) {
        throw new Error("IdP の URL が設定されていません");
      }
      return {
        authorizationUrl: row.authorizationUrl,
        tokenUrl: row.tokenUrl,
        userInfoUrl: row.userInfoUrl,
      };
    }
    const cached = cache.get(row.discoveryUrl);
    if (cached && cached.expiresAt > Date.now()) {
      if ("error" in cached) throw cached.error;
      return cached.endpoints;
    }
    let endpoints: SsoEndpoints;
    try {
      await assertOutside(row.discoveryUrl);
      endpoints = await discoverSsoEndpoints(row.discoveryUrl, {
        allowHttp: options.allowHttp,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      });
    } catch (error) {
      cache.set(row.discoveryUrl, {
        error: error instanceof Error ? error : new Error(String(error)),
        expiresAt: Date.now() + DISCOVERY_FAILURE_TTL_MS,
      });
      throw error;
    }
    cache.set(row.discoveryUrl, {
      endpoints,
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
    });
    return endpoints;
  }

  return {
    async resolve(row: SsoProviderRow): Promise<SsoClient> {
      return {
        clientId: row.clientId,
        clientSecret: decryptSsoSecret(
          row.clientSecretEncrypted,
          options.encryptionKey,
        ),
        scopes: row.scopes.split(/\s+/).filter(Boolean),
        tokenAuthMethod: row.tokenAuthMethod,
        usePkce: row.usePkce,
        subjectClaim: row.subjectClaim,
        emailClaim: row.emailClaim,
        nameClaim: row.nameClaim,
        endpoints: await endpointsOf(row),
      };
    },
    /** 設定を変えたときに、覚えておいた URL を捨てる。 */
    forget(discoveryUrl: string | null) {
      if (discoveryUrl) cache.delete(discoveryUrl);
    },
  };
}

export type SsoClientResolver = ReturnType<typeof createSsoClientResolver>;
