import {
  buildSsoAuthorizeUrl,
  createPkce,
  exchangeSsoCode,
  fetchSsoProfile,
  SSO_STATE_TTL_MS,
  SsoError,
  type SsoProfile,
  type SsoState,
  sealSsoState,
  ssoBindingHash,
} from "@orbit/core";
import { z } from "zod";
import type { SsoClientResolver, SsoProviderRow } from "./sso-providers.js";

/**
 * IdP の認可コードフローの前半 (ログイン画面の URL を作る) と後半 (コードからプロフィールを読む)。
 * ログイン (routes/sso.ts) と、設定画面からの結び付け (routes/security-sso.ts) で共通。
 */

/** アプリから始めたときに state に付ける目印 (routes/accounts.ts、Web の lib/native/oauth.ts と同じ)。 */
export const APP_STATE_PREFIX = "app~";

/** 端末が預かる合言葉。32 バイト以上の乱数を base64url で。 */
export const ssoBinding = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);

export function stripAppPrefix(state: string): string {
  return state.startsWith(APP_STATE_PREFIX)
    ? state.slice(APP_STATE_PREFIX.length)
    : state;
}

/** IdP のログイン画面の URL を作る。IdP の設定を読めなければ null。 */
export async function ssoAuthorizeUrl(options: {
  provider: SsoProviderRow;
  clients: SsoClientResolver;
  encryptionKey: Buffer;
  redirectUri: string;
  binding: string;
  app: boolean;
  mode: SsoState["mode"];
  userId?: string;
}): Promise<string | null> {
  const { provider } = options;
  let client: Awaited<ReturnType<SsoClientResolver["resolve"]>>;
  try {
    client = await options.clients.resolve(provider);
  } catch (error) {
    console.error(
      `IdP (${provider.name}) の設定を読めませんでした:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const pkce = provider.usePkce ? createPkce() : null;
  const state = sealSsoState(
    {
      provider: provider.id,
      verifier: pkce?.verifier ?? null,
      binding: ssoBindingHash(options.binding),
      mode: options.mode,
      ...(options.userId ? { userId: options.userId } : {}),
      expiresAt: Date.now() + SSO_STATE_TTL_MS,
    },
    options.encryptionKey,
  );
  return buildSsoAuthorizeUrl({
    client,
    redirectUri: options.redirectUri,
    state: options.app ? `${APP_STATE_PREFIX}${state}` : state,
    challenge: pkce?.challenge ?? null,
  });
}

/** 認可コードをアクセストークンに換え、プロフィールを読む。 */
export async function ssoProfileFromCode(options: {
  provider: SsoProviderRow;
  clients: SsoClientResolver;
  redirectUri: string;
  code: string;
  verifier: string | null;
}): Promise<
  | { ok: true; profile: SsoProfile }
  | { ok: false; error: "sso_failed" | "profile_invalid" }
> {
  const { provider } = options;
  try {
    const client = await options.clients.resolve(provider);
    const { accessToken } = await exchangeSsoCode({
      client,
      code: options.code,
      redirectUri: options.redirectUri,
      verifier: options.verifier,
    });
    return {
      ok: true,
      profile: await fetchSsoProfile({ client, accessToken }),
    };
  } catch (error) {
    console.error(
      `IdP (${provider.name}) でのログインに失敗しました:`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      error:
        error instanceof SsoError && error.code === "no_subject"
          ? "profile_invalid"
          : "sso_failed",
    };
  }
}
