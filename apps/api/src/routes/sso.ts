import { zValidator } from "@hono/zod-validator";
import {
  buildSsoAuthorizeUrl,
  createPkce,
  exchangeSsoCode,
  fetchSsoProfile,
  openSsoState,
  SSO_STATE_TTL_MS,
  SsoError,
  sealSsoState,
  ssoBindingHash,
} from "@orbit/core";
import type { Database } from "@orbit/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth.js";
import {
  AUTH_STATE_HEADER,
  authStateToCookie,
  withAuthStateHeader,
} from "../lib/auth-state.js";
import { clientAddress, createRateWindow } from "../lib/rate-window.js";
import {
  findEnabledSsoProvider,
  type SsoClientResolver,
  ssoRedirectUri,
} from "../lib/sso-providers.js";
import { resolveSsoUser } from "../lib/sso-users.js";

/** アプリから始めたログインの state に付ける目印 (routes/accounts.ts、Web の lib/native/oauth.ts と同じ)。 */
const APP_STATE_PREFIX = "app~";

/** 端末が預かる合言葉。32 バイト以上の乱数を base64url で。 */
const binding = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);

const startBody = z.object({
  providerId: z.uuid(),
  binding,
  /** アプリ (Desktop / Android) から始めた。戻り先の Web のページがアプリへ引き渡す。 */
  app: z.boolean().default(false),
});

const callbackBody = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(4096),
  binding,
});

type Deps = {
  db: Database;
  auth: Auth;
  encryptionKey: Buffer;
  webOrigin: string;
  clients: SsoClientResolver;
};

function stripAppPrefix(state: string): string {
  return state.startsWith(APP_STATE_PREFIX)
    ? state.slice(APP_STATE_PREFIX.length)
    : state;
}

/**
 * IdP (SSO) でのログイン。/v1/auth/sso の下に置く (画面は /v1/auth/* と同じく、
 * 2 段階認証の途中の値を X-Auth-State で受け渡す)。ログイン前に呼ぶので、ログインは要らない。
 *
 *   画面 → start (IdP のログイン画面の URL を受け取る) → IdP でログイン
 *        → Web の /oauth/sso?code=…&state=… → callback (Orbit のセッション)
 *
 * state は暗号化してサーバーに状態を持たない。ログインを始めた端末だけが知る合言葉 (binding) の
 * 指紋を state に入れ、戻ってきたときに照合する (ほかの人の code と state を踏ませて、
 * その人のアカウントでログインさせる攻撃を防ぐ)。
 */
export function ssoRoutes({
  db,
  auth,
  encryptionKey,
  webOrigin,
  clients,
}: Deps) {
  const app = new Hono();
  const redirectUri = ssoRedirectUri(webOrigin);
  // どちらも IdP への通信を起こすので、IP アドレスごとに回数を制限する。
  const startLimit = createRateWindow({ limit: 30, windowMs: 60_000 });
  const callbackLimit = createRateWindow({ limit: 30, windowMs: 60_000 });

  app.post("/start", zValidator("json", startBody), async (c) => {
    if (!startLimit.take(clientAddress(c.req.raw.headers))) {
      return c.json({ error: "too_many_requests" }, 429);
    }
    const body = c.req.valid("json");
    const provider = await findEnabledSsoProvider(db, body.providerId);
    if (!provider) return c.json({ error: "provider_unavailable" }, 404);
    let client: Awaited<ReturnType<SsoClientResolver["resolve"]>>;
    try {
      client = await clients.resolve(provider);
    } catch (error) {
      console.error(
        `IdP (${provider.name}) の設定を読めませんでした:`,
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: "provider_unreachable" }, 502);
    }
    const pkce = provider.usePkce ? createPkce() : null;
    const state = sealSsoState(
      {
        provider: provider.id,
        verifier: pkce?.verifier ?? null,
        binding: ssoBindingHash(body.binding),
        mode: "login",
        expiresAt: Date.now() + SSO_STATE_TTL_MS,
      },
      encryptionKey,
    );
    const url = buildSsoAuthorizeUrl({
      client,
      redirectUri,
      state: body.app ? `${APP_STATE_PREFIX}${state}` : state,
      challenge: pkce?.challenge ?? null,
    });
    return c.json({ url });
  });

  app.post("/callback", zValidator("json", callbackBody), async (c) => {
    if (!callbackLimit.take(clientAddress(c.req.raw.headers))) {
      return c.json({ error: "too_many_requests" }, 429);
    }
    const body = c.req.valid("json");
    const state = openSsoState(
      stripAppPrefix(body.state),
      body.binding,
      encryptionKey,
    );
    if (!state || state.mode !== "login") {
      return c.json({ error: "invalid_state" }, 400);
    }
    const provider = await findEnabledSsoProvider(db, state.provider);
    if (!provider) return c.json({ error: "provider_unavailable" }, 404);

    let profile: Awaited<ReturnType<typeof fetchSsoProfile>>;
    try {
      const client = await clients.resolve(provider);
      const { accessToken } = await exchangeSsoCode({
        client,
        code: body.code,
        redirectUri,
        verifier: state.verifier,
      });
      profile = await fetchSsoProfile({ client, accessToken });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `IdP (${provider.name}) でのログインに失敗しました:`,
        detail,
      );
      const code =
        error instanceof SsoError && error.code === "no_subject"
          ? "profile_invalid"
          : "sso_failed";
      return c.json({ error: code }, 502);
    }

    const result = await resolveSsoUser(db, provider, profile);
    if (!result.ok) return c.json({ error: result.error }, 403);
    if (result.created) {
      console.log(
        `IdP (${provider.name}) でのログインで、利用者を作りました: ${profile.email}`,
      );
    }

    // セッション (または 2 段階認証の途中の値) は Better Auth に作らせる。
    // 「この端末ではコードを省略する」の印だけを Cookie として渡す (既存のセッションは使わない)。
    const cookie = authStateToCookie(c.req.header(AUTH_STATE_HEADER) ?? null);
    const response = await auth.api.signInSso({
      body: { userId: result.userId, skipTwoFactor: provider.skipTwoFactor },
      headers: new Headers(cookie ? { cookie } : {}),
      asResponse: true,
    });
    if (!response.ok) {
      console.error(
        `IdP (${provider.name}) でのログインで、セッションを作れませんでした (HTTP ${response.status})`,
      );
      return c.json({ error: "sign_in_failed" }, 500);
    }
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");
    return withAuthStateHeader(
      new Response(
        JSON.stringify({
          twoFactorRedirect: data.twoFactorRedirect === true,
          created: result.created,
          // 自動で作った利用者に、メールアカウントの追加を案内する (IdP ごとの設定)。
          suggestMailAccount: result.created && provider.suggestMailAccount,
          email: profile.email,
        }),
        { status: response.status, headers },
      ),
    );
  });

  return app;
}
