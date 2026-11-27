import { zValidator } from "@hono/zod-validator";
import { openSsoState } from "@orbit/core";
import type { Database } from "@orbit/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth.js";
import {
  AUTH_STATE_HEADER,
  authStateToCookie,
  withAuthStateHeader,
} from "../lib/auth-state.js";
import { isUserDisabled } from "../lib/login-policy.js";
import { clientAddress, createRateWindow } from "../lib/rate-window.js";
import {
  ssoAuthorizeUrl,
  ssoBinding,
  ssoProfileFromCode,
  stripAppPrefix,
} from "../lib/sso-flow.js";
import {
  findEnabledSsoProvider,
  type SsoClientResolver,
  ssoRedirectUri,
} from "../lib/sso-providers.js";
import { resolveSsoUser } from "../lib/sso-users.js";

export const ssoStartBody = z.object({
  providerId: z.uuid(),
  binding: ssoBinding,
  /** アプリ (Desktop / Android) から始めた。戻り先の Web のページがアプリへ引き渡す。 */
  app: z.boolean().default(false),
});

export const ssoCallbackBody = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(4096),
  binding: ssoBinding,
});

type Deps = {
  db: Database;
  auth: Auth;
  encryptionKey: Buffer;
  webOrigin: string;
  clients: SsoClientResolver;
};

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

  app.post("/start", zValidator("json", ssoStartBody), async (c) => {
    if (!startLimit.take(clientAddress(c.req.raw.headers))) {
      return c.json({ error: "too_many_requests" }, 429);
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
      mode: "login",
    });
    if (!url) return c.json({ error: "provider_unreachable" }, 502);
    return c.json({ url });
  });

  app.post("/callback", zValidator("json", ssoCallbackBody), async (c) => {
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

    const fetched = await ssoProfileFromCode({
      provider,
      clients,
      redirectUri,
      code: body.code,
      verifier: state.verifier,
    });
    if (!fetched.ok) return c.json({ error: fetched.error }, 502);
    const { profile } = fetched;

    const result = await resolveSsoUser(db, provider, profile);
    if (!result.ok) return c.json({ error: result.error }, 403);
    if (result.created) {
      console.log(
        `IdP (${provider.name}) でのログインで、利用者を作りました: ${profile.email}`,
      );
    }

    // 管理者が無効にした利用者は、IdP で確認できてもログインさせない
    // (2 段階認証のコードを尋ねる前に断る)。
    if (await isUserDisabled(db, result.userId)) {
      return c.json({ error: "user_disabled" }, 403);
    }

    // セッション (または 2 段階認証の途中の値) は Better Auth に作らせる。
    // 「この端末ではコードを省略する」の印だけを Cookie として渡す (既存のセッションは使わない)。
    const cookie = authStateToCookie(c.req.header(AUTH_STATE_HEADER) ?? null);
    const response = await auth.api.signInSso({
      body: { userId: result.userId, skipTwoFactor: provider.skipTwoFactor },
      headers: new Headers(cookie ? { cookie } : {}),
      asResponse: true,
    });
    if (response.status === 403) {
      // 確かめた直後に無効にされた (セッションを作るときに断られた)。
      return c.json({ error: "user_disabled" }, 403);
    }
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
